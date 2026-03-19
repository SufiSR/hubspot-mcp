"""
LLM-optimized email preprocessing pipeline for CRM engagement data.

Transforms raw HubSpot engagement JSON into a minimal, deduplicated format
optimized for LLM token efficiency and reasoning clarity.

Pipeline stages:
  1. Delta extraction   – strip quoted reply chains, keep only new content
  2. Noise removal      – signatures, disclaimers, HTML artifacts, boilerplate
  3. Normalization       – whitespace, encoding, structure
  4. Low-value filtering – drop empty / greeting-only messages
  5. Paragraph dedup     – content-addressed deduplication across messages
  6. Chronological sort  – ascending by timestamp
"""

from __future__ import annotations

import json
import re
from typing import Any

_SUBJECT_PREFIX = re.compile(
    r"^(re|fw|fwd|aw|wg|sv|vs|antwort|réf|ref)\s*:\s*",
    re.I,
)

_STOPWORDS = frozenset({
    "the", "and", "for", "you", "are", "our", "with", "this", "that", "from",
    "have", "has", "was", "were", "will", "can", "not", "but", "your", "any",
    "all", "may", "its", "been", "also", "just", "into", "than", "then", "too",
    "very", "here", "there", "when", "what", "which", "who", "how", "about",
    "some", "such", "only", "more", "most", "other",
})

_LEADING_GREETING = re.compile(
    r"^(?:(?:Hi|Hello|Hey|Hi\s+there|Good\s+(?:morning|afternoon|evening)|Dear)\s+"
    r"[^,\n!?]{1,72},?\s+)",
    re.I,
)

_HARD_CUT_MARKERS = [
    re.compile(r"\bFrom:\s", re.I),
    re.compile(r"\bSent:\s", re.I),
    re.compile(r"\bOn\s[\s\S]{4,240}?wrote:\s*", re.I),
    re.compile(r"-{5,}"),
]

_MANGLED_SEQ = re.compile(
    r"[\u00ad\u0192\u0178\u02dc]{2,}|\xff\xe8+|ÿè|\ufffd|\ufeff",
    re.I,
)


def sanitize_utf8(text: str) -> str:
    text = text.replace("\ufffd", "").replace("\ufeff", "")
    text = text.replace("ÿè", "").replace("\xff\xe8", "")
    text = _MANGLED_SEQ.sub("", text)
    text = re.sub(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f]", "", text)
    return text


def normalize_subject_key(subject: str) -> str:
    s = sanitize_utf8(_fix_mojibake(subject.strip()))
    s = re.sub(r"\s+", " ", s).lower().strip()
    prev = ""
    while s != prev:
        prev = s
        s = _SUBJECT_PREFIX.sub("", s).strip()
    return re.sub(r"\s+", " ", s).strip()


def hard_cut_reply_chain(text: str) -> str:
    cut = len(text)
    for pat in _HARD_CUT_MARKERS:
        m = pat.search(text)
        if m and m.start() >= 8 and m.start() < cut:
            cut = m.start()
    return text[:cut].rstrip() if cut < len(text) else text


def strip_leading_greeting(text: str) -> str:
    t = text.strip()
    if len(t) < 45:
        return t
    rest = _LEADING_GREETING.sub("", t).strip()
    return rest if len(rest) >= 25 else t


def meaningful_word_count(text: str) -> int:
    words = re.findall(r"[a-z0-9][a-z0-9'-]{2,}", text.lower())
    return sum(1 for w in words if w not in _STOPWORDS)


_MIN_MEANINGFUL_WORDS = 10


def passes_content_threshold(content: str) -> bool:
    t = content.strip()
    if not t:
        return False
    n = meaningful_word_count(t)
    if re.search(r"\bhttps?://\S{8,}", t, re.I) and n >= 5:
        return True
    return n >= _MIN_MEANINGFUL_WORDS


# ---------------------------------------------------------------------------
# Stage 1 — Delta extraction: strip quoted reply chains
# ---------------------------------------------------------------------------

_QUOTE_PATTERNS_MULTILINE: list[re.Pattern] = [
    re.compile(r"^-{2,}\s*Original Message\s*-{2,}", re.I | re.M),
    re.compile(r"^-{2,}\s*Forwarded message\s*-{2,}", re.I | re.M),
    re.compile(r"^-{3,}\s*$", re.M),
    re.compile(r"^On .{10,80} wrote:\s*$", re.M),
    re.compile(r"^From:\s.+\nSent:\s.+\nTo:\s", re.M),
    re.compile(r"^Von:\s.+\nGesendet:\s.+\nAn:\s", re.M),
    re.compile(r"^De\s?:\s.+\nEnvoy[eé]\s?:\s.+\n[AÀ]\s?:\s", re.M),
    re.compile(r"^From:\s.+\nTo:\s.+\nDate:\s", re.M),
    re.compile(r"^-{4,}\s*On .+ wrote\s*-{4,}", re.M),
    re.compile(r"^>{3,}", re.M),
    re.compile(r"\n>{1,2}\s", re.M),
]

