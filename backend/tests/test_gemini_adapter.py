"""GeminiAdapter (model picker plan Task 3): Gemini function calling behind the neutral step contract, through a
fake generateContent transport. No network, no paid calls."""

import copy
import json

import pytest

from geniuscut import adapters, agent, catalog, gemini, secrets, settings, spend
from geniuscut.errors import LLMError
from tests.test_agent import SELECTION, SEQUENCE
from tests.test_agent_graphics import CONTEXT, HTML, FakeEngine

KEY = "AIza-test-key-not-real"
FLASH = "gemini:gemini-3.8-flash"


@pytest.fixture(autouse=True)
def _gemini_selected(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_GEMINI_API_KEY", KEY)
    s = settings.load()
    s.model = FLASH
    settings.save(s)


def fc(name, args=None, id_=None, sig=None):
    part = {"functionCall": {"name": name, "args": args or {}, **({"id": id_} if id_ else {})}}
    if sig:
        part["thoughtSignature"] = sig
    return part


def say(t, sig=None, thought=False):
    part = {"text": t}
    if thought:
        part["thought"] = True
    if sig:
        part["thoughtSignature"] = sig
    return part


def answer(*parts, finish="STOP", usage=None, **extra):
    body = {"candidates": [{"content": {"role": "model", "parts": list(parts)}, "finishReason": finish}],
            "usageMetadata": usage or {"promptTokenCount": 1000, "candidatesTokenCount": 200,
                                       "thoughtsTokenCount": 300}}
    body.update(extra)
    return body


class Transport:
    """Scripted generateContent replies, in order; records a deep copy of every request."""

    def __init__(self, *replies):
        self.replies, self.calls = list(replies), []

    def __call__(self, url, body, headers):
        self.calls.append({"url": url, "body": copy.deepcopy(body), "headers": headers})
        if not self.replies:
            raise AssertionError("no scripted reply left")
        nxt = self.replies.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def adapter():
    return adapters.for_entry(catalog.get(FLASH))


def client(t):
    return gemini.Client(KEY, t)


def ledger():
    return [json.loads(x) for x in spend.ledger_path().read_text(encoding="utf-8").splitlines()]


# ── wiring ─────────────────────────────────────────────────────────

def test_gemini_entries_get_the_gemini_adapter_and_its_client_reads_the_key_once():
    a = adapter()
    assert isinstance(a, adapters.GeminiAdapter) and adapters.ADAPTERS["gemini"] is adapters.GeminiAdapter
    c = a.make_client()
    assert isinstance(c, gemini.Client) and c.key == KEY and KEY not in repr(c)
    assert not hasattr(adapters, "GEMINI_SOON")


def test_no_key_raises_missing_key(monkeypatch):
    monkeypatch.delenv("GENIUSCUT_GEMINI_API_KEY")
    monkeypatch.setattr(secrets, "gemini_api_key", lambda *a, **k: (_ for _ in ()).throw(secrets.MissingKeyError("no key")))
    with pytest.raises(secrets.MissingKeyError):
        adapter().make_client()


# ── request shape ──────────────────────────────────────────────────

def test_request_shape_tools_as_json_schema_thinking_medium_and_key_header():
    t = Transport(answer(say("1. Plan.")))
    a = adapter()
    a.add_user_text("Do it")
    step = a.step("SYS", agent.TOOLS, client=client(t), input_tokens=500)
    assert step.stop == "end" and step.text == "1. Plan."
    call = t.calls[0]
    assert call["url"].endswith("/models/gemini-3.8-flash:generateContent")
    assert call["headers"]["x-goog-api-key"] == KEY and KEY not in call["url"]
    body = call["body"]
    assert body["systemInstruction"] == {"parts": [{"text": "SYS"}]}
    assert body["contents"][0] == {"role": "user", "parts": [{"text": "Do it"}]}
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}}
    assert body["generationConfig"] == {"maxOutputTokens": 32000, "thinkingConfig": {"thinkingLevel": "medium"}}
    decls = body["tools"][0]["functionDeclarations"]
    assert [d["name"] for d in decls] == [x["name"] for x in agent.TOOLS]
    for d, x in zip(decls, agent.TOOLS):
        assert d == {"name": x["name"], "description": x["description"], "parametersJsonSchema": x["input_schema"]}
        assert "parameters" not in d


