"""Provider adapters for the agent loop (agent.py): the loop speaks one neutral step contract and each
adapter turns it into its provider's requests and replies (spec "Neutral reply and stops", plan Task 2/3).

The contract (what agent.py relies on; GeminiAdapter, plan Task 3, implements the same):

    adapter = adapters.for_entry(entry)        # one per run, from the run's catalog entry
    client = adapter.make_client()            # once per run (reads the key / ADC); may raise
                                              # secrets.MissingKeyError or LLMError
    adapter.add_user_text(text)               # the first instruction, "Approved: …"
    adapter.add_tool_results([ToolResult…])   # one per tool call of the last reply, in call order
    step = adapter.step(system, tools, client=client, input_tokens=n, max_requests=k, envato=False)
    adapter.history                           # the provider-shaped conversation (read-only for the loop)

- `tools` are written once as JSON Schema ({name, description, input_schema}); each adapter converts them.
- `step()` gates on `input_tokens` (the loop's estimate) plus the entry's max output, calls the model,
  records spend under the catalog id of the model that answered (inside the caller's spend.meter), and
  returns a `Step`. When the reply is usable (stop `end` or `tool_use`) the adapter has ALREADY appended
  the model's turn to its history, whole and unchanged (Claude: content blocks incl. thinking; Gemini:
  the whole `content` incl. thought signatures). A `refusal`, `max_tokens` or `error` reply is never
  appended, and the loop ends the run on it.
- Tool call ids are stable strings the loop uses for `order` / `waiting` / the one-result-per-call check;
  the adapter keeps an id → name map so results can be sent back however the provider needs.
- `Step.usage` is normalised: `input` = every prompt token incl. cache writes and reads, `output` = all
  output incl. thinking; `requests` = how many model calls the step made (they all count toward the cap).
- API errors raise LLMError subclasses (claude.KeyRejected, spend.BudgetExceeded, claude.EnvatoUnavailable…);
  a step that would need more than `max_requests` calls raises OutOfSteps.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import anthropic

from geniuscut import catalog, claude, spend
from geniuscut.errors import LLMError

STOPS = ("end", "tool_use", "max_tokens", "refusal", "error")


@dataclass(frozen=True)
class ToolResult:
    id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class Usage:
    input: int   # all prompt tokens, cache writes and reads included
    output: int  # thinking included


@dataclass
class Step:
    text: str                                    # the reply's visible text ("" if none; never thinking)
    tool_calls: list[dict] = field(default_factory=list)  # [{id, name, input}] in reply order
    stop: str = "end"                            # one of STOPS
    usage: Usage | None = None                   # of the last model call
    model: str = ""                              # catalog id of the model that answered
    detail: str | None = None                    # refusal category / error text
    requests: int = 1                            # model calls this step made


class OutOfSteps(Exception):
    """The step needed more model calls than the run has left (the loop's step cap)."""


class ClaudeAdapter:
    """Claude on the Anthropic API (`anthropic.Anthropic`) or Google Cloud Vertex AI (`AnthropicVertex`),
    streamed, tools with `tool_choice` auto. Per catalog params: max output, effort (`output_config`) and
    top-level `cache_control` only where the entry allows them (off on Vertex until verified), server-side
    `fallbacks` only on the Anthropic API for models that take it. The Envato MCP connector (`envato=True`)
    only on the Anthropic API (plan Task 4 replaces it). `pause_turn` (a server-side tool loop paused) is
    appended unchanged and continued here, each continuation counting as a request."""

    def __init__(self, entry: catalog.Entry):
        self.entry = entry
        self.messages: list = []
        self.names: dict[str, str] = {}  # tool_use id → tool name

    @property
    def history(self) -> list:
        return self.messages

    def make_client(self):
        return claude.make_client(self.entry)

    def add_user_text(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def add_tool_results(self, results: list[ToolResult]) -> None:
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error}
            for r in results]})

    def _request(self, system: str, tools: list[dict], envato: bool) -> tuple[dict, object]:
        e, p = self.entry, self.entry.params
        kwargs = dict(model=e.model, max_tokens=p.max_output, system=system, tools=tools,
                      tool_choice={"type": "auto"}, messages=self.messages)
        if p.output_config and p.effort:
            kwargs["output_config"] = {"effort": p.effort}
        if p.caching == "auto":
            kwargs["cache_control"] = {"type": "ephemeral"}
        if e.provider == "vertex":
            return kwargs, "plain"
        betas = [claude.FALLBACK_BETA] if p.fallbacks else []
        if p.fallbacks:
            kwargs["fallbacks"] = "default"
        if envato:
            betas.append(claude.MCP_BETA)
            kwargs.update(mcp_servers=[claude.ENVATO_SERVER], tools=[*tools, claude.ENVATO_TOOLSET])
        if betas:
            kwargs["betas"] = betas
        return kwargs, "beta"

    def _call(self, client, system: str, tools: list[dict], input_tokens: int, envato: bool):
        cid = self.entry.id
        claude.require_price(cid)
        spend.check_tokens(cid, input_tokens, self.entry.params.max_output)
        kwargs, api = self._request(system, tools, envato and self.entry.provider == "anthropic")
        stream = client.messages.stream if api == "plain" else client.beta.messages.stream
        with claude.api_errors(cid):
            try:
                with stream(**kwargs) as s:
                    response = s.get_final_message()
            except anthropic.APIStatusError as e:
                if "mcp_servers" in kwargs and e.status_code not in (401, 429) and claude.mcp_failure(e):
                    raise claude.EnvatoUnavailable(f"Envato search is unavailable: {claude._api_message(e)}") from e
                raise
        usage = getattr(response, "usage", None)
        if usage is not None:
            spend.record(claude.answered(response, cid), _tokens(usage, "input_tokens"),
                         _tokens(usage, "output_tokens"), cache_write=_tokens(usage, "cache_creation_input_tokens"),
                         cache_read=_tokens(usage, "cache_read_input_tokens"), price_as=cid)
        return response

    def step(self, system: str, tools: list[dict], *, client, input_tokens: int, max_requests: int = 1,
             envato: bool = False) -> Step:
        requests = 0
        while True:
            if requests >= max_requests:
                raise OutOfSteps()
            response = self._call(client, system, tools, input_tokens, envato)
            requests += 1
            u = getattr(response, "usage", None)
            usage = Usage(sum(_tokens(u, n) for n in ("input_tokens", "cache_creation_input_tokens",
                                                       "cache_read_input_tokens")),
                          _tokens(u, "output_tokens")) if u is not None else None
            stop = getattr(response, "stop_reason", None)
            model = claude.answered(response, self.entry.id)
            if stop == "refusal":  # not appended: the run ends here
                details = getattr(response, "stop_details", None)
                return Step("", stop="refusal", usage=usage, model=model,
                            detail=getattr(details, "category", None), requests=requests)
            if stop == "max_tokens":  # a cut-off tool call must never run
                return Step("", stop="max_tokens", usage=usage, model=model, requests=requests)
            self.messages.append({"role": "assistant", "content": response.content})  # whole, never edited
            if stop == "pause_turn":  # a server-side tool loop paused (Envato searches): let Claude go on
                if usage is not None:
                    input_tokens = spend.estimate_step(usage.input, usage.output, 0)
                continue
            text = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
            calls = [{"id": b.id, "name": b.name, "input": b.input}
                     for b in response.content if getattr(b, "type", None) == "tool_use"]
            self.names.update({c["id"]: c["name"] for c in calls})
            return Step(text, calls if stop == "tool_use" and calls else [],
                        "tool_use" if stop == "tool_use" and calls else "end", usage, model, requests=requests)