_QUOTE_PATTERNS_INLINE: list[re.Pattern] = [
    re.compile(r"\s+From:\s+\S+.*?\s+To:\s+.*?\s+(?:Date|Sent|Cc):\s", re.I),
    re.compile(r"\s+From:\s+\S+.*?\s+Sent:\s+.*?\s+To:\s", re.I),
    re.compile(r"\s+Von:\s+\S+.*?\s+Gesendet:\s+.*?\s+An:\s", re.I),
    re.compile(r"\s+-{4,}\s*On .+ wrote\s*-{4,}", re.I),
]


def strip_quoted_content(text: str) -> str:
    earliest = len(text)

    for pat in _QUOTE_PATTERNS_MULTILINE:
        m = pat.search(text)
        if m and 0 < m.start() < earliest:
            earliest = m.start()

    for pat in _QUOTE_PATTERNS_INLINE:
        m = pat.search(text)
        if m and 0 < m.start() < earliest:
            earliest = m.start()

    return text[:earliest].rstrip() if earliest < len(text) else text


# ---------------------------------------------------------------------------
# Stage 2 — Noise removal
# ---------------------------------------------------------------------------

_SIGNATURE_PATTERNS: list[re.Pattern] = [
    re.compile(r"^\[(?:cid|https?):[^\]]+\]\s*$", re.M),
    re.compile(r"\[(?:cid|https?):[^\]]+\]", re.I),
    re.compile(r"\[(?:Linkedin|Twitter|Facebook|Youtube|Instagram|X|Smile)\]", re.I),
    re.compile(r"\[(?:Maria Munoz|Gunner? Leu)\]", re.I),
]

_SIGNATURE_START_MULTILINE: list[re.Pattern] = [
    re.compile(r"^_{5,}\s*$", re.M),
    re.compile(r"^(?:Best|Kind|Warm)\s+regards?\s*,?\s*$", re.I | re.M),
    re.compile(r"^(?:Mit freundlichen Grüßen|Cordialement|Saludos)\s*,?\s*$", re.I | re.M),
    re.compile(r"^Wishing you a wonderful", re.I | re.M),
    re.compile(r"^Thanks?,?\s*(?:and\s+)?(?:Kind|Best)?\s*regards?\s*,?\s*$", re.I | re.M),
]

_INLINE_SIG_CUTOFF: list[re.Pattern] = [
    re.compile(
        r"(?:Best|Kind|Warm)\s+regards?\s*,?\s+"
        r"(?:[A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+){0,5})\s+"
        r"(?:(?:Sales|Office|Team|Revenue|Managing|Project)\s+(?:Consultant|Manager|Lead|Head|Director)\s*)?",
        re.I,
    ),
    re.compile(r"_{5,}\s*\[?[A-Za-z]", re.I),
]

_DISCLAIMER_PATTERNS: list[re.Pattern] = [
    re.compile(r"Disclaimer:\s*This e-mail.*$", re.I | re.S),
    re.compile(r"This message contains confidential.*$", re.I | re.S),
    re.compile(r"This e-mail and any attached content may contain confidential.*$", re.I | re.S),
    re.compile(r"If you are not the (?:intended |named )?(?:recipient|addressee).*$", re.I | re.S),
    re.compile(r"Plunet GmbH,?\s*Commercial Register.*$", re.I | re.M),
    re.compile(r"Managing Director:.*$", re.I | re.M),
]

_SECURITY_WARNING = re.compile(
    r"Warning\s*-\s*External message:.*?(?:#Internal-IT-Support\s*(?:for help)?|for help)[\s.]*",
    re.I | re.S,
)

_HTML_TAGS = re.compile(r"<[^>]+>")
_HTML_ENTITIES = re.compile(r"&(?:nbsp|amp|lt|gt|quot);")

_FREQUENCY_WARNING = re.compile(
    r"Sie erhalten nicht häufig.*?(?:wichtig ist|why this is important)\s*",
    re.I | re.S,
)

_TEAMS_BLOCK = re.compile(
    r"_{5,}\s*Microsoft Teams meeting.*?_{5,}",
    re.I | re.S,
)

_PROMO_PATTERNS: list[re.Pattern] = [
    re.compile(r"This was the Plunet Summit \d{4}\s*Check Out Our Best Practice Sessions Now!", re.I),
    re.compile(r"Check Out Our Best Practice Sessions Now!", re.I),
]