def test_make_graphic_variables_keep_their_schema():
    """parametersJsonSchema takes JSON Schema whole: `variables` stays an object of string|number|boolean values
    (never collapses to an empty object), and additionalProperties: false on the tool itself survives."""
    t = Transport(answer(say("ok")))
    a = adapter()
    a.add_user_text("x")
    a.step("s", agent.TOOLS, client=client(t), input_tokens=1)
    decl = next(d for d in t.calls[0]["body"]["tools"][0]["functionDeclarations"] if d["name"] == "make_graphic")
    schema = decl["parametersJsonSchema"]
    assert schema["properties"]["variables"] == {
        "type": "object", "additionalProperties": {"type": ["string", "number", "boolean"]},
        "description": "Optional values for the composition's declared variables, by id."}
    assert schema["additionalProperties"] is False


def test_analyse_keeps_thinking_low():
    t = Transport(answer(say('{"ok": true}')))
    gemini.ask_json("p", {"type": "object"}, model="gemini-3.8-flash", client=t)
    assert t.calls[0]["body"]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}


def test_no_tools_means_no_tools_field():
    t = Transport(answer(say("hi")))
    a = adapter()
    a.add_user_text("x")
    a.step("s", [], client=client(t), input_tokens=1)
    assert "tools" not in t.calls[0]["body"] and "toolConfig" not in t.calls[0]["body"]


# ── tool calls ─────────────────────────────────────────────────────

def test_parallel_calls_without_ids_get_synthetic_ids_and_one_response_each_in_order():
    content_parts = [say("thinking...", thought=True, sig="S0"), say("Reading."),
                     fc("get_sequence", sig="S1"), fc("get_transcript", {"clipId": "a"}), fc("get_transcript", {"clipId": "b"})]
    t = Transport(answer(*content_parts), answer(say("Done.")))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", agent.TOOLS, client=client(t), input_tokens=1)
    assert step.stop == "tool_use" and step.text == "Reading."  # the thought part never reaches the text
    assert step.tool_calls == [{"id": "g1_0", "name": "get_sequence", "input": {}},
                               {"id": "g1_1", "name": "get_transcript", "input": {"clipId": "a"}},
                               {"id": "g1_2", "name": "get_transcript", "input": {"clipId": "b"}}]
    # the whole model content, thought signatures included, unchanged
    assert a.history[-1] == {"role": "model", "parts": content_parts}
    a.add_tool_results([adapters.ToolResult("g1_0", "seq"), adapters.ToolResult("g1_1", "words a"),
                        adapters.ToolResult("g1_2", "boom", is_error=True)])
    assert a.history[-1] == {"role": "user", "parts": [
        {"functionResponse": {"name": "get_sequence", "response": {"result": "seq"}}},
        {"functionResponse": {"name": "get_transcript", "response": {"result": "words a"}}},
        {"functionResponse": {"name": "get_transcript", "response": {"error": "boom"}}}]}
    step2 = a.step("s", agent.TOOLS, client=client(t), input_tokens=1)
    assert step2.stop == "end" and step2.text == "Done."
    sent = t.calls[1]["body"]["contents"]
    assert sent[1] == {"role": "model", "parts": content_parts} and sent[2] == a.history[2]


def test_calls_with_gemini_ids_keep_them_and_send_them_back():
    t = Transport(answer(fc("get_sequence", id_="call_1", sig="S"), fc("add_markers", {"m": 1}, id_="call_2")))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", agent.TOOLS, client=client(t), input_tokens=1)
    assert [c["id"] for c in step.tool_calls] == ["call_1", "call_2"]
    a.add_tool_results([adapters.ToolResult("call_1", "a"), adapters.ToolResult("call_2", "b")])
    assert a.history[-1]["parts"] == [
        {"functionResponse": {"id": "call_1", "name": "get_sequence", "response": {"result": "a"}}},
        {"functionResponse": {"id": "call_2", "name": "add_markers", "response": {"result": "b"}}}]


def test_synthetic_ids_are_unique_across_steps():
    t = Transport(answer(fc("get_sequence")), answer(fc("get_sequence")))
    a = adapter()
    a.add_user_text("x")
    first = a.step("s", [], client=client(t), input_tokens=1).tool_calls[0]["id"]
    a.add_tool_results([adapters.ToolResult(first, "r")])
    second = a.step("s", [], client=client(t), input_tokens=1).tool_calls[0]["id"]
    assert (first, second) == ("g1_0", "g2_0")


def test_a_result_for_an_unknown_call_is_refused():
    a = adapter()
    with pytest.raises(LLMError, match="nope"):
        a.add_tool_results([adapters.ToolResult("nope", "x")])


# ── stops ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("finish", ["SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST", "SPII"])
def test_a_safety_finish_is_a_refusal_and_not_appended(finish):
    t = Transport(answer(say("no"), finish=finish))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1)
    assert (step.stop, step.detail, step.tool_calls, len(a.history)) == ("refusal", finish, [], 1)


