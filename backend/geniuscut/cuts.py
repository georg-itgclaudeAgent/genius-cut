"""The AI (Gemini by default, see `llm.py`) proposes which words to cut, in the editor's style.

The model returns inclusive *word index* ranges, never timecodes. It's reliable at indices
and unreliable at arithmetic on times, so indices are resolved to times here, and any
range that is out of bounds, backwards or overlapping is dropped rather than applied.
"""

import logging

from geniuscut import llm, spend
from geniuscut.library import FewShot
from geniuscut.models import CutSpan, Word

log = logging.getLogger(__name__)

SCHEMA = {
    "type": "object",
    "properties": {
        "cuts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_idx": {"type": "integer"},
                    "end_idx": {"type": "integer"},
                    "reason": {"type": "string"},
                },
                "required": ["start_idx", "end_idx", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["cuts"],
    "additionalProperties": False,
}

SYSTEM = (
    "You assist a video editor who trims interview and talking-head footage in Adobe Premiere Pro. "
    "You read a word-level transcript and propose which words to remove so the clip plays tighter "
    "without changing what the speaker means. Match this editor's style as shown in their examples; "
    "when the examples don't cover a case, be conservative and keep the words. "
    "Typical removals: filler words (um, uh, you know, like), false starts, stumbles, words the "
    "speaker immediately repeats, retakes where they say the same sentence twice (keep the better, "
    "usually the later, take), and asides that are clearly off-topic or not for publication. "
    "Never cut in a way that leaves a broken or misleading sentence."
)

REASONS = "filler, false start, repeat, retake, tangent, redaction"


def _style_context(fewshot: FewShot) -> str:
    parts = []
    if fewshot.summary:
        parts.append("This editor's style rules:\n" + fewshot.summary.strip())
    for ex in fewshot.examples:
        removed = "; ".join(f'"{s.text}"' for s in ex.removed_spans) or "(nothing)"
        parts.append(f"Example — kept: {ex.final_text}\nRemoved: {removed}")
    return "\n\n".join(parts) if parts else "No style examples yet: be conservative."


def build_prompt(words: list[Word], fewshot: FewShot, instruction: str = "") -> str:
    numbered = "\n".join(f"[{i}] {w.w}" for i, w in enumerate(words))
    return (
        f"{_style_context(fewshot)}\n\n"
        + (f"The editor asked: {instruction}\n\n" if instruction else "")
        + "Transcript, one word per line with its index:\n"
        f"{numbered}\n\n"
        "Return the words to remove as ranges of word indices. start_idx and end_idx are both "
        "inclusive; a single word has start_idx == end_idx. Ranges must not overlap. Give each a "
        f"short reason, one of: {REASONS}. Return an empty list if nothing should be cut."
    )


def validate_ranges(raw: list[dict], n_words: int) -> list[tuple[int, int, str]]:
    """Drop anything out of range, backwards or overlapping an earlier (by position) range."""
    candidates = []
    for c in raw:
        s, e, reason = c.get("start_idx"), c.get("end_idx"), str(c.get("reason", "")).strip() or "cut"
        if not isinstance(s, int) or not isinstance(e, int) or s < 0 or e >= n_words or e < s:
            log.warning("Dropping invalid cut range %r", c)
            continue
        candidates.append((s, e, reason))
    kept: list[tuple[int, int, str]] = []
    for s, e, reason in sorted(candidates, key=lambda t: (t[0], t[1])):
        if kept and s <= kept[-1][1]:
            log.warning("Dropping overlapping cut range %r", (s, e, reason))
            continue
        kept.append((s, e, reason))
    return kept


# Long transcripts go to the model in chunks: a 90-minute clip is ~16,000 words, and one reply
# listing every cut risks the output cap (Checkpoint B, 2026-10-07). ~2,400 words is ~16 minutes.
CHUNK_WORDS = 2400
SENTENCE_END = (".", "?", "!")


def chunk_bounds(words: list[Word], size: int = CHUNK_WORDS, slack: int | None = None) -> list[tuple[int, int]]:
    """[start, end) word ranges of about `size` words, each ending at the last sentence end
    within `slack` words of the target, or exactly at `size` if there's none."""
    slack = size // 4 if slack is None else slack
    bounds, i, n = [], 0, len(words)
    while i < n:
        if n - i <= size + slack:
            bounds.append((i, n))
            break
        ends = [j for j in range(i + size - slack - 1, min(n, i + size + slack))
                if words[j].w.rstrip().endswith(SENTENCE_END)]
        end = ends[-1] + 1 if ends else i + size
        bounds.append((i, end))
        i = end
    return bounds


def propose_cuts(words: list[Word], fewshot: FewShot, instruction: str = "", client=None,
                 chunk_words: int = CHUNK_WORDS) -> list[CutSpan]:
    if not words:
        return []
    ranges = []
    for a, b in chunk_bounds(words, chunk_words):
        part = words[a:b]
        with spend.tagged("trim"):  # also when called outside run_trim, and when the call raises
            reply = llm.ask_json(build_prompt(part, fewshot, instruction), SCHEMA, system=SYSTEM, client=client)
        ranges += [(s + a, e + a, reason) for s, e, reason in validate_ranges(reply.get("cuts", []), len(part))]
    return [
        CutSpan(start=words[s].start, end=words[e].end,
                text=" ".join(w.w for w in words[s:e + 1]), reason=reason)
        for s, e, reason in ranges
    ]
