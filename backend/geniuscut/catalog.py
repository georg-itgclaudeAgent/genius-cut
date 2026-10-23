"""The AI model catalog: the 12 models the panel's picker offers, their prices, per-model agent
parameters, and a cached availability check per provider.

Panel contract (API_VERSION 8; all routes need `Authorization: Bearer <token>`, errors `{"detail": str}`)
------------------------------------------------------------------------------------------------------
Catalog ids are `<provider>:<model>`, provider `anthropic` (Anthropic API key) | `vertex` (Claude on
Google Cloud Vertex AI, ADC, billed to the GCP project) | `gemini` (Gemini API key). Every cost, ledger row
and price is keyed by catalog id, never by a bare model name.

- `GET /models[?refresh=1]` →
  `{"selected": <catalog id>,
    "models": [{"id": str, "label": str, "provider": "anthropic"|"vertex"|"gemini",
                "group": "Claude (Anthropic key)"|"Claude (Google Cloud)"|"Gemini",
                "price": {"input": float, "output": float} | null,    # USD per 1M tokens today, base tier
                "usd_per_minute": float|null,                          # the cost-line estimate for this model
                "state": "ok"|"blocked"|"setup", "message": str}],     # message: why, e.g.
                                    # "Workspace limit reached until 1 Nov", "Enable in Model Garden"
    "vertex": {"project": str, "region": str, "adc": bool, "quota_project": str|null}}`
  Models are in catalog order (the 4 Claude via Anthropic, the 4 Claude via Vertex, the 4 Gemini).
  Probe results are cached 10 minutes; `refresh=1` re-probes everything. Probes cost nothing (Anthropic
  `messages.count_tokens`; Vertex: ADC file present, then `count_tokens`, else one 1-token call ≈ $0.0001,
  recorded in the ledger as kind "probe"; Gemini: one `models.list`). A real call's error (e.g. the
  workspace cap) updates the cached state too. A model with no known price is `setup`, "price unknown".
- `GET /settings` → `{"anthropic_key": {...}, "monthly_limit_usd": 20|100, "setup_complete": bool,
  "model": <catalog id>, "vertex": {"project": str, "region": str}}`. A stored model that isn't in the
  catalog reads back as the default `anthropic:claude-opus-5-5`.
- `PUT /settings` takes any subset of `anthropic_key`, `monthly_limit_usd`, `model`, `vertex` and MERGES it
  into the saved settings (fields not sent are kept); returns the settings. 422 for an invalid field.
- `PUT /settings/model` `{"model": <catalog id>}` → the settings; 422 `{"detail"}` for an id not in the
  catalog. Takes effect for the next Analyse / agent run (an open run keeps its model). Blocked/setup models
  may be selected (the picker greys them; the run then fails with the reason).
- `/health` → `"ai": {"model_id": <catalog id>|null, "label": str|null,
  "provider": "anthropic"|"vertex"|"gemini"|"unknown", "month_usd": float|null, "limit_usd": float,
  "limit_tier": 20|100, "usd_per_minute": float|null, "key_from_cache": bool}` for the selected model
  (a dev env override, see llm.selected_id, wins when set). Refresh it after a switch.
- Step replies (`/agent/runs*`) and `/trim`, `/library/summarize` replies: `"cost": {"model": <catalog id>,
  "label": str, "provider": str, "input_tokens": int, "output_tokens": int, "usd": float|null,
  "month_usd": float, "limit_usd": float}` (model = the model that answered last).
- `GET /usage` runs: `{"at", "kind", "model": <catalog id>, "label": str, "provider": str, "usd"}`.
  Ledger rows (`spend.jsonl`) carry `model` (catalog id) and `provider`; rows written before API 8 hold a
  bare name and are read as `anthropic:`/`gemini:` ids.
- `POST /setup/vertex-login` `{"project"?: str}` (default: settings.vertex.project) → 202
  `{"state": "running", "message": str}`; 409 while one runs; 422 invalid project; 502 gcloud missing. Runs
  `gcloud auth application-default login --quiet` (browser; Georg signs in himself), then
  `gcloud auth application-default set-quota-project <project> --quiet`.
  `GET /setup/vertex-login` → `{"state": "idle"|"running"|"done"|"failed", "message": str}`; poll it. A
  finished sign-in drops the cached Vertex states.

Prices (USD per 1M tokens), checked 2026-10-23 on the official pages:
- Claude, Anthropic API: platform.claude.com/docs/en/about-claude/pricing (base input, 5m cache write,
  cache hit, output). Haiku 5.5 is priced by prompt length: over 100,000 prompt tokens (cache reads and
  writes count) every token pays the higher prices.
- Claude on Vertex (`global` endpoint): cloud.google.com/vertex-ai/generative-ai/pricing, "Anthropic's Claude
  models", Global column: the same as the Anthropic API. Regional and multi-region endpoints cost 10% more;
  this catalog prices the global endpoint (the default region) only.
- Gemini API paid tier, Standard: ai.google.dev/gemini-api/docs/pricing (3.8 Flash, 3.1 Pro Preview). 3.7
  Flash and 3.5 Flash are no longer on that page; their prices come from the Vertex AI pricing page's
  "Gemini 3 Standard" Global rows, which list the same figures as the Gemini API page for 3.8 Flash and 3.1 Pro.
  Gemini "cache_read" is the context-caching price; there is no cache-write charge (write = input rate).
  3.1 Pro Preview: prompts over 200k tokens pay the long-context prices for all tokens.

Per-model agent parameters (`Params`) are what adapters send (plan Task 2/3): max output for the gate and
the request, Claude effort, Gemini agent thinking level, caching style, structured outputs, and whether the
Anthropic API's server-side refusal fallback is on (refusals-and-fallback docs, 2026-10-23: Fable 5.1, Opus 5.5
and Sonnet 5.5 have it, Haiku 5.5 doesn't; never on Vertex). Vertex `cache_control` / `output_config` support
is unverified until the first real Vertex call (no ADC on the laptop on 2026-10-23).

This module imports nothing from Genius Cut at load time (settings and spend import it).
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

PROVIDERS = ("anthropic", "vertex", "gemini")
GROUPS = {"anthropic": "Claude (Anthropic key)", "vertex": "Claude (Google Cloud)", "gemini": "Gemini"}
DEFAULT_MODEL = "anthropic:claude-opus-5-5"
PRICES_CHECKED = date(2026, 10, 23)
TTL_S = 600  # probe results are kept 10 minutes
GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
PROBE_TIMEOUT_S = 20

ANTHROPIC_PRICING = "platform.claude.com/docs/en/about-claude/pricing (2026-10-23)"
VERTEX_PRICING = "cloud.google.com/vertex-ai/generative-ai/pricing, Claude, Global (2026-10-23)"
GEMINI_PRICING = "ai.google.dev/gemini-api/docs/pricing, paid Standard (2026-10-23)"
VERTEX_GEMINI_PRICING = "cloud.google.com/vertex-ai/generative-ai/pricing, Gemini 3 Standard, Global (2026-10-23)"


@dataclass(frozen=True)
class Rate:
    """USD per 1M tokens."""

    input: float
    output: float
    cache_write: float
    cache_read: float


@dataclass(frozen=True)
class Price:
    """The prices from `since` on; `long` applies to a request whose prompt is over `long_above` tokens."""

    since: date
    base: Rate
    long: Rate | None = None
    long_above: int = 0


@dataclass(frozen=True)
class Params:
    max_output: int                 # the agent's max_tokens (and the gate's worst-case reply)
    effort: str | None = None       # Claude output_config.effort for agent steps
    thinking: str | None = None     # Gemini thinkingConfig.thinkingLevel for agent steps (Analyse keeps "low")
    caching: str = "none"           # "auto": top-level cache_control (Claude); "implicit": Gemini's own
    structured_output: bool = True  # JSON schema output (Analyse)
    fallbacks: bool = False         # Anthropic API server-side refusal fallback (`fallbacks="default"`)


@dataclass(frozen=True)
class Entry:
    id: str
    provider: str
    model: str
    label: str
    prices: tuple[Price, ...]  # oldest first; empty = price unknown (the entry is "setup")
    params: Params
    source: str                # where the prices were read, and when
    notes: str = ""

    @property
    def group(self) -> str:
        return GROUPS[self.provider]


def _claude(model: str, name: str, base: Rate, *, long: Rate | None = None, long_above: int = 0,
            fallbacks: bool = True) -> list[Entry]:
    price = (Price(date.min, base, long, long_above),)
    return [
        Entry(f"anthropic:{model}", "anthropic", model, f"{name} (Anthropic)", price,
              Params(max_output=32000, effort="high", caching="auto", fallbacks=fallbacks), ANTHROPIC_PRICING),
        Entry(f"vertex:{model}", "vertex", model, f"{name} (Google Cloud)", price,
              Params(max_output=32000, effort="high", caching="auto", fallbacks=False), VERTEX_PRICING,
              notes="Vertex cache_control/output_config unverified until the first real call."),
    ]


def _gemini(model: str, name: str, prices: tuple[Price, ...], source: str, notes: str = "") -> Entry:
    return Entry(f"gemini:{model}", "gemini", model, name, prices,
                 Params(max_output=32000, thinking="medium", caching="implicit"), source, notes)


_FLASH_PROMO = (Price(date.min, Rate(0.75, 3.75, 0.75, 0.075)),
                Price(date(2027, 1, 1), Rate(1.50, 7.50, 1.50, 0.15)))

_CLAUDE = [
    *_claude("claude-opus-5-5", "Claude Opus 5.5", Rate(4.00, 20.00, 5.00, 0.20)),
    *_claude("claude-sonnet-5-5", "Claude Sonnet 5.5", Rate(2.00, 10.00, 2.50, 0.10)),
    *_claude("claude-haiku-5-5", "Claude Haiku 5.5", Rate(0.10, 0.50, 0.125, 0.01),
             long=Rate(0.50, 2.50, 0.625, 0.05), long_above=100_000, fallbacks=False),
    *_claude("claude-fable-5-1", "Claude Fable 5.1", Rate(10.00, 50.00, 12.50, 0.25)),
]

ENTRIES: tuple[Entry, ...] = (
    *[e for e in _CLAUDE if e.provider == "anthropic"],
    *[e for e in _CLAUDE if e.provider == "vertex"],
    _gemini("gemini-3.8-flash", "Gemini 3.8 Flash", _FLASH_PROMO, GEMINI_PRICING,
            "Promo prices through 2026-12-31; doubles on 2027-01-01."),
    _gemini("gemini-3.7-flash", "Gemini 3.7 Flash", _FLASH_PROMO, VERTEX_GEMINI_PRICING,
            "Not on the Gemini API pricing page any more; Vertex Global Standard rows."),
    _gemini("gemini-3.5-flash", "Gemini 3.5 Flash", (Price(date.min, Rate(1.50, 9.00, 1.50, 0.15)),),
            VERTEX_GEMINI_PRICING, "Not on the Gemini API pricing page any more; Vertex Global Standard rows."),
    _gemini("gemini-3.1-pro-preview", "Gemini 3.1 Pro", (Price(date.min, Rate(2.00, 12.00, 2.00, 0.20),
                                                               Rate(4.00, 18.00, 4.00, 0.40), 200_000),),
            GEMINI_PRICING, "Preview model, in the list by Georg's choice."),
)

BY_ID: dict[str, Entry] = {e.id: e for e in ENTRIES}


def get(model_id: str) -> Entry | None:
    return BY_ID.get(model_id)


def is_known(model_id) -> bool:
    return isinstance(model_id, str) and model_id in BY_ID


def provider_of(model_id: str) -> str:
    """`anthropic` for `anthropic:claude-…`; a legacy bare name guesses from the name; else 'unknown'."""
    head, sep, _ = str(model_id).partition(":")
    if sep:
        return head if head in PROVIDERS else "unknown"
    if model_id.startswith("claude-"):
        return "anthropic"
    if model_id.startswith("gemini-"):
        return "gemini"
    return "unknown"


def normalise(model_id: str) -> str:
    """A ledger row's model as a catalog-style id (rows before API 8 hold a bare name)."""
    model_id = str(model_id or "")
    if ":" in model_id or not model_id:
        return model_id
    p = provider_of(model_id)
    return f"{p}:{model_id}" if p != "unknown" else model_id


