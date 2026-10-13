// node --test mcp/   — premiere-mcp against a fake panel bridge (no Premiere, no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./premiere-mcp.mjs", import.meta.url));
const DOWN = "Open the Genius Cut panel in Premiere (built with the assistant).";
const TOKEN = "t0k3n";

/** A fake bridge: answers /ping, records every /tool call and replies with reply(body). */
async function fakeBridge(reply = (body) => ({ ok: true, result: { echo: body.name } }), opts = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, obj) => {
        const headers = { "Content-Type": "application/json" };
        if (!opts.noHeader) headers["X-Genius-Cut"] = "gcut-assistant-bridge";
        res.writeHead(status, headers);
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/ping") return send(200, { ok: true, panelVersion: "0.1.0" });
      if (req.method === "POST" && req.url === "/tool") {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, message: "bad token" });
        const body = JSON.parse(raw);
        calls.push({ body, auth: req.headers.authorization });
        return send(200, reply(body));
      }
      send(404, { ok: false, message: "no route" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { calls, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** A temp %APPDATA% with (optionally) a bridge.json in it. */
function appData(bridge) {
  const dir = mkdtempSync(join(tmpdir(), "gcut-mcp-"));
  mkdirSync(join(dir, "itGenius", "genius-cut"), { recursive: true });
  const write = (b) => writeFileSync(join(dir, "itGenius", "genius-cut", "bridge.json"), JSON.stringify(b));
  if (bridge) write(bridge);
  return { dir, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** premiere-mcp as Claude Code runs it: a child process speaking JSON-RPC lines on stdio. */
function startMcp(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, GCUT_CLIENT: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(), stray = [];
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else stray.push(m);
  });
  let stderr = "", exited = false;
  child.stderr.on("data", (c) => (stderr += c));
  child.once("exit", (code) => {
    exited = true;
    for (const done of waiting.values()) done({ error: { code: "exit", message: `premiere-mcp exited (${code}): ${stderr}` } });
    waiting.clear();
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (exited) return reject(new Error(`premiere-mcp exited: ${stderr}`));
    const id = next++;
    waiting.set(id, (m) => (m.error && m.error.code === "exit" ? reject(new Error(m.error.message)) : resolve(m)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const raw = (s) => child.stdin.write(s + "\n");
  const call = async (name, args) => (await request("tools/call", { name, arguments: args })).result;
  const stop = () => new Promise((r) => { if (exited) return r(); child.once("exit", r); child.stdin.end(); child.kill(); });
  return { request, raw, call, stray, stop };
}

const text = (result) => result.content.map((c) => c.text).join("");

async function withSetup(fn, { reply, bridgeOpts, bridgeJson, env } = {}) {
  const bridge = await fakeBridge(reply, bridgeOpts);
  const data = appData(bridgeJson === null ? null : { port: bridge.port, token: TOKEN, pid: process.pid, panelVersion: "0.1.0", ...bridgeJson });
  const mcp = startMcp({ APPDATA: data.dir, ...env });
  try {
    await fn({ bridge, data, mcp });
  } finally {
    await mcp.stop();
    await bridge.close();
    data.cleanup();
  }
}

test("initialize answers with the client's protocol version and a tools capability", () => withSetup(async ({ mcp }) => {
  const r = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, "premiere");
}));

test("tools/list offers exactly the Phase 1 tools with schemas written for Claude", () => withSetup(async ({ mcp }) => {
  const { tools } = (await mcp.request("tools/list", {})).result;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(),
    ["add_markers", "cut_ranges", "get_sequence", "get_transcript", "undo_last_turn", "wait_transcript"]);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 40, t.name);
  }
  assert.deepEqual(byName.add_markers.inputSchema.required.sort(), ["markers", "sequenceId"]);
  const marker = byName.add_markers.inputSchema.properties.markers.items;
  assert.deepEqual(marker.required.sort(), ["atS", "name"]);
  assert.equal(marker.properties.colour.minimum, 0);
  assert.equal(marker.properties.colour.maximum, 7);
  assert.deepEqual(byName.cut_ranges.inputSchema.required.sort(), ["clipIds", "ranges", "sequenceId"]);
  assert.deepEqual(byName.cut_ranges.inputSchema.properties.ranges.items.required.sort(), ["fromS", "toS"]);
  assert.deepEqual(byName.wait_transcript.inputSchema.required, ["id"]);
  assert.deepEqual(Object.keys(byName.undo_last_turn.inputSchema.properties), []);
  assert.match(byName.get_sequence.description, /seconds/);
  assert.match(byName.cut_ranges.description, /get_sequence/);
  assert.match(byName.cut_ranges.description, /undo_last_turn/);
  assert.equal(byName.get_sequence.annotations.readOnlyHint, true);
  assert.equal(byName.cut_ranges.annotations.readOnlyHint, false);
}));

test("tools/call forwards name, args and client to the bridge with the token, and returns the result", () => withSetup(async ({ bridge, mcp }) => {
  const reply = await mcp.call("add_markers", { sequenceId: "s1", markers: [{ atS: 30005, name: "test" }] });
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(bridge.calls[0].body, { name: "add_markers", args: { sequenceId: "s1", markers: [{ atS: 30005, name: "test" }] }, client: "terminal" });
  assert.ok(!reply.isError);
  assert.deepEqual(JSON.parse(text(reply)), { echo: "add_markers" });
}));

test("a call without arguments sends {} as args", () => withSetup(async ({ bridge, mcp }) => {
  await mcp.request("tools/call", { name: "undo_last_turn" });
  assert.deepEqual(bridge.calls[0].body.args, {});
}));

test("GCUT_CLIENT names the client", () => withSetup(async ({ bridge, mcp }) => {
  await mcp.call("get_sequence", {});
  assert.equal(bridge.calls[0].body.client, "panel");
}, { env: { GCUT_CLIENT: "panel" } }));

test("a refusal from the bridge is an error result carrying its message", () => withSetup(async ({ mcp }) => {
  const reply = await mcp.call("cut_ranges", { sequenceId: "s", clipIds: ["V1@0#1"], ranges: [{ fromS: 1, toS: 2 }] });
  assert.equal(reply.isError, true);
  assert.equal(text(reply), "The timeline changed since you read it; call get_sequence again.");
}, { reply: () => ({ ok: false, message: "The timeline changed since you read it; call get_sequence again." }) }));

test("no bridge.json: the open-the-panel message, as an error result", () => withSetup(async ({ bridge, mcp }) => {
  const reply = await mcp.call("get_sequence", {});
  assert.equal(reply.isError, true);
  assert.equal(text(reply), DOWN);
  assert.equal(bridge.calls.length, 0);
}, { bridgeJson: null }));

test("a bridge.json whose panel process is gone counts as down", async () => {
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.once("exit", r));
  await withSetup(async ({ bridge, mcp }) => {
    const reply = await mcp.call("get_sequence", {});
    assert.equal(reply.isError, true);
    assert.equal(text(reply), DOWN);
    assert.equal(bridge.calls.length, 0);
  }, { bridgeJson: { pid: dead.pid } });
});

test("a bridge that doesn't answer /ping counts as down, and the server keeps running", () => withSetup(async ({ bridge, mcp }) => {
  await bridge.close();
  const reply = await mcp.call("get_sequence", {});
  assert.equal(reply.isError, true);
  assert.equal(text(reply), DOWN);
  const again = await mcp.request("tools/list", {});
  assert.ok(again.result.tools.length);
}));

test("something else listening on the port (no bridge header) counts as down", () => withSetup(async ({ bridge, mcp }) => {
  const reply = await mcp.call("get_sequence", {});
  assert.equal(text(reply), DOWN);
  assert.equal(bridge.calls.length, 0);
}, { bridgeOpts: { noHeader: true } }));

test("unreadable bridge.json counts as down", () => withSetup(async ({ data, mcp }) => {
  writeFileSync(join(data.dir, "itGenius", "genius-cut", "bridge.json"), "{not json");
  const reply = await mcp.call("get_sequence", {});
  assert.equal(text(reply), DOWN);
}));

test("a wrong token is an error result, not a crash", () => withSetup(async ({ mcp }) => {
  const reply = await mcp.call("get_sequence", {});
  assert.equal(reply.isError, true);
  assert.match(text(reply), /refused/i);
}, { bridgeJson: { token: "wrong" } }));

test("bridge.json is read on every call (a reopened panel is picked up)", () => withSetup(async ({ data, mcp }) => {
  const first = await mcp.call("get_sequence", {});
  assert.equal(text(first), DOWN);
  const second = await fakeBridge();
  try {
    data.write({ port: second.port, token: TOKEN, pid: process.pid, panelVersion: "0.1.0" });
    const reply = await mcp.call("get_sequence", {});
    assert.ok(!reply.isError);
    assert.equal(second.calls.length, 1);
  } finally {
    await second.close();
  }
}, { bridgeJson: null }));

test("an unknown tool is an error result and never reaches the bridge", () => withSetup(async ({ bridge, mcp }) => {
  const reply = await mcp.call("run_script", { code: "app.quit()" });
  assert.equal(reply.isError, true);
  assert.equal(bridge.calls.length, 0);
}));

test("notifications get no reply, unknown methods get -32601, bad lines don't stop the server", () => withSetup(async ({ mcp }) => {
  mcp.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  mcp.raw("{this is not json");
  const unknown = await mcp.request("resources/list", {});
  assert.equal(unknown.error.code, -32601);
  const ping = await mcp.request("ping", {});
  assert.deepEqual(ping.result, {});
  const list = await mcp.request("tools/list", {});
  assert.ok(list.result.tools.length);
  assert.ok(mcp.stray.every((m) => m.id === null && m.error && m.error.code === -32700), JSON.stringify(mcp.stray));
}));
