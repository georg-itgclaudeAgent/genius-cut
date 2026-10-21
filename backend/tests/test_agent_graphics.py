"""Backend-run graphics tools in the agent loop (motion graphics plan task 3): fake Claude, fake engine."""

import json
import threading

import pytest
from fastapi.testclient import TestClient

from geniuscut import agent, config, graphics
from server import create_app
from tests.test_agent import SELECTION, SEQUENCE, FakeClient, reply, text, tool

PROJECT = "C:/Edits/Show/Show.prproj"
CONTEXT = {"projectPath": PROJECT, "timebase": "8467200000", "width": 3840, "height": 2160}
HTML = '<div id="root" data-composition-id="main"></div>'


def made(slug, n, d=4.0):
    base = f"C:/Edits/Show/Genius Cut Graphics/{slug}/v{n}"
    return {"ok": True, "slug": slug, "version": n, "path": f"{base}/{slug}.mov", "preview": f"{base}/preview.png",
            "html": f"{base}/index.html", "duration_s": d, "renderSeconds": 12.5, "warnings": []}


FAILED = {"ok": False, "stage": "check", "errors": ["lint gsap_animates_clip_element: Don't tween a clip. (#t)"],
          "warnings": ["lint text_small: Text is small (#t)"]}


class FakeEngine:
    """make() answers from a script: a dict, an exception, or a callable(kwargs) -> dict."""

    def __init__(self, *outcomes):
        self.outcomes, self.calls, self.reads = list(outcomes), [], []
        self.versions = {}

    def make(self, **kw):
        self.calls.append(kw)
        nxt = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(nxt, Exception):
            raise nxt
        if callable(nxt):
            return nxt(kw)
        if nxt is None:
            n = self.versions[kw["slug"]] = self.versions.get(kw["slug"], 0) + 1
            return made(kw["slug"], n, kw["duration_s"])
        return nxt

    def read(self, project_path, slug):
        self.reads.append((project_path, slug))
        if slug == "missing":
            raise graphics.GraphicsError("No graphic 'missing' in this project's \"Genius Cut Graphics\" folder.")
        return {"slug": slug, "starter": True, "kind": "lower-third", "html": "<starter/>"}


def mk(id_, slug="mfa-lower-third", d=4):
    return tool(id_, "make_graphic", {"slug": slug, "kind": "lower-third", "duration_s": d, "html": HTML})


def runs(fake, engine):
    return agent.Runs(make_client=lambda: fake, engine=engine)


def ok(id_, content="ok"):
    return {"tool_use_id": id_, "content": content, "is_error": False}


def last_user(fake, call=-1):
    return fake.calls[call]["messages"][-1]["content"]


# ── tools ──────────────────────────────────────────────────────────

def _schema(name):
    return next(t for t in agent.TOOLS if t["name"] == name)["input_schema"]


def test_graphics_tools_kinds_and_schemas():
    assert agent.TOOL_KINDS["make_graphic"] == agent.TOOL_KINDS["read_graphic"] == "backend"
    assert agent.TOOL_KINDS["place_graphic"] == agent.TOOL_KINDS["replace_graphic"] == "act"
    s = _schema("make_graphic")
    assert sorted(s["properties"]) == ["duration_s", "html", "kind", "previewAtS", "slug", "variables"]
    assert sorted(s["required"]) == ["duration_s", "html", "kind", "slug"]
    assert s["properties"]["kind"]["enum"] == ["lower-third", "callout", "card", "explainer-scene"]
    assert (s["properties"]["duration_s"]["minimum"], s["properties"]["duration_s"]["maximum"]) == (0.5, 20.0)
    assert _schema("read_graphic")["required"] == ["slug"] and list(_schema("read_graphic")["properties"]) == ["slug"]
    assert sorted(_schema("place_graphic")["required"]) == ["atS", "path", "sequenceId"]
    assert sorted(_schema("replace_graphic")["required"]) == ["clipId", "path", "sequenceId"]
    for name in ("make_graphic", "read_graphic", "place_graphic", "replace_graphic"):
        assert _schema(name)["additionalProperties"] is False