def label(model_id: str | None) -> str | None:
    """The picker's name for a catalog id; an id outside the catalog (a fallback model) shows its model name."""
    if model_id is None:
        return None
    e = BY_ID.get(model_id)
    return e.label if e else str(model_id).partition(":")[2] or str(model_id)


def price_on(entry_prices, on: date, prompt_tokens: int = 0) -> Rate | None:
    """The Rate in force on `on` for a request with this many prompt tokens (all input incl. cache)."""
    current = None
    for p in entry_prices or ():
        if on >= p.since:
            current = p
    if current is None:
        return None
    if current.long is not None and prompt_tokens > current.long_above:
        return current.long
    return current.base


# ── availability ───────────────────────────────────────────────────

@dataclass
class Status:
    state: str      # ok | blocked | setup
    message: str
    at: float = 0.0
    transient: bool = False  # a network blip / rate limit: re-probed on the next listing


_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_REGAIN = re.compile(r"regain access on (\d{4})-(\d{2})-(\d{2})")


def _api_message(e) -> str:
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        msg = (body.get("error") or {}).get("message")
        if msg:
            return str(msg)
    return str(e)


def cap_message(text: str) -> str | None:
    """"Workspace limit reached until 1 Nov" for Anthropic's workspace-cap error, else None."""
    if "usage limit" not in text.lower():
        return None
    m = _REGAIN.search(text)
    if not m:
        return "Workspace limit reached"
    return f"Workspace limit reached until {int(m.group(3))} {_MONTHS[int(m.group(2)) - 1]}"


