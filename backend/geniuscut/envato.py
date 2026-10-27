"""Envato Elements search for B-roll markers: a small MCP client (standard library only) for Envato's public
MCP server, used by the agent's `search_envato` backend tool on every model (spec Rule "Envato backend tool").

- Server: https://mcp.envato.com/mcp, Streamable HTTP, no auth. A session is `initialize` (keeping the
  `Mcp-Session-Id` reply header when the server sends one; on 2026-10-27 it sent none) then
  `notifications/initialized`, then any number of `tools/call`. Replies may be `application/json` or
  `text/event-stream` (the server answered with SSE on 2026-10-27); both are read, every request has a timeout.
- `search(kind, terms, orientation=None)` → `[{title, author?, item_url, cover?}]` (at most PER_PAGE):
  - `stock-video` → `search_stock_video` {searchTerms, perPage: 6, sortBy: "relevance",
    filters: {categories: "Stock Footage", orientation?: horizontal|vertical}}
  - `photos` → `search_photos` {searchTerms, perPage: 6, sortBy: "relevance", filters: {orientation?}}.
    The live schema (tools/list, 2026-10-27) takes landscape|portrait|square for photos and rejects
    horizontal, so horizontal → landscape and vertical → portrait here.
- Result shape seen live: `result.content[0].text` is JSON {"items": [{title, item_type, author, cover_image,
  aspect_ratio, item_url}], "pagination": …}; `structuredContent` is a UI tree. Parsed defensively: items
  from the text JSON (or structuredContent.items), entries without a title or an https item_url dropped.
- Any failure (network, timeout, HTTP status, JSON-RPC error, `isError`, an unreadable reply) raises
  EnvatoError with a short plain message.
- `enabled()`: GENIUSCUT_ENVATO=0/false/off/no switches the tool off.
"""

from __future__ import annotations

import itertools
import json
import os
import time
import urllib.error
import urllib.request

URL = "https://mcp.envato.com/mcp"
PROTOCOL = "2025-06-18"
TIMEOUT_S = 15
RETRY_PAUSE_S = 1  # before the one retry of a dropped connection or timeout (never an HTTP error)
PER_PAGE = 6
KINDS = {"stock-video": "search_stock_video", "photos": "search_photos"}
ORIENTATIONS = ("horizontal", "vertical")
PHOTO_ORIENTATION = {"horizontal": "landscape", "vertical": "portrait"}
MAX_TERMS = 60
USER_AGENT = "GeniusCut/1 (MCP client)"  # Cloudflare in front of the server refuses urllib's default (403)


class EnvatoError(Exception):
    """Envato search failed (the server couldn't be reached or answered with an error)."""


def enabled() -> bool:
    """Envato search is on unless GENIUSCUT_ENVATO is 0/false/off/no."""
    return (os.environ.get("GENIUSCUT_ENVATO") or "").strip().lower() not in ("0", "false", "off", "no")