def test_the_system_prompt_covers_graphics():
    s = " ".join(agent.SYSTEM.split())
    for phrase in ("read_graphic \"starter-<kind>\"", "One make_graphic per reply", "after 3 failures",
                   "Timing from the transcript", "#112A33", "120 px safe margins", "at least 30 px",
                   "every graphic animates out", "place_graphic", "replace_graphic", "the user selects the graphic clip",
                   "(preview above)", "no scribbles", "Full screen means the whole frame", "edge to edge",
                   "never as the frame's outline", "at least 64 px", "at least 34 px", "at least 96 px",
                   "Before each make_graphic, check your own HTML"):
        assert phrase in s, phrase


# ── the loop contract ──────────────────────────────────────────────

def test_a_mixed_reply_sends_only_panel_tools_and_merges_results_in_order():
    fake = FakeClient(reply(text("Rendering."), mk("t1"), tool("t2", "get_sequence"), stop="tool_use"),
                      reply(text("plan"), stop="end_turn"))
    engine = FakeEngine()
    r = runs(fake, engine)
    first = r.start("lower third", SELECTION, SEQUENCE, CONTEXT)
    assert first["state"] == "tool_calls"
    assert first["tool_calls"] == [{"id": "t2", "name": "get_sequence", "input": {}}]  # never the backend tool
    assert first["graphics"] == [{"slug": "mfa-lower-third", "version": 1, "duration_s": 4,
                                  "path": "C:/Edits/Show/Genius Cut Graphics/mfa-lower-third/v1/mfa-lower-third.mov",
                                  "preview": "C:/Edits/Show/Genius Cut Graphics/mfa-lower-third/v1/preview.png"}]
    assert r._runs[first["run_id"]].waiting == ["t2"]
    body = r.results(first["run_id"], [ok("t2", "seq")])
    assert body["state"] == "plan" and len(engine.calls) == 1
    blocks = last_user(fake)
    assert [b["tool_use_id"] for b in blocks] == ["t1", "t2"]  # the reply's tool_use order
    assert blocks[1] == {"type": "tool_result", "tool_use_id": "t2", "content": "seq", "is_error": False}
    out = json.loads(blocks[0]["content"])
    assert blocks[0]["is_error"] is False
    assert out == {"slug": "mfa-lower-third", "version": 1, "duration_s": 4, "renderSeconds": 12.5, "warnings": [],
                   "path": "C:/Edits/Show/Genius Cut Graphics/mfa-lower-third/v1/mfa-lower-third.mov",
                   "preview": "C:/Edits/Show/Genius Cut Graphics/mfa-lower-third/v1/preview.png"}


def test_merge_order_follows_the_reply_when_the_panel_tool_comes_first():
    fake = FakeClient(reply(tool("t1", "get_transcript", {"clipIds": ["a"]}), tool("t2", "read_graphic",
                                                                                   {"slug": "starter-callout"}),
                            tool("t3", "get_sequence"), stop="tool_use"),
                      reply(text("plan"), stop="end_turn"))
    r = runs(fake, FakeEngine())
    first = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    assert [c["id"] for c in first["tool_calls"]] == ["t1", "t3"]
    r.results(first["run_id"], [ok("t3"), ok("t1")])
    assert [b["tool_use_id"] for b in last_user(fake)] == ["t1", "t2", "t3"]
    assert json.loads(last_user(fake)[1]["content"])["html"] == "<starter/>"


def test_the_panel_cant_answer_a_backend_tool():
    fake = FakeClient(reply(mk("t1"), tool("t2", "get_sequence"), stop="tool_use"))
    r = runs(fake, FakeEngine())
    first = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    with pytest.raises(agent.RunError) as e:
        r.results(first["run_id"], [ok("t1"), ok("t2")])
    assert e.value.status == 422 and "unknown: t1" in str(e.value)