_MOJIBAKE_MAP = {
    "├¡": "í", "├▒": "ñ", "├╝": "ü", "├ñ": "ñ", "├á": "á",
    "├╗": "û", "├¡": "í", "┬á": " ",
    "ÔÇô": "–", "ÔÇö": "—", "ÔÇ║": "", "ÔÇÖ": "'", "ÔÇª": "…",
    "ÔÇï": "", "ÔÇ£": '"', "ÔÇ¥": '"',
    "Ô£¿": "",
    "\u0027": "'",
}

_BRACKET_JUNK = re.compile(r"\[(?:X|Smile|cid:[^\]]*)\]", re.I)
_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_ADDR_LINE = re.compile(
    r"(?:D-\d{5}\s+\w+|Dresdener\s+Str\.?\s*\d+)\s*",
    re.I,
)
_URL_LINE = re.compile(r"www\.\w[\w.]+\.\w{2,}", re.I)
_PHONE_BLOCK = re.compile(r"\+\d[\d\s()-]{6,}", re.I)
_CITY_LINE = re.compile(
    r"(?:Manila|Berlin|London|Sheffield|San Francisco)"
    r"(?:\s*\|\s*(?:Manila|Berlin|London|Sheffield|San Francisco|UK))+",
    re.I,
)
_PERSON_TITLE_BLOCK = re.compile(
    r"(?:Sales Consultant|Office Manager|Team Lead Sales|Revenue Head|"
    r"Managing Director|Project Manager)\s*",
    re.I,
)
_COMPANY_REG = re.compile(
    r"(?:Plunet\s+GmbH|QwertyWorks\.com)(?:\s+Dresdener)?",
    re.I,
)


def _fix_mojibake(text: str) -> str:
    for bad, good in _MOJIBAKE_MAP.items():
        text = text.replace(bad, good)
    text = text.replace("\t", " ")
    return text


def remove_noise(text: str) -> str:
    text = _HTML_TAGS.sub("", text)
    text = _HTML_ENTITIES.sub(" ", text)
    text = _SECURITY_WARNING.sub("", text)
    text = _FREQUENCY_WARNING.sub("", text)
    text = _TEAMS_BLOCK.sub("[Teams meeting link]", text)

    for pat in _DISCLAIMER_PATTERNS:
        text = pat.sub("", text)

    for pat in _SIGNATURE_PATTERNS:
        text = pat.sub("", text)

    for pat in _PROMO_PATTERNS:
        text = pat.sub("", text)

    text = _BRACKET_JUNK.sub("", text)

    lines = text.split("\n")
    sig_start = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        for pat in _SIGNATURE_START_MULTILINE:
            if pat.match(stripped):
                remaining = "\n".join(lines[i + 1:]).strip()
                if len(remaining) < 600 and not any(
                    len(rl.strip()) > 100 for rl in remaining.split("\n") if rl.strip()
                ):
                    sig_start = i
                    break
        if sig_start is not None:
            break

    if sig_start is not None:
        lines = lines[:sig_start]

    text = "\n".join(lines)

    for pat in _INLINE_SIG_CUTOFF:
        m = pat.search(text)
        if m and m.start() > 20:
            text = text[:m.start()].rstrip()

    text = _PERSON_TITLE_BLOCK.sub("", text)
    text = _COMPANY_REG.sub("", text)
    text = _ADDR_LINE.sub("", text)
    text = _PHONE_BLOCK.sub("", text)
    text = _CITY_LINE.sub("", text)

    return text


