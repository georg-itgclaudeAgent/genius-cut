"""The model catalog and its availability probes (all faked: no network, no key)."""

import dataclasses
import io
import json
import urllib.error
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from geniuscut import catalog, claude, secrets, spend

CAP = ("You have reached your specified workspace API usage limits. You will regain access on "
       "2026-11-01 at 00:00 UTC.")  # measured 2026-10-22/23 on every token call, count_tokens included
ANTHROPIC_IDS = [e.id for e in catalog.ENTRIES if e.provider == "anthropic"]
VERTEX_IDS = [e.id for e in catalog.ENTRIES if e.provider == "vertex"]
GEMINI_IDS = [e.id for e in catalog.ENTRIES if e.provider == "gemini"]


def api_error(status, message, cls=None):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages/count_tokens")
    body = {"type": "error", "error": {"type": "invalid_request_error", "message": message}}
    cls = cls or {400: anthropic.BadRequestError, 401: anthropic.AuthenticationError, 403: anthropic.PermissionDeniedError,
                  404: anthropic.NotFoundError, 429: anthropic.RateLimitError,
                  500: anthropic.InternalServerError}[status]
    return cls(message, response=httpx.Response(status, request=req, json=body), body=body)


def connection_error():
    return anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(anthropic_count=None, vertex_count=None, gemini_list=None, adc=None, clock=None):
    calls = {"anthropic": [], "vertex": [], "gemini": 0}

    def a(model):
        calls["anthropic"].append(model)
        if anthropic_count:
            anthropic_count(model)

    def v(model, project, region):
        calls["vertex"].append((model, project, region))
        if vertex_count:
            vertex_count(model, project, region)

    def g():
        calls["gemini"] += 1
        if callable(gemini_list):
            return gemini_list()
        return {"gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro"}

    avail = catalog.Availability(anthropic_count=a, vertex_count=v, gemini_list=g,
                                 adc=adc or (lambda: {"present": True, "quota_project": "agent-georg"}),
                                 vertex_config=lambda: ("agent-georg", "global"), clock=clock or Clock())
    return avail, calls


def raiser(exc):
    def f(*a):
        raise exc
    return f


# ── the catalog ────────────────────────────────────────────────────

def test_twelve_entries_four_claude_twice_and_four_gemini():
    assert [e.id for e in catalog.ENTRIES] == [
        "anthropic:claude-opus-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5",
        "anthropic:claude-fable-5-1",
        "vertex:claude-opus-5-5", "vertex:claude-sonnet-5-5", "vertex:claude-haiku-5-5", "vertex:claude-fable-5-1",
        "gemini:gemini-3.8-flash", "gemini:gemini-3.7-flash", "gemini:gemini-3.5-flash", "gemini:gemini-3.1-pro-preview"]
    for e in catalog.ENTRIES:
        assert e.id == f"{e.provider}:{e.model}" and e.prices and "2026-10-23" in e.source
    assert catalog.is_known(catalog.DEFAULT_MODEL)


def test_labels_and_groups():
    assert catalog.label("anthropic:claude-opus-5-5") == "Claude Opus 5.5 (Anthropic)"
    assert catalog.label("vertex:claude-fable-5-1") == "Claude Fable 5.1 (Google Cloud)"
    assert catalog.label("gemini:gemini-3.1-pro-preview") == "Gemini 3.1 Pro"
    assert catalog.label("anthropic:claude-opus-4-8") == "claude-opus-4-8"  # a fallback outside the catalog
    assert catalog.get("vertex:claude-opus-5-5").group == "Claude (Google Cloud)"
    assert catalog.get("gemini:gemini-3.8-flash").group == "Gemini"


def test_legacy_bare_ledger_names_normalise_to_catalog_ids():
    assert catalog.normalise("claude-opus-5-5") == "anthropic:claude-opus-5-5"
    assert catalog.normalise("gemini-3.7-flash") == "gemini:gemini-3.7-flash"
    assert catalog.normalise("vertex:claude-opus-5-5") == "vertex:claude-opus-5-5"
    assert catalog.provider_of("unpriced-model") == "unknown"


def test_per_model_params():
    assert catalog.get("anthropic:claude-opus-5-5").params.fallbacks is True
    assert catalog.get("anthropic:claude-haiku-5-5").params.fallbacks is False
    assert not any(catalog.get(i).params.fallbacks for i in VERTEX_IDS)
    assert all(catalog.get(i).params.thinking == "medium" for i in GEMINI_IDS)


def test_the_panel_contract_is_written_at_the_top():
    doc = catalog.__doc__
    for needle in ("GET /models", "PUT /settings/model", "/setup/vertex-login", '"model_id"', '"cost"',
                   "MERGES", "GET /usage"):
        assert needle in doc