def classify_anthropic(e: BaseException, *, vertex: bool = False) -> Status:
    """A probe's or a real call's exception as the picker's state. Never raises."""
    import anthropic

    from geniuscut import secrets
    who = "Google Cloud" if vertex else "Anthropic"
    if isinstance(e, secrets.MissingKeyError):
        return Status("setup", "No Anthropic key set up yet: finish Setup in Settings.")
    if type(e).__module__.startswith("google.auth"):
        return Status("setup", "Sign in to Google Cloud for Vertex in Settings.")
    if isinstance(e, anthropic.AuthenticationError):
        if vertex:
            return Status("setup", "Google Cloud sign-in expired: sign in again in Settings.")
        return Status("blocked", "Key rejected: check the secret in Settings.")
    if isinstance(e, anthropic.APIConnectionError):
        return Status("blocked", f"Couldn't reach {who}. Check the internet connection.", transient=True)
    if isinstance(e, anthropic.APIStatusError):
        msg, code = _api_message(e), e.status_code
        cap = cap_message(msg)
        if cap:
            return Status("blocked", cap)
        low = msg.lower()
        if vertex and (code == 404 or (code == 403 and ("model garden" in low or "not found" in low
                                                          or "access" in low))):
            return Status("setup", "Enable in Model Garden")
        if code == 404:
            return Status("blocked", "Not available on this key.")
        if code == 429:
            return Status("blocked", f"{who} is rate-limiting requests; try again shortly.", transient=True)
        if code >= 500:
            return Status("blocked", f"{who} is unavailable right now; try again shortly.", transient=True)
        return Status("blocked", f"{who} API error {code}: {msg[:160]}")
    return Status("blocked", f"The check failed: {type(e).__name__}.", transient=True)