def test_a_backend_only_reply_steps_again_without_the_panel():
    fake = FakeClient(reply(tool("t1", "read_graphic", {"slug": "starter-lower-third"}), stop="tool_use"),
                      reply(mk("t2"), stop="tool_use"),
                      reply(text("1. Lower third 'Turn on MFA', 4 s at 1:12 (preview above)."), stop="end_turn"))
    engine = FakeEngine()
    r = runs(fake, engine)
    body = r.start("lower third", SELECTION, SEQUENCE, CONTEXT)
    assert body["state"] == "plan" and "preview above" in body["text"]
    assert len(fake.calls) == 3 and engine.reads == [(PROJECT, "starter-lower-third")]
    assert [b["tool_use_id"] for b in last_user(fake, 1)] == ["t1"]
    assert [b["tool_use_id"] for b in last_user(fake, 2)] == ["t2"]
    assert body["graphics"][0]["slug"] == "mfa-lower-third"
    assert r._runs[body["run_id"]].steps == 3  # counted toward the 25-step cap


def test_backend_only_steps_count_toward_the_cap():
    fake = FakeClient(*[reply(tool(f"t{i}", "read_graphic", {"slug": "starter-card"}), stop="tool_use")
                        for i in range(30)])
    body = runs(fake, FakeEngine()).start("x", SELECTION, SEQUENCE, CONTEXT)
    assert body["state"] == "stopped" and body["reason"] == "step_cap" and len(fake.calls) == agent.MAX_STEPS


def test_a_second_make_graphic_in_one_reply_is_an_error_result():
    fake = FakeClient(reply(mk("t1", "one"), mk("t2", "two"), stop="tool_use"), reply(text("plan"), stop="end_turn"))
    engine = FakeEngine()
    body = runs(fake, engine).start("two graphics", SELECTION, SEQUENCE, CONTEXT)
    assert body["state"] == "plan" and [c["slug"] for c in engine.calls] == ["one"]
    second = last_user(fake)[1]
    assert second == {"type": "tool_result", "tool_use_id": "t2", "is_error": True, "content": agent.ONE_GRAPHIC}
    assert [g["slug"] for g in body["graphics"]] == ["one"]


def test_check_errors_go_back_to_claude_and_the_third_failure_stops_the_run():
    fake = FakeClient(reply(mk("t1"), stop="tool_use"), reply(mk("t2"), stop="tool_use"),
                      reply(mk("t3"), stop="tool_use"), reply(text("never"), stop="end_turn"))
    engine = FakeEngine(FAILED, graphics.GraphicsError("The render has an audio stream"), FAILED)
    r = runs(fake, engine)
    body = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    assert body["state"] == "stopped" and body["reason"] == "graphics"
    assert 'The graphic "mfa-lower-third" failed 3 times' in body["message"]
    assert "gsap_animates_clip_element" in body["message"]
    assert len(fake.calls) == 3 and len(engine.calls) == 3  # no fourth Claude call
    first, second = last_user(fake, 1)[0], last_user(fake, 2)[0]
    assert first["is_error"] and "HyperFrames check failed" in first["content"]
    assert "Text is small" in first["content"] and "2 more failures" in first["content"]
    assert second["is_error"] and "audio stream" in second["content"] and "1 more failure of" in second["content"]
    assert body["run_id"] not in r._runs


def test_failures_are_counted_per_slug():
    fake = FakeClient(reply(mk("t1", "a"), stop="tool_use"), reply(mk("t2", "a"), stop="tool_use"),
                      reply(mk("t3", "b"), stop="tool_use"), reply(mk("t4", "a"), stop="tool_use"),
                      reply(text("plan"), stop="end_turn"))
    body = runs(fake, FakeEngine(FAILED, FAILED, FAILED, None)).start("x", SELECTION, SEQUENCE, CONTEXT)
    assert body["state"] == "plan"  # a: 2 failures then a success; b: 1 failure
    assert [g["slug"] for g in body["graphics"]] == ["a"]