def test_the_cap_message():
    assert catalog.cap_message(CAP) == "Workspace limit reached until 1 Nov"
    assert catalog.cap_message("You have reached your specified workspace API usage limits.") == \
        "Workspace limit reached"
    assert catalog.cap_message("max_tokens: too large") is None


# ── probes ─────────────────────────────────────────────────────────

def test_all_ok():
    avail, calls = make()
    states = avail.states()
    assert {i: (s.state, s.message) for i, s in states.items()} == {
        **{i: ("ok", "Ready") for i in ANTHROPIC_IDS}, **{i: ("ok", "Enabled") for i in VERTEX_IDS},
        **{i: ("ok", "Ready") for i in GEMINI_IDS}}
    assert sorted(calls["anthropic"]) == sorted(catalog.get(i).model for i in ANTHROPIC_IDS)
    assert {c[1:] for c in calls["vertex"]} == {("agent-georg", "global")}
    assert calls["gemini"] == 1  # one list for all four


def test_the_measured_workspace_cap_blocks_every_anthropic_model():
    avail, _ = make(anthropic_count=raiser(api_error(400, CAP)))
    states = avail.states()
    for i in ANTHROPIC_IDS:
        assert (states[i].state, states[i].message) == ("blocked", "Workspace limit reached until 1 Nov")
    assert all(states[i].state == "ok" for i in VERTEX_IDS + GEMINI_IDS)


@pytest.mark.parametrize("exc, state, message", [
    (api_error(401, "invalid x-api-key"), "blocked", "Key rejected: check the secret in Settings."),
    (secrets.MissingKeyError("No Anthropic API key is set up."), "setup",
     "No Anthropic key set up yet: finish Setup in Settings."),
    (api_error(404, "model: claude-x"), "blocked", "Not available on this key."),
    (api_error(400, "something else"), "blocked", "Anthropic API error 400: something else"),
])
def test_anthropic_probe_outcomes(exc, state, message):
    avail, _ = make(anthropic_count=raiser(exc))
    s = avail.states()["anthropic:claude-opus-5-5"]
    assert (s.state, s.message) == (state, message)


def test_vertex_without_adc_asks_for_the_sign_in_and_probes_nothing():
    avail, calls = make(adc=lambda: {"present": False, "quota_project": None})
    states = avail.states()
    assert all((states[i].state, states[i].message) == ("setup", "Sign in to Google Cloud for Vertex in Settings.")
               for i in VERTEX_IDS)
    assert calls["vertex"] == []


def test_vertex_without_a_quota_project_asks_to_finish_the_sign_in():
    avail, calls = make(adc=lambda: {"present": True, "quota_project": None})
    s = avail.states()["vertex:claude-opus-5-5"]
    assert s.state == "setup" and "quota project" in s.message and calls["vertex"] == []


def test_vertex_model_not_enabled_says_enable_in_model_garden():
    def count(model, project, region):
        if model == "claude-fable-5-1":
            raise api_error(404, "Publisher Model `claude-fable-5-1` was not found or your project does not have access")

    avail, _ = make(vertex_count=count)
    states = avail.states()
    assert (states["vertex:claude-fable-5-1"].state, states["vertex:claude-fable-5-1"].message) == \
        ("setup", "Enable in Model Garden")
    assert states["vertex:claude-opus-5-5"].state == "ok"


def test_a_google_auth_error_on_vertex_asks_to_sign_in_again():
    from google.auth import exceptions as gexc
    avail, _ = make(vertex_count=raiser(gexc.RefreshError("Reauthentication is needed.")))
    s = avail.states()["vertex:claude-opus-5-5"]
    assert s.state == "setup" and "Sign in" in s.message


def test_gemini_listed_and_unlisted_models():
    avail, _ = make(gemini_list=lambda: {"gemini-3.8-flash"})
    states = avail.states()
    assert states["gemini:gemini-3.8-flash"].state == "ok"
    assert (states["gemini:gemini-3.7-flash"].state, states["gemini:gemini-3.7-flash"].message) == \
        ("blocked", "Not offered to this Gemini key.")


@pytest.mark.parametrize("exc, state", [
    (secrets.MissingKeyError("no key"), "setup"),
    (catalog.GeminiListError(400, "API key not valid. Please pass a valid API key."), "blocked"),
])
def test_gemini_key_problems(exc, state):
    avail, _ = make(gemini_list=raiser(exc))
    assert all(avail.states()[i].state == state for i in GEMINI_IDS)


