# Assistant measurements 2 (piece 4 tools)

Premiere Pro 26.5.2, 2026-10-14, through the CEP debug port on Georg's MAIN sequence. Two copies of the V1
Restream clip (with linked A1 audio) laid at 30000 s (+0–10 s and +12–17 s); everything removed afterwards
(far-out items 0, V1 transitions back to Georg's 1, A1 mute restored, bin marks restored). Probe:
scratchpad `probe15.jsx`.

| Tool need | Call | Result |
|---|---|---|
| split | `qe.project.getActiveSequence().getVideoTrackAt(0).razor("HH:MM:SS:FF")` at +4 s | V1 split into 0–4 @10.3 and 4–10 @14.3; **A1 not split** — razor acts on that one QE track; split each chosen track (audio via getAudioTrackAt). |
| enable/disable | `trackItem.disabled = true` / `false` | reads back true / false. |
| clip label | TrackItem has no get/setColorLabel; `projectItem.setColorLabel` exists | only the bin item (all its uses) can be labelled → **set_clip_label dropped** (would recolour every use of the source). |
| move | `trackItem.move(1)` (seconds) on the +12 s V1 piece | V1 piece → +13–18 s; **linked A1 did not move** — move each item of a linked pair together. |
| ripple delete | `trackItem.remove(true, true)` on V1 4–10 | later V1 13–18 → 11–16 and A1 12–17 → 10–15: shifted only **2 s** (the gap free on every track, A1 occupied 4–10) — Premiere's ripple respects other tracks. close_gaps must shift later items itself (move each item after the gap on every track by the same amount) rather than rely on ripple. Plain `remove(false, false)` deletes without shifting (used throughout Phase 1). |
| volume | audio item `components` → "Volume" → property "Level" `getValue()` 0.17783 at 0 dB; `setValue(0.5, true)` reads back 0.5 | Level is linear: dB = 20·log10(v) + 15 (0.17783 ↔ 0 dB). Channel Volume also present. |
| track mute | `audioTracks[0].setMute(1)` / `isMuted()` | toggles and restores. |
| video transition | `qe.project.getVideoTransitionByName("Cross Dissolve")`, `qeItem.addTransition(tr, true, "00:00:00:10", "00:00:00:00", 0.5, false, true)` | track numTransitions 1 → 3 (2 per call, as for audio); removing the clips removed them (back to 1). |
| speed | QE item `setSpeed(2, "", false, false, false)` | `getSpeed()` 2; the clip keeps its timeline length (11–16) and its reported in point halves (5.15) — content plays at 2×; linked A1 unchanged. Undo: setSpeed(previous). |
