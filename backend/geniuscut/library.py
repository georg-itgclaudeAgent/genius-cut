"""The style library: before/after examples of the editor's own trims.

Layout under the library dir (`<data dir>/library/` in production):

    examples/<id>.json      one StyleExample per file
    style-summary.md        ≤25 recurring rules distilled by Claude

`removed_spans` is always *derived* by diffing the raw transcript against the final
text — the editor only ever supplies the two transcripts.
"""

import difflib
import logging
import re
import string
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from geniuscut import spend
from geniuscut.models import RemovedSpan, StyleExample, Word

log = logging.getLogger(__name__)

SUMMARY_FILE = "style-summary.md"
SUMMARY_THRESHOLD = 12   # at this many examples, switch to summary + recent
ALL_EXAMPLES_CAP = 6
RECENT_WITH_SUMMARY = 3
MAX_RULES = 25

_PUNCT = str.maketrans("", "", string.punctuation + "“”‘’—–…")


def _norm(token: str) -> str:
    return token.lower().translate(_PUNCT)


def derive_removed_spans(raw_words: list[Word], final_text: str) -> list[RemovedSpan]:
    """Raw words the final text dropped or replaced, as spans with raw-side timings."""
    raw = [_norm(w.w) for w in raw_words]
    final = [t for t in (_norm(t) for t in final_text.split()) if t]
    spans = []
    for op, i1, i2, _, _ in difflib.SequenceMatcher(a=raw, b=final, autojunk=False).get_opcodes():
        if op in ("delete", "replace") and i2 > i1:
            removed = raw_words[i1:i2]
            spans.append(RemovedSpan(
                start=removed[0].start,
                end=removed[-1].end,
                text=" ".join(w.w for w in removed),
            ))
    return spans


def _slug(source_clip: str) -> str:
    stem = Path(source_clip).stem.lower()
    return re.sub(r"[^a-z0-9]+", "-", stem).strip("-") or "clip"


def add_example(
    raw_words: list[Word], final_text: str, source_clip: str, library_dir: Path, now: str | None = None,
) -> StyleExample:
    created = now or datetime.now().astimezone().isoformat(timespec="seconds")
    examples_dir = Path(library_dir) / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)
    base = f"{created[:10]}-{_slug(source_clip)}"
    ex_id, n = base, 2
    while (examples_dir / f"{ex_id}.json").exists():
        ex_id, n = f"{base}-{n}", n + 1
    example = StyleExample(
        id=ex_id,
        created=created,
        source_clip=source_clip,
        raw_words=raw_words,
        final_text=final_text,
        removed_spans=derive_removed_spans(raw_words, final_text),
    )
    (examples_dir / f"{ex_id}.json").write_text(example.model_dump_json(indent=2), encoding="utf-8")
    return example


def list_examples(library_dir: Path) -> list[StyleExample]:
    """All examples, most recent first."""
    examples_dir = Path(library_dir) / "examples"
    if not examples_dir.is_dir():
        return []
    examples = []
    for path in examples_dir.glob("*.json"):
        try:
            examples.append(StyleExample.model_validate_json(path.read_text(encoding="utf-8")))
        except Exception as e:  # noqa: BLE001 — one bad file must not break every trim
            log.warning("Skipping unreadable style example %s: %s", path.name, e)
    return sorted(examples, key=lambda e: _when(e.created), reverse=True)


def _when(created: str) -> datetime:
    try:
        dt = datetime.fromisoformat(created)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return dt if dt.tzinfo else dt.astimezone()  # naive → treat as local time


def load_summary(library_dir: Path) -> str | None:
    path = Path(library_dir) / SUMMARY_FILE
    return path.read_text(encoding="utf-8") if path.exists() else None


@dataclass
class FewShot:
    summary: str | None
    examples: list[StyleExample]


def build_fewshot(library_dir: Path) -> FewShot:
    """Under 12 examples: up to 6, most recent first. At 12+: the summary plus the 3 most recent."""
    examples = list_examples(library_dir)
    if len(examples) >= SUMMARY_THRESHOLD:
        return FewShot(summary=load_summary(library_dir), examples=examples[:RECENT_WITH_SUMMARY])
    return FewShot(summary=None, examples=examples[:ALL_EXAMPLES_CAP])


def _describe(example: StyleExample) -> str:
    removed = "\n".join(f'  - "{s.text}"' for s in example.removed_spans) or "  (nothing removed)"
    return f"Clip {example.source_clip}\nFinal: {example.final_text}\nRemoved:\n{removed}"


def regenerate_summary(library_dir: Path, llm: Callable[[str], str]) -> str:
    """Ask the model to distil every example into ≤25 rules, and store them."""
    examples = list_examples(library_dir)
    if not examples:
        raise ValueError("Add at least one style example before generating a summary.")
    prompt = (
        "These are before/after examples of how one video editor trims interview footage. "
        "For each, you see the final kept text and the exact phrases the editor removed.\n\n"
        + "\n\n".join(_describe(e) for e in examples)
        + f"\n\nWrite at most {MAX_RULES} short rules, one per line starting with '- ', that "
        "describe this editor's cutting style: what they remove, what they always keep, and any "
        "patterns in how much they trim. Base every rule on the examples; don't add generic advice."
    )
    with spend.tagged("summary"):
        summary = llm(prompt).strip()
    (Path(library_dir) / SUMMARY_FILE).write_text(summary, encoding="utf-8")
    return summary