def test_an_entry_without_a_price_is_setup_price_unknown(monkeypatch):
    entries = list(catalog.ENTRIES)
    entries[9] = dataclasses.replace(entries[9], prices=())
    monkeypatch.setattr(catalog, "ENTRIES", tuple(entries))
    avail, calls = make()
    s = avail.states()[entries[9].id]
    assert (s.state, s.message) == ("setup", "price unknown")


def test_a_probe_that_crashes_shows_blocked_not_a_500():
    avail, _ = make(gemini_list=raiser(RuntimeError("bug")))
    s = avail.states()["gemini:gemini-3.8-flash"]
    assert s.state == "blocked" and "check failed" in s.message


# ── cache and refresh ──────────────────────────────────────────────

def test_results_are_cached_ten_minutes_and_refresh_reprobes():
    clock = Clock()
    avail, calls = make(clock=clock)
    avail.states()
    avail.states()
    assert len(calls["anthropic"]) == 4 and calls["gemini"] == 1
    clock.t += 599
    avail.states()
    assert calls["gemini"] == 1
    clock.t += 2
    avail.states()
    assert calls["gemini"] == 2 and len(calls["anthropic"]) == 8
    avail.states(refresh=True)
    assert calls["gemini"] == 3 and len(calls["vertex"]) == 12


def test_a_network_blip_is_shown_once_but_not_cached():
    avail, calls = make(anthropic_count=raiser(connection_error()))
    s = avail.states()["anthropic:claude-opus-5-5"]
    assert s.state == "blocked" and "reach" in s.message
    avail.states()
    assert len(calls["anthropic"]) == 8  # probed again


def test_invalidate_one_provider():
    avail, calls = make()
    avail.states()
    avail.invalidate("vertex")
    avail.states()
    assert len(calls["vertex"]) == 8 and len(calls["anthropic"]) == 4


# ── a real call's error updates the picker ─────────────────────────

def test_a_real_cap_error_blocks_every_anthropic_model_until_it_expires():
    avail, calls = make()
    avail.states()
    avail.observe("anthropic:claude-sonnet-5-5", api_error(400, CAP))
    states = avail.states()
    assert all(states[i].message == "Workspace limit reached until 1 Nov" for i in ANTHROPIC_IDS)
    assert len(calls["anthropic"]) == 4  # from the call, not a new probe


def test_an_ordinary_request_error_does_not_grey_out_the_model():
    avail, _ = make()
    avail.states()
    avail.observe("anthropic:claude-opus-5-5", api_error(400, "messages: text content blocks must be non-empty"))
    avail.observe("anthropic:claude-opus-5-5", connection_error())
    assert avail.states()["anthropic:claude-opus-5-5"].state == "ok"


def test_a_real_vertex_error_model_garden_is_per_model_but_sign_in_is_shared():
    from google.auth import exceptions as gexc
    avail, _ = make()
    avail.states()
    avail.observe("vertex:claude-haiku-5-5", api_error(404, "Publisher Model claude-haiku-5-5 was not found"))
    states = avail.states()
    assert states["vertex:claude-haiku-5-5"].message == "Enable in Model Garden"
    assert states["vertex:claude-opus-5-5"].state == "ok"
    avail.observe("vertex:claude-opus-5-5", gexc.RefreshError("expired"))
    assert all(avail.states()[i].state == "setup" for i in VERTEX_IDS)
    assert all(avail.states()[i].state == "ok" for i in ANTHROPIC_IDS)


def test_claude_reports_a_real_cap_error_to_the_catalog(monkeypatch):
    avail, _ = make()
    monkeypatch.setattr(catalog, "_availability", avail)
    monkeypatch.setenv("GENIUSCUT_LLM_PROVIDER", "anthropic")

    def create(**kw):
        raise api_error(400, CAP)

    fake = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    with pytest.raises(claude.ClaudeError, match="usage limits"):
        claude.ask_json("hi", {"type": "object"}, client=fake)
    assert avail.states()["anthropic:claude-opus-5-5"].message == "Workspace limit reached until 1 Nov"


# ── the default probes, with fake clients ──────────────────────────

class CountClient:
    def __init__(self, count_exc=None, **kw):
        self.kw, self.count_exc, self.created = kw, count_exc, []
        self.messages = SimpleNamespace(count_tokens=self._count, create=self._create)

    def _count(self, **kw):
        if self.count_exc:
            raise self.count_exc
        return SimpleNamespace(input_tokens=8)

    def _create(self, **kw):
        self.created.append(kw)
        return SimpleNamespace(usage=SimpleNamespace(input_tokens=8, output_tokens=1))


