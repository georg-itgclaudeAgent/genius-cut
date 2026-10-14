#!/usr/bin/env node
/*
 * premiere-mcp — the Genius Cut assistant's tools for Claude Code (personal builds only).
 *
 * A stdio MCP server (JSON-RPC, one message per line; Node 20+, no dependencies) that forwards each
 * tool call to the bridge inside the Genius Cut panel in Premiere. The panel writes
 * %APPDATA%/itGenius/genius-cut/bridge.json {port, token, pid, panelVersion} while it runs; this
 * server reads it on every call, so a reopened panel is picked up without restarting Claude Code.
 *
 * Bridge wire protocol:
 *   GET  /ping  -> 200 {ok: true, panelVersion}                       (no auth)
 *   POST /tool  Authorization: Bearer <token>, {name, args, client}
 *               -> {ok: true, result} | {ok: false, message}; 401 on a bad token
 *   every reply carries X-Genius-Cut: gcut-assistant-bridge
 *
 * The bridge is "down" when bridge.json is missing or unreadable, its pid isn't alive, or /ping
 * fails; the tool then returns an error result telling the user to open the panel.
 *
 * client = $GCUT_CLIENT ("panel" when the panel spawns Claude), else "terminal".
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "premiere", version: "0.1.0" };
const DOWN = "Open the Genius Cut panel in Premiere (built with the assistant).";
const BRIDGE_HEADER = "x-genius-cut";
const BRIDGE_MARK = "gcut-assistant-bridge";
const PING_TIMEOUT_MS = 3000;
// wait_transcript blocks up to 60 s in the panel, and a cut on many clips can take a while.
const TOOL_TIMEOUT_MS = 180000;

// ── tool schemas (what Claude sees) ───────────────────────────────────────────────

const SECONDS = "Seconds on the sequence timeline (the times get_sequence reports), not source-media time.";
const STALE = "Clip ids come from get_sequence and go stale after any edit: call get_sequence again after an edit before using ids.";
const SEQ_ID = { type: "string", description: "The sequenceId from get_sequence. Refused if another sequence is open now." };

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: "get_sequence",
    description:
      "Read the active Premiere sequence: sequenceId, name, fps, durationS, tracks [{kind, index, name, muted}], " +
      "clips [{id, track, name, startS, endS, inS, source, selected, enabled, effects}], markers [{id, startS, endS, name, " +
      "comments, colour}] and selection (ids of the selected clips). All times are seconds on the sequence timeline " +
      "(inS is the clip's in point in its source; effects names the clip's added effects, which cut_ranges would remove). Track and clip numbering is 1-based, as Premiere shows it (V1, A2). " +
      "Call this first, and again after every edit: clip ids change when clips are cut or moved. " +
      "Optional fromS/toS list only the clips and markers overlapping that stretch.",
    inputSchema: {
      type: "object",
      properties: {
        fromS: { type: "number", minimum: 0, description: "Start of the stretch to list. " + SECONDS },
        toS: { type: "number", minimum: 0, description: "End of the stretch to list. " + SECONDS },
      },
      additionalProperties: false,
    },
    annotations: { title: "Read the sequence", ...READ },
  },
  {
    name: "get_transcript",
    description:
      "Transcribe what is said in chosen clips (clipIds from get_sequence) or in a stretch of the timeline (fromS and toS). " +
      "Returns the words with their times in seconds on the sequence timeline when the transcript is ready (cached " +
      "from an earlier Analyse or call). Otherwise it starts a transcription job and returns {id, status, progress}; " +
      "then call wait_transcript with that id until it returns the words. Give either clipIds, or fromS and toS.",
    inputSchema: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, minItems: 1, description: "Clip ids from get_sequence. " + STALE },
        fromS: { type: "number", minimum: 0, description: "Start of the stretch. " + SECONDS },
        toS: { type: "number", minimum: 0, description: "End of the stretch. " + SECONDS },
      },
      additionalProperties: false,
    },
    annotations: { title: "Read the transcript", ...READ },
  },
  {
    name: "wait_transcript",
    description:
      "Wait (up to about 60 s) for a transcription job that get_transcript started. Returns the words with times in " +
      "seconds on the sequence timeline when done, or the job's {id, status, progress} again if it is still running " +
      "(call wait_transcript again). status \"loading\" means the speech model is still loading.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The job id get_transcript returned." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { title: "Wait for a transcript", ...READ },
  },
  {
    name: "add_markers",
    description:
      "Add sequence markers (for example YouTube chapters or notes for the editor). Each marker: atS (where it starts), " +
      "optional endS for a range marker, name, optional comments, optional colour (Premiere's marker colour index 0-7). " +
      SECONDS + " All markers are checked first; if any can't be made, none are left behind. " +
      "Returns the created marker ids. Undo with undo_last_turn.",
    inputSchema: {
      type: "object",
      properties: {
        sequenceId: SEQ_ID,
        markers: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              atS: { type: "number", minimum: 0, description: "Marker start. " + SECONDS },
              endS: { type: "number", minimum: 0, description: "Optional end, for a range marker (at or after atS). " + SECONDS },
              name: { type: "string", minLength: 1, description: "The marker's name." },
              comments: { type: "string", description: "Optional marker comments." },
              colour: { type: "integer", minimum: 0, maximum: 7, description: "Optional Premiere marker colour index, 0-7." },
            },
            required: ["atS", "name"],
            additionalProperties: false,
          },
        },
      },
      required: ["sequenceId", "markers"],
      additionalProperties: false,
    },
    annotations: { title: "Add markers", ...ACT },
  },
  {
    name: "cut_ranges",
    description:
      "Cut stretches of time out of chosen clips and close the gaps (ripple), using Genius Cut's Apply engine: " +
      "every chosen track is cut in sync, the result is verified, and it is all or nothing. clipIds are ids from " +
      "get_sequence (include the linked audio clips you want cut too; unchosen clips that would be overwritten make " +
      "the call refuse). ranges are [{fromS, toS}] in seconds on the sequence timeline, clipped to the chosen clips' " +
      "span. Cutting rebuilds the chosen clips from their source: effects on them (get_sequence lists them) are removed, " +
      "so the call refuses, naming them, unless acceptEffectLoss is true; tell the user and set it only after they agree. " +
      "Intrinsic keyframes (Motion, Opacity, Volume) and audio gain are not kept either: they are rebuilt from the source. " +
      STALE + " Undo with undo_last_turn.",
    inputSchema: {
      type: "object",
      properties: {
        sequenceId: SEQ_ID,
        clipIds: { type: "array", items: { type: "string" }, minItems: 1, description: "The clips to cut, ids from get_sequence. " + STALE },
        ranges: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              fromS: { type: "number", minimum: 0, description: "Start of the stretch to remove. " + SECONDS },
              toS: { type: "number", minimum: 0, description: "End of the stretch to remove. " + SECONDS },
            },
            required: ["fromS", "toS"],
            additionalProperties: false,
          },
        },
        acceptEffectLoss: {
          type: "boolean",
          description: "Set true only after the user agreed to lose the effects on the chosen clips (the refusal names them).",
        },
      },
      required: ["sequenceId", "clipIds", "ranges"],
      additionalProperties: false,
    },
    annotations: { title: "Cut time ranges", ...ACT },
  },
  {
    name: "undo_last_turn",
    description:
      "Undo the latest change made through these tools (one add_markers or cut_ranges call) on the active sequence, " +
      "exactly; call again to undo the one before. Refuses, changing nothing, if what that change made was edited by " +
      "hand since, and says what is in the way. Reports \"already undone\" if it was already taken back (for example " +
      "with Premiere's Ctrl+Z). Call get_sequence afterwards before using clip ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Undo the last change", ...ACT },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ── the bridge ─────────────────────────────────────────────────────────────────────

function bridgeFile() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "itGenius", "genius-cut", "bridge.json");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

/** The live bridge's {port, token}, or null when the panel isn't serving. */
async function liveBridge() {
  let info;
  try {
    info = JSON.parse(readFileSync(bridgeFile(), "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!info || !Number.isInteger(info.port) || typeof info.token !== "string" || !pidAlive(info.pid)) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (res.status !== 200 || res.headers.get(BRIDGE_HEADER) !== BRIDGE_MARK) return null;
    const body = await res.json();
    if (!body || body.ok !== true) return null;
  } catch {
    return null;
  }
  return info;
}

const textResult = (text, isError) => (isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] });

