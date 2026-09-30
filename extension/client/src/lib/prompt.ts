/**
 * Pull a clip name out of the editor's instruction. `null` means "no name given":
 * the host then uses the selected clip.
 *
 *   "trim the clip named interview_take3"   → "interview_take3"
 *   "trim interview_take3" / "interview_take3" → "interview_take3"
 *   "trim it", "tighten this"                → null
 */
const PRONOUNS = new Set(["it", "this", "that", "them", "these", "those", "the clip", "this clip", "selected"]);

function clean(name: string): string | null {
  const n = name.trim().replace(/^["'“‘]|["'”’]$/g, "").trim();
  return n && !PRONOUNS.has(n.toLowerCase()) ? n : null;
}

export function parseClipName(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const named = text.match(/clip\s+named\s+(.+)$/i);
  if (named) return clean(named[1]);
  const trim = text.match(/^trim\s+(?:the\s+)?(\S+)$/i);
  if (trim) return clean(trim[1]);
  return /\s/.test(text) ? null : clean(text);
}