def test_default_anthropic_probe_is_count_tokens_with_the_key_read_once_per_round(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr(catalog, "_key_memo", None)
    reads = []
    real = secrets.anthropic_api_key
    monkeypatch.setattr(secrets, "anthropic_api_key", lambda: reads.append(1) or real())
    made = []

    def make_client(**kw):
        made.append(CountClient(**kw))
        return made[-1]

    catalog._default_anthropic_count("claude-opus-5-5", make_client=make_client)
    catalog._default_anthropic_count("claude-haiku-5-5", make_client=make_client)
    assert made[0].kw["api_key"] == "sk-ant-test" and made[0].created == [] and len(reads) == 1


def test_default_vertex_probe_counts_tokens_for_free():
    made = []

    def make_client(**kw):
        made.append(CountClient(**kw))
        return made[-1]

    catalog._default_vertex_count("claude-opus-5-5", "agent-georg", "global", make_client=make_client)
    assert made[0].kw["project_id"] == "agent-georg" and made[0].kw["region"] == "global"
    assert made[0].created == [] and not spend.ledger_path().exists()


def test_default_vertex_probe_falls_back_to_one_token_when_count_tokens_isnt_served():
    made = []

    def make_client(**kw):
        made.append(CountClient(count_exc=api_error(404, "count-tokens is not supported for this model"), **kw))
        return made[-1]

    catalog._default_vertex_count("claude-opus-5-5", "agent-georg", "global", make_client=make_client)
    assert made[0].created[0]["max_tokens"] == 1
    row = json.loads(spend.ledger_path().read_text(encoding="utf-8").splitlines()[0])
    assert (row["model"], row["provider"], row["kind"]) == ("vertex:claude-opus-5-5", "vertex", "probe")
    assert row["usd"] == pytest.approx((8 * 4.00 + 1 * 20.00) / 1e6)


def test_default_vertex_probe_doesnt_fall_back_when_the_model_is_missing():
    def make_client(**kw):
        return CountClient(count_exc=api_error(404, "Publisher Model claude-opus-5-5 was not found"), **kw)

    with pytest.raises(anthropic.NotFoundError):
        catalog._default_vertex_count("claude-opus-5-5", "agent-georg", "global", make_client=make_client)


def test_default_gemini_list_pages_and_keeps_the_key_in_the_header(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", "AIza-test")
    seen = []
    pages = [{"models": [{"name": "models/gemini-3.8-flash"}], "nextPageToken": "p2"},
             {"models": [{"name": "models/gemini-3.1-pro-preview"}]}]

    def urlopen(req, timeout=None):
        seen.append(req)
        return io.BytesIO(json.dumps(pages[len(seen) - 1]).encode())

    assert catalog._default_gemini_list(urlopen=urlopen) == {"gemini-3.8-flash", "gemini-3.1-pro-preview"}
    assert all("AIza" not in r.full_url for r in seen) and seen[0].get_header("X-goog-api-key") == "AIza-test"
    assert "pageToken=p2" in seen[1].full_url


def test_default_gemini_list_errors_never_carry_the_key(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", "AIza-test")

    def urlopen(req, timeout=None):
        body = json.dumps({"error": {"message": "API key not valid: AIza-test"}}).encode()
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(body))

    with pytest.raises(catalog.GeminiListError) as e:
        catalog._default_gemini_list(urlopen=urlopen)
    assert "AIza-test" not in str(e.value) and catalog.classify_gemini(e.value).message == \
        "The Gemini key was rejected."


def test_read_adc(tmp_path, monkeypatch):
    path = tmp_path / "adc.json"
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", str(path))
    assert catalog.read_adc() == {"present": False, "quota_project": None}
    path.write_text(json.dumps({"type": "authorized_user", "quota_project_id": "agent-georg"}))
    assert catalog.read_adc() == {"present": True, "quota_project": "agent-georg"}
    path.write_text(json.dumps({"type": "authorized_user"}))
    assert catalog.read_adc() == {"present": True, "quota_project": None}


# ── the listing ────────────────────────────────────────────────────

def test_listing_shape():
    from datetime import date
    avail, _ = make(anthropic_count=raiser(api_error(400, CAP)))
    body = catalog.listing(avail, "gemini:gemini-3.8-flash", on=date(2026, 10, 23))
    assert body["selected"] == "gemini:gemini-3.8-flash" and len(body["models"]) == 12
    opus = body["models"][0]
    assert opus == {"id": "anthropic:claude-opus-5-5", "label": "Claude Opus 5.5 (Anthropic)", "provider": "anthropic",
                    "group": "Claude (Anthropic key)", "price": {"input": 4.00, "output": 20.00},
                    "usd_per_minute": pytest.approx(spend.estimate_per_minute("anthropic:claude-opus-5-5")),
                    "state": "blocked", "message": "Workspace limit reached until 1 Nov"}
    assert body["vertex"] == {"project": "agent-georg", "region": "global", "adc": True, "quota_project": "agent-georg"}