def adc_path(env=None) -> Path | None:
    """The Application Default Credentials file gcloud writes (or GOOGLE_APPLICATION_CREDENTIALS)."""
    env = os.environ if env is None else env
    explicit = env.get("GOOGLE_APPLICATION_CREDENTIALS")
    if explicit:
        return Path(explicit)
    root = env.get("APPDATA") if os.name == "nt" else os.path.join(env.get("HOME", ""), ".config")
    return Path(root) / "gcloud" / "application_default_credentials.json" if root else None


def read_adc() -> dict:
    """{present, quota_project}: from the ADC file only, no network."""
    path = adc_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path else None
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        return {"present": False, "quota_project": None}
    quota = data.get("quota_project_id")
    if data.get("type") == "service_account":
        quota = quota or data.get("project_id")
    return {"present": True, "quota_project": str(quota) if quota else None}


_key_memo: tuple[float, str] | None = None
_key_lock = threading.Lock()


def _probe_key() -> str:
    """The Anthropic key, read once for a whole probe round (four models probed at once)."""
    global _key_memo
    from geniuscut import secrets
    with _key_lock:
        if _key_memo and time.monotonic() - _key_memo[0] < 30:
            return _key_memo[1]
        key = secrets.anthropic_api_key()
        _key_memo = (time.monotonic(), key)
        return key


