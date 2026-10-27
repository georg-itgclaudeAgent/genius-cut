"""Provider adapters for the agent loop (agent.py): the loop speaks one neutral step contract and each
adapter turns it into its provider's requests and replies (spec "Neutral reply and stops", plan Task 2/3).

The contract (what agent.py relies on; ClaudeAdapter and GeminiAdapter implement it):

    adapter = adapters.for_entry(entry)        # one per run, from the run's catalog entry
    client = adapter.make_client()            # once per run (reads the key / ADC); may raise
                                              # secrets.MissingKeyError or LLMError
    adapter.add_user_text(text)               # the first instruction, "Approved: …"
    adapter.add_tool_results([ToolResult…])   # one per tool call of the last reply, in call order
    step = adapter.step(system, tools, client=client, input_tokens=n, max_requests=k)
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
- API errors raise LLMError subclasses (claude.KeyRejected, gemini.KeyRejected, spend.BudgetExceeded…);
  a step that would need more than `max_requests` calls raises OutOfSteps.
- Every tool is a client tool the loop runs (Envato search is agent.py's search_envato backend tool, the same
  on every provider): no server-side tools, so no provider-specific tool plumbing here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from geniuscut import catalog, claude, gemini, spend
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
    `fallbacks` only on the Anthropic API for models that take it. No server-side tools are sent, so a
    `pause_turn` (only a server-side tool loop pauses) is unexpected: it is not appended and maps to stop
    `error`; any other unknown stop reason is taken as `end`."""

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

    def _request(self, system: str, tools: list[dict]) -> tuple[dict, object]:
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
        if betas:
            kwargs["betas"] = betas
        return kwargs, "beta"

    def _call(self, client, system: str, tools: list[dict], input_tokens: int):
        cid = self.entry.id
        claude.require_price(cid)
        spend.check_tokens(cid, input_tokens, self.entry.params.max_output)
        kwargs, api = self._request(system, tools)
        stream = client.messages.stream if api == "plain" else client.beta.messages.stream
        with claude.api_errors(cid):
            with stream(**kwargs) as s:
                response = s.get_final_message()
        usage = getattr(response, "usage", None)
        if usage is not None:
            spend.record(claude.answered(response, cid), _tokens(usage, "input_tokens"),
                         _tokens(usage, "output_tokens"), cache_write=_tokens(usage, "cache_creation_input_tokens"),
                         cache_read=_tokens(usage, "cache_read_input_tokens"), price_as=cid)
        return response

    def step(self, system: str, tools: list[dict], *, client, input_tokens: int, max_requests: int = 1) -> Step:
        if max_requests < 1:
            raise OutOfSteps()
        response = self._call(client, system, tools, input_tokens)
        u = getattr(response, "usage", None)
        usage = Usage(sum(_tokens(u, n) for n in ("input_tokens", "cache_creation_input_tokens",
                                                   "cache_read_input_tokens")),
                      _tokens(u, "output_tokens")) if u is not None else None
        stop = getattr(response, "stop_reason", None)
        model = claude.answered(response, self.entry.id)
        if stop == "refusal":  # not appended: the run ends here
            details = getattr(response, "stop_details", None)
            return Step("", stop="refusal", usage=usage, model=model, detail=getattr(details, "category", None))
        if stop == "max_tokens":  # a cut-off tool call must never run
            return Step("", stop="max_tokens", usage=usage, model=model)
        if stop == "pause_turn":  # only server-side tools pause, and none are sent: never taken as a plan
            return Step("", stop="error", usage=usage, model=model, detail="an unexpected pause_turn")
        self.messages.append({"role": "assistant", "content": response.content})  # whole, never edited
        text = "".join(getattr(b, "text", "") for b in response.content if getattr(b, "type", None) == "text")
        calls = [{"id": b.id, "name": b.name, "input": b.input}
                 for b in response.content if getattr(b, "type", None) == "tool_use"]
        self.names.update({c["id"]: c["name"] for c in calls})
        return Step(text, calls if stop == "tool_use" and calls else [],
                    "tool_use" if stop == "tool_use" and calls else "end", usage, model)


