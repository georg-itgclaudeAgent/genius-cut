# Assistant measurements (Phase 1, Task 1)

Premiere Pro 26.5.2, Windows, 2026-10-14. Run through the CEP debug port on the live project; everything at
≥ 30000 s, cleaned up afterwards (far-out items 0, marker count back to its starting value, bin marks
restored). Probes: scratchpad `probe13.jsx`, `second.jsx`, `httpprobe.mjs`.

## Sequence markers
- `seq.markers.createMarker(30005)` returns a marker; `name`, `comments`, `end` (= range marker, read back
  30005–30007) are settable; `setColorByIndex(3)` / `getColorByIndex()` → 3; `type` reads "Comment".
- Every marker has a `guid` (UUID string), distinct per marker; iterating `getFirstMarker()` /
  `getNextMarker(m)` and matching `guid` finds it exactly once. → marker id = guid.
- `seq.markers.deleteMarker(m)` removes it (count 3 → 1).

## Node ids
- `projectItem.nodeId` is the same on the original clip and on clips laid from it with `overwriteClip`
  (video and its linked audio): `000f42ab` on all three.
- TrackItems have their own `nodeId`, new for every laid clip (`000f446c` original, `000f4966` / `000f4967`
  copies) — not stable across a re-lay, so clip ids use the projectItem nodeId plus track and start.
- Walking `app.project.rootItem` (`children.numItems`, `children[k]`) and comparing `nodeId` found the
  ProjectItem (same nodeId) after visiting 4 items in 2 ms on Georg's project.

## Second host file
- `$.evalFile(new File(<path>))` from the panel loads a second .jsx whose functions call index.jsx globals
  (`gcutSequence`, `gcutClock`) successfully.

## Node HTTP in the panel
- `window.cep_node.require("http").createServer(...).listen(0, "127.0.0.1")` works; the port is readable
  from `server.address().port`; a request from the panel got the reply and a custom `X-Genius-Cut` header.

## QE undo (optional upgrade, not called)
- `typeof qe.project.undo` → "function". Not used in Phase 1.
