# Genius Cut

An Adobe Premiere Pro panel from itGenius. Tell it what to trim; it transcribes the clip
locally on your GPU, proposes cuts in your editing style, and rebuilds the timeline once
you approve. Client footage never leaves the machine.

**Status:** design and front-end prototype done; backend not built yet.

- **Prototype:** [prototype/genius-cut-panel.html](prototype/genius-cut-panel.html). Download
  it and open it in a browser. It uses mock data only.
- **Design:** `docs/superpowers/specs/2026-09-30-genius-cut-design.md` in the agent-georg
  umbrella repo.
- **Installing:** handled by
  [Genius Installer Manager](https://github.com/georg-itgclaudeAgent/genius-installer-manager).
  Releases are tagged `vX.Y.Z` with a `.zip` whose `CSXS/manifest.xml` declares
  `ExtensionBundleId="com.attract.genius-cut"`. Until the first release, the installer shows
  Genius Cut as "Not released yet".

## Claude assistant (personal builds only)

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