# ---------------------------------------------------------------------------
# Stage 3 — Normalization
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    text = _MULTI_SPACE.sub(" ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"^\s+$", "", text, flags=re.M)
    text = text.strip()
    return text


# ---------------------------------------------------------------------------
# Stage 4 — Low-value message detection
# ---------------------------------------------------------------------------

_LOW_VALUE = re.compile(
    r"^(?:thanks?|thank you|ok|okay|got it|noted|sure|sounds good|"
    r"will do|acknowledged|received|great|perfect|awesome|"
    r"hi|hello|hey|dear\s+\w+)[.!,]?\s*$",
    re.I,
)


def is_low_value(text: str) -> bool:
    cleaned = text.strip()
    if not cleaned:
        return True
    if _LOW_VALUE.match(cleaned):
        return True
    words = cleaned.split()
    if len(words) <= 3 and not any(len(w) > 15 for w in words):
        if _LOW_VALUE.match(words[0].rstrip(".,!?")):
            return True
    return False


# ---------------------------------------------------------------------------
# Stage 5 — Paragraph-level deduplication
# ---------------------------------------------------------------------------

def _normalize_for_dedup(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def deduplicate_paragraphs(
    messages: list[dict], body_key: str = "content"
) -> list[dict]:
    seen: set[str] = set()
    for msg in messages:
        body = msg.get(body_key, "")
        if not body:
            continue
        paras = re.split(r"\n\s*\n", body)
        unique = []
        for p in paras:
            p = p.strip()
            if not p:
                continue
            norm = _normalize_for_dedup(p)
            if len(norm) < 50:
                unique.append(p)
                continue
            if norm in seen:
                continue
            seen.add(norm)
            unique.append(p)
        msg[body_key] = "\n\n".join(unique)
    return messages


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def clean_message_body(text: str) -> str:
    text = sanitize_utf8(_fix_mojibake(text.strip()))
    text = hard_cut_reply_chain(text)
    text = strip_quoted_content(text)
    text = remove_noise(text)
    text = strip_leading_greeting(text)
    text = normalize(text)
    text = sanitize_utf8(text)
    return text


def process_thread(thread: dict) -> dict | None:
    """Process an EMAIL_THREAD object. Returns cleaned thread or None if empty."""
    messages_in = thread.get("messages", [])
    if not messages_in:
        return None

    cleaned_messages: list[dict] = []
    for msg in sorted(messages_in, key=lambda m: m.get("timestamp", "")):
        body = msg.get("body", "")
        content = clean_message_body(body)

        if not passes_content_threshold(content):
            continue

        direction = msg.get("direction", "")
        sender = ""
        if direction and direction.startswith("from: "):
            sender = direction[6:]

        participants = thread.get("participants", []) or []
        f_low = sender.lower()
        to_list = list({p for p in participants if p.lower() != f_low})

        cleaned_messages.append({
            "timestamp": msg.get("timestamp"),
            "from": sender,
            "to": to_list,
            "content": content,
        })

    if not cleaned_messages:
        return None

    cleaned_messages = deduplicate_paragraphs(cleaned_messages)
    cleaned_messages = [m for m in cleaned_messages if m.get("content", "").strip()]

    if not cleaned_messages:
        return None

    parts = thread.get("participants", []) or []
    return {
        "subject": normalize_subject_key(str(thread.get("subject", ""))),
        "participants": list({sanitize_utf8(_fix_mojibake(p.strip())) for p in parts}),
        "messages": cleaned_messages,
    }


def process_engagement(eng: dict) -> dict | None:
    """Process a non-thread engagement (NOTE, TASK, MEETING, CALL)."""
    body = eng.get("body", "")
    content = clean_message_body(body)

    if not passes_content_threshold(content):
        return None

    return {
        "type": eng.get("type"),
        "timestamp": eng.get("timestamp"),
        "subject": normalize_subject_key(str(eng.get("subject", ""))),
        "content": content,
    }


def process_engagements(data: dict) -> dict:
    """
    Main entry point. Takes the MCP engagement_summary_associated output
    and returns LLM-optimized JSON.
    """
    engagements = data.get("engagements", [])
    threads: list[dict] = []
    other: list[dict] = []

    for eng in engagements:
        etype = eng.get("type", "")
        if etype == "EMAIL_THREAD":
            result = process_thread(eng)
            if result:
                threads.append(result)
        else:
            result = process_engagement(eng)
            if result:
                other.append(result)

    def _dedupe_msgs(msgs: list[dict]) -> list[dict]:
        seen: set[str] = set()
        out: list[dict] = []
        for m in msgs:
            key = f"{m.get('timestamp')}|{m.get('from')}|{_normalize_for_dedup(m.get('content', ''))}"
            if key in seen:
                continue
            seen.add(key)
            out.append(m)
        return out

    merged: dict[str, dict] = {}
    for t in threads:
        key = str(t.get("subject", ""))
        if key not in merged:
            merged[key] = t
            continue
        ex = merged[key]
        ps = set(ex.get("participants", [])) | set(t.get("participants", []))
        combined = list(ex.get("messages", [])) + list(t.get("messages", []))
        combined.sort(key=lambda m: m.get("timestamp", ""))
        ex["participants"] = list(ps)
        ex["messages"] = _dedupe_msgs(combined)

    threads = list(merged.values())

    deduplicate_paragraphs(
        [*other, *[m for t in threads for m in t["messages"]]],
        body_key="content",
    )

    for t in threads:
        t["messages"] = [m for m in t["messages"] if m.get("content", "").strip()]

    threads = [t for t in threads if t["messages"]]

    return {
        "threads": threads,
        "other_engagements": other,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import sys

    if len(sys.argv) < 2:
        print("Usage: python email_cleaner.py <input.json> [output.json]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

    with open(input_path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)

    result = process_engagements(data)
    output = json.dumps(result, indent=2, ensure_ascii=False)

    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(output)
        input_size = len(json.dumps(data, ensure_ascii=False))
        output_size = len(output)
        print(f"Input:  {input_size:,} chars")
        print(f"Output: {output_size:,} chars")
        print(f"Reduction: {(1 - output_size / input_size) * 100:.1f}%")
    else:
        print(output)


if __name__ == "__main__":
    main()