def test_graphics_lists_the_latest_version_of_each_graphic_in_every_reply():
    fake = FakeClient(reply(mk("t1", "a"), stop="tool_use"), reply(mk("t2", "b", 6), stop="tool_use"),
                      reply(mk("t3", "a", 5), tool("t4", "get_sequence"), stop="tool_use"),
                      reply(text("plan"), stop="end_turn"))
    r = runs(fake, FakeEngine())
    body = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    assert [(g["slug"], g["version"], g["duration_s"]) for g in body["graphics"]] == [("a", 2, 5), ("b", 1, 6)]
    plan = r.results(body["run_id"], [ok("t4")])
    assert plan["state"] == "plan" and [(g["slug"], g["version"]) for g in plan["graphics"]] == [("a", 2), ("b", 1)]


def test_make_graphic_gets_the_runs_project_sequence_and_cancel_event():
    fake = FakeClient(reply(tool("t1", "make_graphic", {"slug": "s", "kind": "card", "duration_s": 6, "html": HTML,
                                                        "variables": {"title": "Hi"}, "previewAtS": 2}),
                            stop="tool_use"), reply(text("plan"), stop="end_turn"))
    engine = FakeEngine()
    r = runs(fake, engine)
    body = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    kw = engine.calls[0]
    assert (kw["project_path"], kw["width"], kw["height"], kw["timebase"], kw["fps"]) == (PROJECT, 3840, 2160,
                                                                                          "8467200000", None)
    assert (kw["slug"], kw["kind"], kw["duration_s"], kw["html"]) == ("s", "card", 6, HTML)
    assert kw["variables"] == {"title": "Hi"} and kw["preview_at_s"] == 2
    assert isinstance(kw["cancel"], threading.Event)
    assert body["state"] == "plan"


def test_read_graphic_errors_go_back_to_claude_and_dont_count():
    fake = FakeClient(reply(tool("t1", "read_graphic", {"slug": "missing"}), stop="tool_use"),
                      reply(text("plan"), stop="end_turn"))
    r = runs(fake, FakeEngine())
    body = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    res = last_user(fake)[0]
    assert res["is_error"] and "No graphic 'missing'" in res["content"]
    assert body["state"] == "plan"


# ── run start fields, unsaved projects ─────────────────────────────

def test_the_first_message_tells_claude_the_graphics_context():
    fake = FakeClient(reply(text("plan"), stop="end_turn"))
    runs(fake, FakeEngine()).start("x", SELECTION, SEQUENCE, CONTEXT)
    first = fake.calls[0]["messages"][0]["content"]
    assert f"For graphics: the project is {PROJECT}; the sequence is 3840x2160 at 30 fps." in first


def test_a_run_without_graphics_fields_on_an_unsaved_project_still_works():
    fake = FakeClient(reply(tool("t1", "get_sequence"), stop="tool_use"), reply(text("1. Marker at 0:12"),
                                                                               stop="end_turn"))
    r = runs(fake, FakeEngine())
    first = r.start("add a marker", SELECTION, SEQUENCE)  # no context at all, as before
    assert first["state"] == "tool_calls" and first["graphics"] == []
    assert "For graphics" not in fake.calls[0]["messages"][0]["content"]
    assert r.results(first["run_id"], [ok("t1")])["state"] == "plan"


def test_an_unsaved_project_is_refused_only_inside_make_graphic():
    fake = FakeClient(reply(mk("t1"), stop="tool_use"), reply(text("Save the project first."), stop="end_turn"))
    engine = FakeEngine(graphics.Refused(graphics.SAVE_FIRST))
    body = runs(fake, engine).start("x", SELECTION, SEQUENCE, {"projectPath": "", "fps": 25, "width": 1920,
                                                               "height": 1080})
    assert "the project isn't saved" in fake.calls[0]["messages"][0]["content"]
    res = last_user(fake)[0]
    assert res["is_error"] and graphics.SAVE_FIRST in res["content"]
    assert body["state"] == "plan"