def _default_anthropic_count(model: str, *, make_client: Callable | None = None) -> None:
    import anthropic
    client = (make_client or anthropic.Anthropic)(api_key=_probe_key(), timeout=PROBE_TIMEOUT_S, max_retries=0)
    client.messages.count_tokens(model=model, messages=[{"role": "user", "content": "hi"}])


def _count_unsupported(e) -> bool:
    """Vertex refused count_tokens itself (not the model): fall back to a 1-token call."""
    import anthropic
    if not isinstance(e, anthropic.APIStatusError) or e.status_code not in (400, 404, 405, 501):
        return False
    low = _api_message(e).lower()
    if "model" in low and ("not found" in low or "access" in low):
        return False
    return "count" in low or "not supported" in low or "unsupported" in low


def _default_vertex_count(model: str, project: str, region: str, *, make_client: Callable | None = None) -> None:
    """count_tokens on Vertex; if Vertex doesn't serve it, one 1-token call (≈$0.0001, in the ledger)."""
    import anthropic

    from geniuscut import spend
    client = (make_client or anthropic.AnthropicVertex)(project_id=project, region=region, timeout=PROBE_TIMEOUT_S,
                                                        max_retries=0)
    msgs = [{"role": "user", "content": "hi"}]
    try:
        client.messages.count_tokens(model=model, messages=msgs)
        return
    except Exception as e:  # noqa: BLE001 — classified by the caller unless it's "count unsupported"
        if not _count_unsupported(e):
            raise
    cid = f"vertex:{model}"
    spend.check_tokens(cid, 10, 1)
    response = client.messages.create(model=model, max_tokens=1, messages=msgs)
    usage = getattr(response, "usage", None)
    if usage is not None:
        with spend.tagged("probe"):
            spend.record(cid, int(getattr(usage, "input_tokens", 0) or 0),
                         int(getattr(usage, "output_tokens", 0) or 0), price_as=cid)


def _default_gemini_list(*, urlopen: Callable | None = None) -> set[str]:
    """Bare model names the Gemini key may call (one paged `models.list`); the key goes in a header only."""
    from geniuscut import secrets
    urlopen = urlopen or urllib.request.urlopen
    key = secrets.gemini_api_key()
    names, token = set(), ""
    for _ in range(20):
        url = f"{GEMINI_MODELS_URL}?pageSize=1000" + (f"&pageToken={token}" if token else "")
        req = urllib.request.Request(url, headers={"x-goog-api-key": key})
        try:
            with urlopen(req, timeout=PROBE_TIMEOUT_S) as r:
                body = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            from geniuscut import gemini
            raise GeminiListError(e.code, gemini._error_message(e).replace(key, "[redacted]")) from None
        for m in body.get("models") or []:
            names.add(str(m.get("name", "")).removeprefix("models/"))
        token = body.get("nextPageToken") or ""
        if not token:
            break
    return names


class GeminiListError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def classify_gemini(e: BaseException) -> Status:
    from geniuscut import secrets
    if isinstance(e, secrets.MissingKeyError):
        return Status("setup", "No Gemini key: GOOGLE_API_KEY in Secret Manager (agent-georg) or "
                               "GENIUSCUT_GEMINI_API_KEY.")
    if isinstance(e, GeminiListError):
        if e.code in (400, 401, 403) and "key" in str(e).lower():
            return Status("blocked", "The Gemini key was rejected.")
        if e.code == 429:
            return Status("blocked", "Gemini is rate-limiting requests; try again shortly.", transient=True)
        return Status("blocked", f"Gemini API error {e.code}: {str(e)[:160]}", transient=e.code >= 500)
    if isinstance(e, (urllib.error.URLError, TimeoutError, OSError, ValueError)):
        return Status("blocked", "Couldn't reach the Gemini API. Check the internet connection.", transient=True)
    return Status("blocked", f"The check failed: {type(e).__name__}.", transient=True)


