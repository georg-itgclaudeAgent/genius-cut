# Genius Cut

An Adobe Premiere Pro panel from itGenius. Select clips on the timeline and say what to do:
"trim the ums" transcribes them locally on your GPU, proposes cuts in your editing style and
rebuilds the timeline once you approve; any other instruction ("add a marker at every product
mention", "switch to Camera A between 1:10 and 1:20") goes to Claude, which shows a plan, edits
the selected clips after you press Go, and can be undone in one click. Footage never leaves the
machine; only transcripts and timeline listings are sent to Claude.

**Status:** 0.2.0 in testing (Claude Opus 5.5 assistant, setup, usage limits, full toolbox).

- **Prototype:** [prototype/genius-cut-panel.html](prototype/genius-cut-panel.html). Download
  it and open it in a browser. It uses mock data only.
- **Design:** `docs/superpowers/specs/2026-09-30-genius-cut-design.md` in the agent-georg
  umbrella repo.
- **Installing:** handled by
  [Genius Installer Manager](https://github.com/georg-itgclaudeAgent/genius-installer-manager).
  Releases are tagged `vX.Y.Z` with a `.zip` whose `CSXS/manifest.xml` declares
  `ExtensionBundleId="com.attract.genius-cut"`. Until the first release, the installer shows
  Genius Cut as "Not released yet".

## Setting up Genius Cut (every editor, once)

Genius Cut's AI runs on **your own** Anthropic API key, kept in **your own** Google Cloud project's
Secret Manager. The panel opens on a Setup page until this is done:

1. **Google Cloud CLI** — install it from https://cloud.google.com/sdk/docs/install if the page says
   it's missing, then click Check again (no Premiere restart needed).
2. **Sign in** — Sign in with Google opens your browser; sign in yourself (Genius Cut never sees your
   password).
3. **Project** — pick the Google Cloud project that holds your key.
4. **Secret** — the secret's name (default `ANTHROPIC_API_KEY`) and version (default latest).
5. **Test** — reads the key and makes one free call to Anthropic.
6. **Monthly limit** — $20 (default) or $100 (the most). Change it later in ⚙ Settings → Usage & limit.

At the limit, Genius Cut stops calling Claude and says so: at $20 "Partial monthly limit reached…",
at $100 "Your allowed monthly limit has been reached…" until the 1st of next month. Costs shown are
estimates at list prices (Claude Opus 5.5: $4 / $20 per million input / output tokens); your
Anthropic console is the bill of record.

## Claude Code terminal door (personal builds only)

Lets Claude Code read and edit the open Premiere sequence through the Genius Cut panel, using your own
Claude Code login (no API key). It is never in builds for editors: `scripts/package.py` refuses a
`client/dist` that contains the bridge, and `mcp/` is never packaged. (The Premiere-side tools, the
`gcutTool*` functions, are in `host/index.jsx`, which every build ships.)

1. **Build the panel with the assistant.** Create `extension/client/.env.production.local` (gitignored):
   ```
   VITE_GENIUSCUT_PREVIEW=0
   VITE_GENIUSCUT_CLAUDE=1
   ```
   then `npm run build` in `extension/client` and reopen the panel (or restart Premiere). The panel
   writes `%APPDATA%\itGenius\genius-cut\bridge.json` while it is open.
2. **Register the tools with Claude Code once:** `powershell -File scripts\register-claude.ps1`. It adds
   a user-scope MCP server named `premiere` (check with `claude mcp list`; remove with
   `claude mcp remove premiere --scope user`).
3. **Ask Claude**, with the panel open, for example:
   - "List the clips on the timeline between 1:00 and 2:00."
   - "Add a marker called 'B-roll' at 2:15."
   - "Get the transcript of the selected clips and cut out the part where I talk about pricing."
   - "Undo that."

Tools: `get_sequence`, `get_transcript` / `wait_transcript`, `add_markers`, `cut_ranges`,
`undo_last_turn`. Times are sequence seconds; clip ids come from `get_sequence` and go stale after an
edit, so Claude reads the timeline again. Every change is one undo step (`undo_last_turn`, newest
first, kept in `%APPDATA%\itGenius\genius-cut\turns.json` per sequence, so it survives a panel reload).
Undo refuses if you changed those clips or markers by hand since, and says "already undone" if you
already reversed it with Ctrl+Z.

Limits: the panel must be open; one tool call runs at a time and none while Analyse, Apply, Restore or
Close gap runs; it uses your Claude subscription allowance. Tests: `node --test "mcp/*.test.mjs"`,
`pytest scripts/tests`, and the panel's vitest suite.