class Client:
    """One MCP session with the server, opened on the first call. `opener(request, timeout)` is
    urllib.request.urlopen unless a test passes another."""

    def __init__(self, url: str = URL, *, timeout: float = TIMEOUT_S, opener=None):
        self.url, self.timeout = url, timeout
        self.opener = opener or urllib.request.urlopen
        self.session: str | None = None
        self.opened = False
        self._ids = itertools.count(1)

    def _post(self, payload: dict) -> dict | None:
        """POST one JSON-RPC message; the matching response (None for a notification)."""
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": PROTOCOL, "User-Agent": USER_AGENT}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode("utf-8"), headers=headers,
                                         method="POST")
        try:
            return self._send(request, payload)
        except EnvatoError as e:
            if not isinstance(e.__cause__, (TimeoutError, OSError)) or isinstance(e.__cause__, urllib.error.HTTPError):
                raise
        time.sleep(RETRY_PAUSE_S)  # one retry: a wobbly connection drops a request now and then (live 2026-10-27)
        return self._send(request, payload)

    def _send(self, request, payload: dict) -> dict | None:
        try:
            with self.opener(request, timeout=self.timeout) as response:
                sid = response.headers.get("Mcp-Session-Id")
                if sid:
                    self.session = sid
                if "id" not in payload:  # a notification: 202 and no body expected
                    return None
                kind = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                if kind == "text/event-stream":
                    return _read_sse(response, payload["id"])
                return _match(json.loads(response.read().decode("utf-8") or "null"), payload["id"])
        except EnvatoError:
            raise
        except urllib.error.HTTPError as e:
            raise EnvatoError(f"the Envato server answered HTTP {e.code}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise EnvatoError(f"couldn't reach the Envato server ({getattr(e, 'reason', None) or e})") from e
        except (ValueError, UnicodeDecodeError) as e:
            raise EnvatoError("the Envato server sent a reply that couldn't be read") from e

    def _rpc(self, method: str, params: dict) -> dict:
        reply = self._post({"jsonrpc": "2.0", "id": next(self._ids), "method": method, "params": params})
        if not isinstance(reply, dict):
            raise EnvatoError("the Envato server sent no reply")
        if reply.get("error"):
            err = reply["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise EnvatoError(f"the Envato server refused {method}: {msg}")
        result = reply.get("result")
        if not isinstance(result, dict):
            raise EnvatoError(f"the Envato server sent no result for {method}")
        return result

    def open(self) -> None:
        if self.opened:
            return
        self._rpc("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                 "clientInfo": {"name": "genius-cut", "version": "1"}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.opened = True

    def call(self, name: str, arguments: dict) -> dict:
        self.open()
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise EnvatoError(f"Envato's {name} failed: {_text(result)[:300] or 'no detail'}")
        return result

    def search(self, kind: str, terms: str, orientation: str | None = None) -> list[dict]:
        name, arguments = request_for(kind, terms, orientation)
        return items(self.call(name, arguments))


def request_for(kind: str, terms: str, orientation: str | None = None) -> tuple[str, dict]:
    """The MCP tool name and arguments for one search (ValueError on bad input)."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    terms = (terms or "").strip() if isinstance(terms, str) else ""
    if not terms or len(terms) > MAX_TERMS:
        raise ValueError(f"searchTerms must be 1-{MAX_TERMS} characters")
    if orientation not in (None, *ORIENTATIONS):
        raise ValueError(f"orientation must be one of {', '.join(ORIENTATIONS)}")
    filters: dict = {}
    if kind == "stock-video":
        filters["categories"] = "Stock Footage"
        if orientation:
            filters["orientation"] = orientation
    elif orientation:
        filters["orientation"] = PHOTO_ORIENTATION[orientation]
    return KINDS[kind], {"searchTerms": terms, "perPage": PER_PAGE, "sortBy": "relevance", "filters": filters}


def search(kind: str, terms: str, orientation: str | None = None, *, client: Client | None = None) -> list[dict]:
    """One Envato search (a new session unless `client` is given): [{title, author?, item_url, cover?}]."""
    return (client or Client()).search(kind, terms, orientation)


def items(result: dict) -> list[dict]:
    """The found items from a tools/call result, parsed defensively."""
    raw = None
    for block in result.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            try:
                data = json.loads(block["text"])
            except ValueError:
                continue
            raw = data.get("items") if isinstance(data, dict) else data if isinstance(data, list) else None
            if isinstance(raw, list):
                break
    if not isinstance(raw, list):
        sc = result.get("structuredContent")
        raw = sc.get("items") if isinstance(sc, dict) else None
    if not isinstance(raw, list):
        raise EnvatoError("the Envato server sent results that couldn't be read")
    out = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        title, url = it.get("title"), it.get("item_url") or it.get("url")
        if not (isinstance(title, str) and title.strip() and isinstance(url, str) and url.startswith("https://")):
            continue
        item = {"title": title.strip(), "item_url": url}
        if isinstance(it.get("author"), str) and it["author"].strip():
            item["author"] = it["author"].strip()
        cover = it.get("cover_image") or it.get("cover")
        if isinstance(cover, str) and cover.startswith("https://"):
            item["cover"] = cover
        out.append(item)
    return out[:PER_PAGE]


def _text(result: dict) -> str:
    return " ".join(b.get("text", "") for b in result.get("content") or []
                    if isinstance(b, dict) and isinstance(b.get("text"), str)).strip()


def _match(message, want):
    """The response with id `want` from one JSON-RPC message or a batch."""
    for m in message if isinstance(message, list) else [message]:
        if isinstance(m, dict) and m.get("id") == want and ("result" in m or "error" in m):
            return m
    return None


def _read_sse(response, want) -> dict | None:
    """Read SSE events until the response with id `want` arrives (the stream may stay open after it)."""
    data: list[str] = []
    for raw in response:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
            continue
        if line == "" and data:
            found = _match(json.loads("\n".join(data)), want)
            data = []
            if found is not None:
                return found
    if data:
        return _match(json.loads("\n".join(data)), want)
    return None