def _default_vertex_config() -> tuple[str, str]:
    from geniuscut import settings
    v = settings.load().vertex
    return v.project, v.region


class Availability:
    """Per-model states from free probes, cached TTL_S seconds. Every dependency is injectable for tests:
    `anthropic_count(model)`, `vertex_count(model, project, region)` raise on failure; `gemini_list()` returns
    the key's model names; `adc()` returns {present, quota_project}; `vertex_config()` (project, region)."""

    def __init__(self, *, anthropic_count: Callable = _default_anthropic_count,
                 vertex_count: Callable = _default_vertex_count, gemini_list: Callable = _default_gemini_list,
                 adc: Callable = read_adc, vertex_config: Callable = _default_vertex_config,
                 clock: Callable = time.monotonic, ttl: float = TTL_S):
        self.anthropic_count, self.vertex_count, self.gemini_list = anthropic_count, vertex_count, gemini_list
        self.adc, self.vertex_config, self.clock, self.ttl = adc, vertex_config, clock, ttl
        self._cache: dict[str, Status] = {}
        self._lock = threading.Lock()
        self._probing = threading.Lock()

    # ── public ─────────────────────────────────────────────────────

    def states(self, refresh: bool = False) -> dict[str, Status]:
        """{catalog id: Status} for every entry; probes what's missing or older than the TTL."""
        with self._probing:
            now = self.clock()
            with self._lock:
                stale = [e for e in ENTRIES if refresh or not self._fresh(e.id, now)]
            if stale:
                self._probe(stale)
            with self._lock:
                return {e.id: self._cache.get(e.id) or Status("blocked", "Not checked yet.") for e in ENTRIES}

    def observe(self, model_id: str, exc: BaseException) -> None:
        """A real call failed: keep what it says about the model's availability (the workspace cap, a rejected
        key, a missing Google sign-in, a model not enabled in Model Garden). Other errors (a bad request, a
        blip) don't change the picker. Never raises."""
        try:
            import anthropic
            e = BY_ID.get(model_id)
            if e is None or e.provider == "gemini":
                return
            status = classify_anthropic(exc, vertex=e.provider == "vertex")
            cap = cap_message(_api_message(exc)) is not None
            if status.transient or not (cap or status.state == "setup"
                                        or isinstance(exc, anthropic.AuthenticationError)):
                return
            # the key, its workspace cap and the Google sign-in are shared by every model of the provider;
            # "Enable in Model Garden" is per model
            shared = e.provider == "anthropic" or status.message != "Enable in Model Garden"
            ids = [x.id for x in ENTRIES if x.provider == e.provider] if shared else [model_id]
            self._store({i: Status(status.state, status.message) for i in ids})
        except Exception:  # noqa: BLE001 — bookkeeping must never break the call's own error
            log.debug("Couldn't note a model state", exc_info=True)

    def invalidate(self, provider: str | None = None) -> None:
        with self._lock:
            for e in ENTRIES:
                if provider is None or e.provider == provider:
                    self._cache.pop(e.id, None)

    def vertex_info(self) -> dict:
        project, region = self._vertex_config()
        try:
            adc = self.adc()
        except Exception:  # noqa: BLE001
            adc = {"present": False, "quota_project": None}
        return {"project": project, "region": region, "adc": bool(adc.get("present")),
                "quota_project": adc.get("quota_project")}

    # ── internals ──────────────────────────────────────────────────

    def _fresh(self, model_id: str, now: float) -> bool:
        s = self._cache.get(model_id)
        return s is not None and now - s.at < self.ttl

    def _store(self, results: dict[str, Status]) -> None:
        """Keep the results; a transient one is reported this time but never counts as fresh."""
        now = self.clock()
        with self._lock:
            for mid, s in results.items():
                s.at = float("-inf") if s.transient else now
                self._cache[mid] = s

    def _vertex_config(self) -> tuple[str, str]:
        try:
            return self.vertex_config()
        except Exception:  # noqa: BLE001
            return "agent-georg", "global"

    def _probe(self, entries: list[Entry]) -> None:
        results: dict[str, Status] = {}
        todo = []
        for e in entries:
            if not e.prices:
                results[e.id] = Status("setup", "price unknown")
            else:
                todo.append(e)
        jobs: list[tuple[list[str], Callable[[], dict[str, Status]]]] = []
        claude_ = [e for e in todo if e.provider == "anthropic"]
        vertex_ = [e for e in todo if e.provider == "vertex"]
        gemini_ = [e for e in todo if e.provider == "gemini"]
        for e in claude_:
            jobs.append(([e.id], lambda e=e: {e.id: self._probe_anthropic(e)}))
        if vertex_:
            pre = self._vertex_precheck()
            if pre is not None:
                results.update({e.id: Status(pre.state, pre.message) for e in vertex_})
            else:
                project, region = self._vertex_config()
                for e in vertex_:
                    jobs.append(([e.id], lambda e=e: {e.id: self._probe_vertex(e, project, region)}))
        if gemini_:
            jobs.append(([e.id for e in gemini_], lambda: self._probe_gemini(gemini_)))
        if jobs:
            with ThreadPoolExecutor(max_workers=min(9, len(jobs))) as pool:
                futures = [(ids, pool.submit(fn)) for ids, fn in jobs]
                for ids, f in futures:
                    try:
                        results.update(f.result())
                    except Exception as exc:  # noqa: BLE001 — a probe bug shows as blocked, never a 500
                        results.update({i: Status("blocked", f"The check failed: {type(exc).__name__}.",
                                                  transient=True) for i in ids})
        self._store(results)

    def _probe_anthropic(self, e: Entry) -> Status:
        try:
            self.anthropic_count(e.model)
        except Exception as exc:  # noqa: BLE001
            return classify_anthropic(exc)
        return Status("ok", "Ready")

    def _vertex_precheck(self) -> Status | None:
        try:
            adc = self.adc()
        except Exception:  # noqa: BLE001
            adc = {"present": False}
        if not adc.get("present"):
            return Status("setup", "Sign in to Google Cloud for Vertex in Settings.")
        if not adc.get("quota_project"):
            return Status("setup", "Finish the Google Cloud sign-in in Settings (no quota project set).")
        return None

    def _probe_vertex(self, e: Entry, project: str, region: str) -> Status:
        try:
            self.vertex_count(e.model, project, region)
        except Exception as exc:  # noqa: BLE001
            from geniuscut import spend
            if isinstance(exc, spend.BudgetExceeded):
                return Status("setup", "Can't check: this month's AI limit is reached.")
            return classify_anthropic(exc, vertex=True)
        return Status("ok", "Enabled")

    def _probe_gemini(self, entries: list[Entry]) -> dict[str, Status]:
        try:
            names = self.gemini_list()
        except Exception as exc:  # noqa: BLE001
            s = classify_gemini(exc)
            return {e.id: Status(s.state, s.message, transient=s.transient) for e in entries}
        return {e.id: Status("ok", "Ready") if e.model in names else Status("blocked", "Not offered to this Gemini key.")
                for e in entries}


_availability: Availability | None = None
_singleton_lock = threading.Lock()


def availability() -> Availability:
    """The process-wide checker (the server's, and the one real calls report errors to)."""
    global _availability
    with _singleton_lock:
        if _availability is None:
            _availability = Availability()
        return _availability


def observe(model_id: str, exc: BaseException) -> None:
    availability().observe(model_id, exc)


def listing(avail: Availability, selected: str, *, refresh: bool = False, on: date | None = None) -> dict:
    """The `GET /models` body (shape at the top of this module)."""
    from geniuscut import spend
    states = avail.states(refresh=refresh)
    on = on or spend._today()
    models = []
    for e in ENTRIES:
        r = price_on(e.prices, on)
        s = states[e.id]
        models.append({"id": e.id, "label": e.label, "provider": e.provider, "group": e.group,
                       "price": {"input": r.input, "output": r.output} if r else None,
                       "usd_per_minute": spend.estimate_per_minute(e.id, on), "state": s.state,
                       "message": s.message})
    return {"selected": selected, "models": models, "vertex": avail.vertex_info()}