def test_a_blocked_prompt_is_a_refusal():
    t = Transport({"promptFeedback": {"blockReason": "SAFETY"},
                   "usageMetadata": {"promptTokenCount": 10}})
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1)
    assert (step.stop, step.detail, len(a.history), len(t.calls)) == ("refusal", "SAFETY", 1, 1)


def test_max_tokens_is_not_appended_even_with_a_call():
    t = Transport(answer(fc("cut_ranges", {"x": 1}), finish="MAX_TOKENS"))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1)
    assert (step.stop, step.tool_calls, len(a.history)) == ("max_tokens", [], 1)


@pytest.mark.parametrize("finish", ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL"])
def test_a_malformed_call_is_retried_once_inside_the_step(finish):
    t = Transport(answer(finish=finish), answer(fc("get_sequence")))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1, max_requests=5)
    assert step.stop == "tool_use" and step.requests == 2 and len(t.calls) == 2
    assert t.calls[1]["body"]["contents"] == t.calls[0]["body"]["contents"]  # the failed reply isn't in it
    assert len(a.history) == 2


def test_a_malformed_call_twice_is_an_error():
    t = Transport(answer(finish="MALFORMED_FUNCTION_CALL"), answer(finish="MALFORMED_FUNCTION_CALL"))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1, max_requests=5)
    assert step.stop == "error" and "MALFORMED_FUNCTION_CALL" in step.detail and step.requests == 2
    assert len(a.history) == 1 and len(t.calls) == 2


def test_an_empty_reply_is_retried_once_and_never_a_plan():
    t = Transport(answer(say("", thought=True)), answer(say("1. The plan.")))
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1, max_requests=5)
    assert step.stop == "end" and step.text == "1. The plan." and step.requests == 2

    t = Transport(answer(say("   ")), {"candidates": []})
    a = adapter()
    a.add_user_text("x")
    step = a.step("s", [], client=client(t), input_tokens=1, max_requests=5)
    assert step.stop == "error" and step.requests == 2 and len(a.history) == 1


def test_a_retry_past_the_step_cap_is_out_of_steps():
    t = Transport(answer(finish="MALFORMED_FUNCTION_CALL"))
    a = adapter()
    a.add_user_text("x")
    with pytest.raises(adapters.OutOfSteps):
        a.step("s", [], client=client(t), input_tokens=1, max_requests=1)


def test_envato_is_ignored():
    t = Transport(answer(say("ok")))
    a = adapter()
    a.add_user_text("x")
    assert a.step("s", [], client=client(t), input_tokens=1, envato=True).stop == "end"
    assert "mcp_servers" not in t.calls[0]["body"]


# ── usage and spend ────────────────────────────────────────────────

def test_usage_and_spend_are_recorded_under_the_gemini_catalog_id():
    t = Transport(answer(say("ok"), usage={"promptTokenCount": 1000, "cachedContentTokenCount": 400,
                                           "candidatesTokenCount": 200, "thoughtsTokenCount": 300}))
    a = adapter()
    a.add_user_text("x")
    with spend.meter(kind="agent") as m:
        step = a.step("s", [], client=client(t), input_tokens=1)
    assert step.usage == adapters.Usage(1000, 500) and step.model == FLASH
    row = ledger()[-1]
    assert row["model"] == FLASH and row["provider"] == "gemini" and "priced_as" not in row
    assert row["input_tokens"] == 600 and row["cache_read_tokens"] == 400 and row["output_tokens"] == 500
    assert row["usd"] == pytest.approx(spend.cost_usd(FLASH, 600, 500, cache_read=400))
    assert m.input_tokens == 1000 and m.output_tokens == 500


def test_every_retried_call_is_billed():
    t = Transport(answer(finish="MALFORMED_FUNCTION_CALL"), answer(say("ok")))
    a = adapter()
    a.add_user_text("x")
    a.step("s", [], client=client(t), input_tokens=1, max_requests=3)
    assert [r["model"] for r in ledger()] == [FLASH, FLASH]


def test_the_long_prompt_tier_is_priced_for_3_1_pro():
    pro = "gemini:gemini-3.1-pro-preview"
    t = Transport(answer(say("ok"), usage={"promptTokenCount": 250_000, "candidatesTokenCount": 1000}))
    a = adapters.for_entry(catalog.get(pro))
    a.add_user_text("x")
    a.step("s", [], client=client(t), input_tokens=1)
    row = ledger()[-1]
    assert row["model"] == pro and row["usd"] == pytest.approx((250_000 * 4.00 + 1000 * 18.00) / 1e6)


def test_the_gate_refuses_before_the_call(monkeypatch):
    monkeypatch.setenv("GENIUSCUT_MONTHLY_LIMIT_USD", "0.01")
    t = Transport(answer(say("ok")))
    a = adapter()
    a.add_user_text("x")
    with pytest.raises(spend.BudgetExceeded):
        a.step("s", [], client=client(t), input_tokens=100_000)
    assert t.calls == []