def test_the_start_route_passes_the_graphics_fields(tmp_path):
    fake = FakeClient(reply(mk("t1"), stop="tool_use"), reply(text("plan"), stop="end_turn"))
    engine = FakeEngine()
    token = config.get_or_create_token(tmp_path)
    app = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library",
                     agent_runs=agent.Runs(make_client=lambda: fake, engine=engine))
    c = TestClient(app, base_url="http://127.0.0.1:8791")
    r = c.post("/agent/runs", headers={"Authorization": f"Bearer {token}"},
               json={"instruction": "lower third", "selection": SELECTION, "sequence": SEQUENCE,
                     "projectPath": PROJECT, "timebase": "8475667200", "width": 1920, "height": 1080})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "plan" and body["graphics"][0]["slug"] == "mfa-lower-third"
    kw = engine.calls[0]
    assert (kw["project_path"], kw["timebase"], kw["width"], kw["height"]) == (PROJECT, "8475667200", 1920, 1080)


def test_every_step_reply_carries_graphics(tmp_path):
    fake = FakeClient(reply(text("I can't"), stop="max_tokens"))
    body = runs(fake, FakeEngine()).start("x", SELECTION, SEQUENCE)
    assert body["state"] == "stopped" and body["graphics"] == []


# ── cancel ─────────────────────────────────────────────────────────

def test_delete_during_a_render_kills_it_and_nothing_runs_after():
    entered = threading.Event()

    def render(kw):
        entered.set()
        assert kw["cancel"].wait(5), "the cancel never reached the render"
        raise graphics.Cancelled()  # what the engine does after killing the process tree

    fake = FakeClient(reply(mk("t1"), stop="tool_use"), reply(mk("t2"), stop="tool_use"))
    engine = FakeEngine(render)
    r = runs(fake, engine)
    out = {}
    worker = threading.Thread(target=lambda: out.update(r.start("x", SELECTION, SEQUENCE, CONTEXT)))
    worker.start()
    assert entered.wait(5)
    run_id = next(iter(r._runs))
    r.cancel(run_id)  # what DELETE /agent/runs/{id} does
    worker.join(5)
    assert out["state"] == "stopped" and out["reason"] == "cancelled"
    assert len(fake.calls) == 1 and len(engine.calls) == 1  # no further Claude step, no further render
    assert run_id not in r._runs


def test_a_cancel_during_a_backend_only_step_stops_before_the_next_claude_call():
    r = None

    def render(kw):
        r.cancel(next(iter(r._runs)))  # cancelled while the render finishes
        return made("mfa-lower-third", 1)

    fake = FakeClient(reply(mk("t1"), stop="tool_use"), reply(text("never"), stop="end_turn"))
    r = runs(fake, FakeEngine(render))
    out = r.start("x", SELECTION, SEQUENCE, CONTEXT)
    assert out["state"] == "stopped" and out["reason"] == "cancelled" and len(fake.calls) == 1


def test_the_delete_route_kills_a_running_render(tmp_path):
    entered = threading.Event()

    def render(kw):
        entered.set()
        kw["cancel"].wait(5)
        raise graphics.Cancelled()

    fake = FakeClient(reply(mk("t1"), stop="tool_use"))
    r = runs(fake, FakeEngine(render))
    token = config.get_or_create_token(tmp_path)
    app = create_app(token=token, stt_device=lambda: "cuda", library_dir=tmp_path / "library", agent_runs=r)
    auth = {"Authorization": f"Bearer {token}"}
    out = {}

    def go():
        with TestClient(app, base_url="http://127.0.0.1:8791") as c1:
            out["r"] = c1.post("/agent/runs", headers=auth, json={"instruction": "x", **CONTEXT})

    worker = threading.Thread(target=go)
    worker.start()
    assert entered.wait(5)
    with TestClient(app, base_url="http://127.0.0.1:8791") as c2:
        assert c2.delete(f"/agent/runs/{next(iter(r._runs))}", headers=auth).json() == {"ok": True}
    worker.join(10)
    assert out["r"].json()["reason"] == "cancelled" and len(fake.calls) == 1
