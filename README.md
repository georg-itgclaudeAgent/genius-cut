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