def test_a_rejected_key_is_key_rejected():
    import io
    import urllib.error
    payload = json.dumps({"error": {"code": 400, "message": "API key not valid. Please pass a valid API key."}})
    err = urllib.error.HTTPError("https://x", 400, "bad", {}, io.BytesIO(payload.encode()))
    a = adapter()
    a.add_user_text("x")
    with pytest.raises(gemini.KeyRejected):
        a.step("s", [], client=client(Transport(err)), input_tokens=1)


# ── through the agent loop ─────────────────────────────────────────

def runs(t, engine=None):
    return agent.Runs(make_client=lambda: client(t), engine=engine or FakeEngine())


def test_plan_then_approve_then_act_then_done_on_gemini():
    t = Transport(
        answer(say("1. Add a marker at 0:12.", sig="P")),
        answer(fc("add_markers", {"sequenceId": "seq-1", "markers": [{"atS": 12, "name": "P"}]}, sig="A")),
        answer(say("Added 1 marker.")),
    )
    r = runs(t)
    first = r.start("Add a marker at every product mention", SELECTION, SEQUENCE)
    assert first["state"] == "plan" and first["text"] == "1. Add a marker at 0:12."
    assert first["cost"]["model"] == FLASH and first["cost"]["label"] == "Gemini 3.8 Flash"
    second = r.approve(first["run_id"])
    assert second["state"] == "tool_calls"
    assert second["tool_calls"] == [{"id": "g2_0", "name": "add_markers",
                                     "input": {"sequenceId": "seq-1", "markers": [{"atS": 12, "name": "P"}]}}]
    assert t.calls[1]["body"]["contents"][-1] == {"role": "user", "parts": [{"text": agent.APPROVED}]}
    done = r.results(first["run_id"], [{"tool_use_id": "g2_0", "content": '{"ids": ["m1"]}'}])
    assert done["state"] == "done" and done["text"] == "Added 1 marker."
    contents = t.calls[2]["body"]["contents"]
    assert [c["role"] for c in contents] == ["user", "model", "user", "model", "user"]
    assert contents[3]["parts"][0]["thoughtSignature"] == "A"
    assert contents[4] == {"role": "user", "parts": [{"functionResponse": {
        "name": "add_markers", "response": {"result": '{"ids": ["m1"]}'}}}]}
    assert {row["model"] for row in ledger()} == {FLASH}


def test_make_graphic_variables_reach_the_engine_on_gemini():
    args = {"slug": "lt", "kind": "lower-third", "duration_s": 4, "html": HTML,
            "variables": {"name": "Peter", "size": 3, "dark": True}}
    t = Transport(answer(say("1. A lower third.")), answer(fc("make_graphic", args)), answer(say("Made it.")))
    engine = FakeEngine()
    r = runs(t, engine)
    first = r.start("lower third", SELECTION, SEQUENCE, CONTEXT)
    done = r.approve(first["run_id"])
    assert done["state"] == "done" and engine.calls[0]["variables"] == {"name": "Peter", "size": 3, "dark": True}
    part = t.calls[2]["body"]["contents"][-1]["parts"][0]["functionResponse"]
    assert part["name"] == "make_graphic" and "result" in part["response"]


def test_a_gemini_refusal_ends_the_run_with_the_label():
    t = Transport(answer(say("no"), finish="SAFETY"))
    r = runs(t).start("x", SELECTION, SEQUENCE)
    assert r["reason"] == "refusal" and r["message"] == "Gemini 3.8 Flash declined this instruction (SAFETY)."


def test_an_empty_reply_twice_stops_the_run_as_an_error_not_a_plan():
    t = Transport(answer(), answer())
    r = runs(t).start("x", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "error"
    assert r["message"].startswith("Gemini 3.8 Flash returned no usable reply")


def test_a_missing_gemini_key_stops_the_run_as_a_key_problem(monkeypatch):
    monkeypatch.setattr(secrets, "gemini_api_key",
                        lambda *a, **k: (_ for _ in ()).throw(secrets.MissingKeyError("No Gemini key.")))
    r = agent.Runs().start("x", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "key"


def test_a_rejected_gemini_key_stops_the_run_as_a_key_problem():
    import io
    import urllib.error
    payload = json.dumps({"error": {"code": 400, "message": "API key not valid."}}).encode()
    t = Transport(urllib.error.HTTPError("https://x", 400, "bad", {}, io.BytesIO(payload)))
    r = runs(t).start("x", SELECTION, SEQUENCE)
    assert r["state"] == "stopped" and r["reason"] == "key" and KEY not in r["message"]