GEMINI_SOON = "Gemini support for the assistant is coming in the next build."


class GeminiAdapter:
    """Gemini function calling over gemini.py's REST client: plan Task 3 builds it (whole-content history
    incl. thought signatures, synthetic ids `g<step>_<index>`, functionResponse per call in order, schema
    conversion, stop/refusal/empty-reply mapping, agent thinking level from the catalog). Until then an agent
    run on a Gemini model stops at once with GEMINI_SOON; Analyse on Gemini works (llm.py → gemini.py)."""

    def __init__(self, entry: catalog.Entry):
        self.entry = entry

    @property
    def history(self) -> list:
        raise NotImplementedError(GEMINI_SOON)

    def make_client(self):
        raise NotImplementedError(GEMINI_SOON)

    def add_user_text(self, text: str) -> None:
        raise NotImplementedError(GEMINI_SOON)

    def add_tool_results(self, results: list[ToolResult]) -> None:
        raise NotImplementedError(GEMINI_SOON)

    def step(self, system: str, tools: list[dict], *, client, input_tokens: int, max_requests: int = 1,
             envato: bool = False) -> Step:
        raise NotImplementedError(GEMINI_SOON)


ADAPTERS = {"anthropic": ClaudeAdapter, "vertex": ClaudeAdapter, "gemini": GeminiAdapter}


def for_entry(entry: catalog.Entry):
    cls = ADAPTERS.get(entry.provider)
    if cls is None:
        raise LLMError(f"Unknown AI model {entry.id!r}: pick one from the list.")
    return cls(entry)


def _tokens(usage, name: str) -> int:
    return int(getattr(usage, name, 0) or 0)