async function callTool(name, args) {
  if (!TOOL_NAMES.has(name)) return textResult(`Unknown tool ${name}. The tools are: ${[...TOOL_NAMES].join(", ")}.`, true);
  const bridge = await liveBridge();
  if (!bridge) return textResult(DOWN, true);
  let res, body;
  try {
    res = await fetch(`http://127.0.0.1:${bridge.port}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ name, args: args ?? {}, client: process.env.GCUT_CLIENT || "terminal" }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return textResult(`The Genius Cut panel didn't answer ${name} within ${TOOL_TIMEOUT_MS / 1000} s. Check Premiere, then call get_sequence before trying again.`, true);
    }
    return textResult(DOWN, true);
  }
  if (res.status === 401) {
    return textResult("The Genius Cut panel refused this call (its access token changed). Reopen the panel in Premiere and try again.", true);
  }
  try {
    body = await res.json();
  } catch {
    return textResult(`The Genius Cut panel sent an unreadable reply (HTTP ${res.status}).`, true);
  }
  if (!body || body.ok !== true) {
    return textResult(String((body && body.message) || `The Genius Cut panel refused ${name} (HTTP ${res.status}).`), true);
  }
  return textResult(JSON.stringify(body.result ?? null), false);
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────────────────

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(m) {
  const isRequest = m.id !== undefined && m.id !== null;
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Tools for the Premiere sequence open in the Genius Cut panel. Read with get_sequence first; times are " +
          "seconds on the sequence timeline; read again after every edit; undo_last_turn reverses the latest edit.",
      });
    case "ping":
      return isRequest && reply(m.id, {});
    case "tools/list":
      return reply(m.id, { tools: TOOLS });
    case "tools/call": {
      const p = m.params || {};
      let result;
      try {
        result = await callTool(p.name, p.arguments);
      } catch (e) {
        result = textResult(`premiere-mcp failed: ${e && e.message ? e.message : e}`, true);
      }
      return reply(m.id, result);
    }
    default:
      if (isRequest) replyError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

function main() {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return replyError(null, -32700, "Parse error");
    }
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      if (m && m.id !== undefined && m.id !== null) replyError(m.id, -32600, "Invalid request");
      return; // a response or junk: nothing to answer
    }
    handle(m).catch((e) => {
      if (m.id !== undefined && m.id !== null) replyError(m.id, -32603, String(e && e.message ? e.message : e));
    });
  });
}

main();