class GeminiAdapter:
    """Gemini over REST `generateContent` with function calling (gemini.py's Client + generate()).

    Docs checked 2026-10-27 (the guides now lead with the Interactions API; this uses generateContent):
    - https://ai.google.dev/api/generate-content : Part.thought / Part.thoughtSignature ("an opaque signature
      for the thought so it can be reused in subsequent requests"), FunctionCall.id (optional),
      FunctionResponse {id?, name, response}, FunctionDeclaration.parametersJsonSchema (JSON Schema, mutually
      exclusive with `parameters`), the FinishReason list (MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, ...).
    - https://ai.google.dev/gemini-api/docs/thinking#signatures : in generateContent "signatures are metadata
      that can be attached to any part", e.g. inside functionCall parts or the final part, so the model's
      whole `content` is kept and sent back unchanged.
    - https://ai.google.dev/gemini-api/docs/function-calling and https://ai.google.dev/api/caching
      (FunctionCallingConfig mode AUTO).
    A live call to gemini-3.8-flash (2026-10-27) accepted `parametersJsonSchema` with additionalProperties,
    type arrays, pattern and minLength, returned parallel calls with ids (`call_...`) and the signature on the
    first functionCall part; so tools go in as JSON Schema unchanged and `variables` keeps its schema.

    - History: `contents`: user turns {"role": "user", "parts": [...]} and each usable model `content` whole.
    - Ids: Gemini's own functionCall.id when it gives one, else `g<turn>_<index>` (turn = this model turn's
      number in the run, index = the call's place in the reply). Results go back as one `functionResponse`
      part per call, in call order, with the call's name (and Gemini's id when it gave one) and response
      {"result": text} or {"error": text}.
    - Stops: functionCall parts -> tool_use; promptFeedback.blockReason or a declined finish -> refusal;
      MAX_TOKENS -> max_tokens; MALFORMED_FUNCTION_CALL / UNEXPECTED_TOOL_CALL / an empty reply (no text, no
      call) -> error, retried once inside the step (each retry is a request). `thought` parts never reach text.
    - Params: the entry's max output; thinkingConfig.thinkingLevel = entry.params.thinking ("medium") on
      gemini-3* models (Analyse keeps gemini.py's "low"). Caching is Gemini's implicit caching (nothing sent).
    - Usage: input = promptTokenCount (cached included), output = candidates + thoughts; spend is recorded
      per call under the catalog id, cached tokens at the cache-read rate, long-prompt tiers by prompt size.
    - Envato search is agent.py's search_envato backend tool: an ordinary function call here."""

    RETRY = ("MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL")
    DECLINED = (*sorted(gemini.DECLINED), "LANGUAGE", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "ESCALATION",
                "PUP_LIMITED_DISABLED")
    OK = (None, "STOP", "FINISH_REASON_UNSPECIFIED")

    def __init__(self, entry: catalog.Entry):
        self.entry = entry
        self.contents: list[dict] = []
        self.calls: dict[str, tuple[str, str | None]] = {}  # call id -> (tool name, Gemini's own id or None)
        self.turns = 0  # model turns appended

    @property
    def history(self) -> list:
        return self.contents

    def make_client(self):
        return gemini.make_client()

    def add_user_text(self, text: str) -> None:
        self.contents.append({"role": "user", "parts": [{"text": text}]})

    def add_tool_results(self, results: list[ToolResult]) -> None:
        parts = []
        for r in results:
            if r.id not in self.calls:
                raise LLMError(f"No Gemini function call has the id {r.id!r}.")
            name, own = self.calls[r.id]
            response = {"error": r.content} if r.is_error else {"result": r.content}
            parts.append({"functionResponse": {**({"id": own} if own else {}), "name": name, "response": response}})
        self.contents.append({"role": "user", "parts": parts})

    def _body(self, system: str, tools: list[dict]) -> dict:
        e, p = self.entry, self.entry.params
        config: dict = {"maxOutputTokens": p.max_output}
        if p.thinking and e.model.startswith("gemini-3"):
            config["thinkingConfig"] = {"thinkingLevel": p.thinking}
        body = {"contents": self.contents, "generationConfig": config}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if tools:
            body["tools"] = [{"functionDeclarations": [declaration(t) for t in tools]}]
            body["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
        return body

    def _call(self, client, system: str, tools: list[dict], input_tokens: int) -> dict:
        cid = self.entry.id
        if spend.price(cid) is None:  # an unpriced model would skip the gate: unlimited spend
            raise LLMError(f"No price is known for Gemini model '{cid}', so the monthly limit can't be "
                           f"enforced. Use one of: {', '.join(sorted(spend.PRICES))}.")
        spend.check_tokens(cid, input_tokens, self.entry.params.max_output)
        response = gemini.generate(client, self.entry.model, self._body(system, tools))
        u = response.get("usageMetadata") or {}
        prompt, out = gemini._usage(response)
        cached = min(int(u.get("cachedContentTokenCount") or 0), prompt)
        spend.record(cid, prompt - cached, out, cache_read=cached, price_as=cid)
        return response

    def step(self, system: str, tools: list[dict], *, client, input_tokens: int, max_requests: int = 1) -> Step:
        requests, cid = 0, self.entry.id
        while True:
            if requests >= max_requests:
                raise OutOfSteps()
            response = self._call(client, system, tools, input_tokens)
            requests += 1
            usage = Usage(*gemini._usage(response))
            block = (response.get("promptFeedback") or {}).get("blockReason")
            if block:  # nothing is appended on a refusal, max_tokens or error: the run ends there
                return Step("", stop="refusal", usage=usage, model=cid, detail=block, requests=requests)
            candidate = (response.get("candidates") or [{}])[0] or {}
            finish = candidate.get("finishReason")
            if finish in self.DECLINED:
                return Step("", stop="refusal", usage=usage, model=cid, detail=finish, requests=requests)
            if finish in ("MAX_TOKENS", "CONTINUATION"):  # a cut-off call must never run
                return Step("", stop="max_tokens", usage=usage, model=cid, requests=requests)
            content = candidate.get("content") or {}
            parts = content.get("parts") or []
            text = "".join(p.get("text") or "" for p in parts if not p.get("thought"))
            fcalls = [p["functionCall"] for p in parts if isinstance(p.get("functionCall"), dict)]
            if finish in self.RETRY or (finish in self.OK and not fcalls and not text.strip()):
                if requests == 1:
                    continue  # retried once with the same request; never taken as a plan
                what = finish if finish in self.RETRY else "an empty reply"
                return Step("", stop="error", usage=usage, model=cid, requests=requests,
                            detail=f"Gemini sent {what} twice")
            if finish not in self.OK:
                return Step("", stop="error", usage=usage, model=cid, requests=requests,
                            detail=f"Gemini stopped with {finish}")
            self.turns += 1
            self.contents.append(content if content.get("role") else {"role": "model", **content})  # whole
            calls = []
            for i, f in enumerate(fcalls):
                own = f.get("id") if isinstance(f.get("id"), str) and f.get("id") else None
                call_id = own or f"g{self.turns}_{i}"
                self.calls[call_id] = (f.get("name", ""), own)
                calls.append({"id": call_id, "name": f.get("name", ""), "input": f.get("args") or {}})
            return Step(text, calls, "tool_use" if calls else "end", usage, cid, requests=requests)


def declaration(tool: dict) -> dict:
    """A neutral tool ({name, description, input_schema}) as a Gemini function declaration: the JSON Schema
    goes in whole as `parametersJsonSchema` (see GeminiAdapter's docs note), so nothing is converted or lost."""
    return {"name": tool["name"], "description": tool.get("description", ""),
            "parametersJsonSchema": tool["input_schema"]}


ADAPTERS = {"anthropic": ClaudeAdapter, "vertex": ClaudeAdapter, "gemini": GeminiAdapter}


def for_entry(entry: catalog.Entry):
    cls = ADAPTERS.get(entry.provider)
    if cls is None:
        raise LLMError(f"Unknown AI model {entry.id!r}: pick one from the list.")
    return cls(entry)


def _tokens(usage, name: str) -> int:
    return int(getattr(usage, name, 0) or 0)
