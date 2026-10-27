"""envato.py (model picker plan Task 4): the standard-library MCP client for Envato's search, against a fake MCP
server on 127.0.0.1 (a real http.server thread). No call reaches mcp.envato.com."""

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from geniuscut import envato

ITEMS = [{"title": "Typing on Laptop Close Up Shot", "item_type": "stock-video", "author": "Macro_Media",
          "cover_image": "https://elements-resized.envatousercontent.com/a.jpg", "aspect_ratio": 1.9,
          "item_url": "https://elements.envato.com/typing-on-laptop-close-up-shot-PGNGVDH"},
         {"title": "Fingers Typing on Laptop Keyboard Closeup", "author": "kryvoshapka",
          "item_url": "https://elements.envato.com/fingers-typing-RC48LBC"}]


def real_opener(request, timeout):
    """urllib without the test suite's no-network guard (it patches urlopen) and without proxies."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout)


class FakeMCP:
    """A tiny Streamable-HTTP MCP server. `mode`: json | sse; `session`: the Mcp-Session-Id it hands out (or
    None); `fail`: None | "http" (500 on tools/call) | "is_error" | "rpc_error" | "garbage"; `items`: what a
    search finds. Every request is recorded as {method, headers, body}."""

    def __init__(self, mode="json", session="sess-123", fail=None, items=None):
        self.mode, self.session, self.fail = mode, session, fail
        self.items = ITEMS if items is None else items
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append({"method": body.get("method"), "headers": dict(self.headers), "body": body})
                outer.handle(self, body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/mcp"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02},
                                       daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def client(self, **kw):
        return envato.Client(self.url, opener=real_opener, **kw)

    def search(self, kind, terms, orientation=None):
        return envato.search(kind, terms, orientation, client=self.client())

    # ── replies ──
    def handle(self, h, body):
        method = body.get("method")
        if "id" not in body:  # notifications/initialized
            h.send_response(202)
            h.send_header("Content-Length", "0")
            h.end_headers()
            return
        if method == "initialize":
            return self.reply(h, body, {"protocolVersion": envato.PROTOCOL, "capabilities": {"tools": {}},
                                        "serverInfo": {"name": "fake", "version": "1"}}, session=self.session)
        if method == "tools/call":
            if self.fail == "http":
                h.send_response(500)
                h.send_header("Content-Length", "0")
                h.end_headers()
                return
            if self.fail == "garbage":
                return self.raw(h, b"not json at all", "application/json")
            if self.fail == "rpc_error":
                return self.send(h, {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32602,
                                                                                    "message": "bad params"}})
            if self.fail == "is_error":
                return self.reply(h, body, {"content": [{"type": "text", "text": "1 validation error"}],
                                            "isError": True})
            text = json.dumps({"items": self.items, "pagination": {"current_page": 1}})
            return self.reply(h, body, {"content": [{"type": "text", "text": text}],
                                        "structuredContent": {"view": {}}, "isError": False})
        self.send(h, {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": "no method"}})

    def reply(self, h, body, result, session=None):
        self.send(h, {"jsonrpc": "2.0", "id": body["id"], "result": result}, session=session)

    def send(self, h, message, session=None):
        if self.mode == "sse":
            # a log notification first: the client must wait for the message with its own id
            note = {"jsonrpc": "2.0", "method": "notifications/message", "params": {"level": "info", "data": "x"}}
            data = (f"event: message\ndata: {json.dumps(note)}\n\n"
                    f"event: message\ndata: {json.dumps(message)}\n\n").encode("utf-8")
            return self.raw(h, data, "text/event-stream", session)
        self.raw(h, json.dumps(message).encode("utf-8"), "application/json; charset=utf-8", session)

    def raw(self, h, data, kind, session=None):
        h.send_response(200)
        h.send_header("Content-Type", kind)
        h.send_header("Content-Length", str(len(data)))
        if session:
            h.send_header("Mcp-Session-Id", session)
        h.end_headers()
        h.wfile.write(data)


@pytest.fixture
def mcp():
    servers = []

    def make(**kw):
        s = FakeMCP(**kw)
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.close()


# ── the protocol ───────────────────────────────────────────────────

@pytest.mark.parametrize("mode", ["json", "sse"])
def test_a_search_initializes_then_calls_the_tool_and_reads_json_or_sse(mcp, mode):
    server = mcp(mode=mode)
    found = server.search("stock-video", "typing on laptop close up", "horizontal")
    assert found == [
        {"title": "Typing on Laptop Close Up Shot", "item_url": ITEMS[0]["item_url"], "author": "Macro_Media",
         "cover": "https://elements-resized.envatousercontent.com/a.jpg"},
        {"title": "Fingers Typing on Laptop Keyboard Closeup", "item_url": ITEMS[1]["item_url"],
         "author": "kryvoshapka"}]
    assert [r["method"] for r in server.requests] == ["initialize", "notifications/initialized", "tools/call"]
    for r in server.requests:
        assert "application/json" in r["headers"]["Accept"] and "text/event-stream" in r["headers"]["Accept"]
        assert r["headers"]["User-Agent"] == envato.USER_AGENT
    call = server.requests[2]["body"]
    assert call["params"] == {"name": "search_stock_video", "arguments": {
        "searchTerms": "typing on laptop close up", "perPage": 6, "sortBy": "relevance",
        "filters": {"categories": "Stock Footage", "orientation": "horizontal"}}}


def test_the_session_id_is_carried_on_every_later_request(mcp):
    server = mcp(session="abc-42")
    client = server.client()
    client.search("stock-video", "city at night")
    client.search("photos", "office desk")
    assert "Mcp-Session-Id" not in server.requests[0]["headers"]
    assert [r["headers"].get("Mcp-Session-Id") for r in server.requests[1:]] == ["abc-42"] * 3
    assert [r["method"] for r in server.requests].count("initialize") == 1  # one session, opened once


def test_no_session_id_is_fine(mcp):
    server = mcp(session=None)  # the live server sent none on 2026-10-27
    assert len(server.search("stock-video", "city at night")) == 2
    assert all("Mcp-Session-Id" not in r["headers"] for r in server.requests)


def test_photos_map_orientation_to_the_photo_enum_and_have_no_category(mcp):
    server = mcp()
    server.search("photos", "office desk", "vertical")
    assert server.requests[-1]["body"]["params"] == {"name": "search_photos", "arguments": {
        "searchTerms": "office desk", "perPage": 6, "sortBy": "relevance", "filters": {"orientation": "portrait"}}}
    assert envato.request_for("photos", "x", "horizontal")[1]["filters"] == {"orientation": "landscape"}
    assert envato.request_for("photos", "x")[1]["filters"] == {}
    assert envato.request_for("stock-video", "x")[1]["filters"] == {"categories": "Stock Footage"}


@pytest.mark.parametrize("fail", ["http", "is_error", "rpc_error", "garbage"])
def test_server_failures_raise_envato_error(mcp, fail):
    server = mcp(fail=fail)
    with pytest.raises(envato.EnvatoError):
        server.search("stock-video", "city at night")


def test_an_unreachable_server_raises_envato_error_after_the_timeout():
    with pytest.raises(envato.EnvatoError, match="couldn't reach"):
        envato.Client("http://127.0.0.1:9/mcp", opener=real_opener, timeout=2).search("stock-video", "x")


def test_one_dropped_connection_is_retried_once(mcp, monkeypatch):
    """Live 2026-10-27 on a wobbly connection: a reset (WinError 10054) or read timeout, then fine."""
    monkeypatch.setattr(envato, "RETRY_PAUSE_S", 0)
    server = mcp()
    drops = []

    def flaky(request, timeout):
        if len(drops) < 1:
            drops.append(1)
            raise ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host")
        return real_opener(request, timeout)

    client = envato.Client(server.url, opener=flaky)
    assert len(client.search("stock-video", "city at night")) == 2
    assert drops == [1]


def test_a_connection_that_keeps_dropping_still_fails(mcp, monkeypatch):
    monkeypatch.setattr(envato, "RETRY_PAUSE_S", 0)
    calls = []

    def dead(request, timeout):
        calls.append(1)
        raise TimeoutError("The read operation timed out")

    with pytest.raises(envato.EnvatoError, match="couldn't reach"):
        envato.Client(mcp().url, opener=dead).search("stock-video", "x")
    assert len(calls) == 2  # the first try and one retry, no more


def test_an_http_error_is_not_retried(mcp):
    server = mcp(fail="http")
    with pytest.raises(envato.EnvatoError, match="HTTP"):
        server.search("stock-video", "city at night")
    assert [r["method"] for r in server.requests].count("tools/call") == 1  # the 500 came once, no retry


def test_bad_items_are_dropped_and_at_most_six_kept(mcp):
    junk = [{"title": "", "item_url": "https://elements.envato.com/a"}, {"title": "No url"},
            {"title": "Http", "item_url": "http://elements.envato.com/b"}, "nope"]
    many = [{"title": f"T{i}", "item_url": f"https://elements.envato.com/{i}"} for i in range(9)]
    server = mcp(items=junk + many)
    found = server.search("stock-video", "x")
    assert [f["title"] for f in found] == ["T0", "T1", "T2", "T3", "T4", "T5"]


@pytest.mark.parametrize("kind,terms,orientation", [("music", "x", None), ("photos", "", None),
                                                    ("photos", "x" * 61, None), ("photos", "x", "square")])
def test_bad_input_is_a_value_error_before_any_request(kind, terms, orientation):
    with pytest.raises(ValueError):
        envato.request_for(kind, terms, orientation)


@pytest.mark.parametrize("value,on", [(None, True), ("1", True), ("0", False), ("false", False), ("off", False),
                                      ("no", False)])
def test_genius_cut_envato_switch(monkeypatch, value, on):
    if value is not None:
        monkeypatch.setenv("GENIUSCUT_ENVATO", value)
    assert envato.enabled() is on


def test_the_default_client_goes_to_envato_and_respects_the_no_network_guard():
    assert envato.URL == "https://mcp.envato.com/mcp"
    with pytest.raises(AssertionError, match="must not make real HTTP calls"):
        envato.search("stock-video", "x")  # the suite's guard: no test reaches mcp.envato.com
