import type { ClipInfo } from "../api/types";

/**
 * Why Phase 1 can't trim this clip, or null if it can. Word times map to the timeline as
 * clip_start + t, which only holds at normal speed, so retimed clips are refused rather
 * than given confidently misplaced cuts.
 */
export function clipProblem(clip: ClipInfo): string | null {
  if (!clip.found) return "No matching clip on the active sequence. Select one, or type its name.";
  if (clip.speed < 0) return `${clip.name} is reversed. Genius Cut can only trim clips playing forwards at 100% speed.`;
  if (Math.abs(clip.speed - 1) > 1e-6) {
    return `${clip.name} plays at ${Math.round(clip.speed * 100)}% speed. Genius Cut can only trim clips at 100% for now.`;
  }
  return null;
}
