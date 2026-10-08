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
  if (named) {
    // A quoted name is taken whole; otherwise it ends where extra instructions begin
    // ("…named take3 and cut the tangents", "…named take3, keep the jokes").
    const quoted = named[1].match(/^\s*["“'‘]([^"”'’]+)["”'’]/);
    return clean(quoted ? quoted[1] : named[1].split(/\s*,|\s+(?:and|but|then)\s+/i)[0]);
  }
  const trim = text.match(/^trim\s+(?:the\s+)?(\S+)$/i);
  if (trim) return clean(trim[1]);
  return /\s/.test(text) ? null : clean(text);
}

/** The instruction box works like a chat prompt: Enter runs it, Shift+Enter starts a new line,
 *  and Enter that confirms an input-method composition (e.g. Japanese, Chinese) does neither. */
export function submitsPrompt(k: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return k.key === "Enter" && !k.shiftKey && !k.isComposing;
}
