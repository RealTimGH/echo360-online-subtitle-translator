#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VTT subtitle translator.

Supports providers:
- deepl
- openai (Responses API)
- deepseek (OpenAI-compatible Responses API)
- gemini (Gemini generateContent API)
- google-web (experimental, unofficial web endpoint)
- argos (local Argos Translate models; English source)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Callable, List
from urllib.parse import quote

import requests

DEEPL_DEFAULT_CHUNK_SIZE = 160
DEEPL_DEFAULT_CONCURRENCY = 1
DEEPL_DEFAULT_MAX_RETRIES = 2

OPENAI_DEFAULT_CHUNK_SIZE = 5
OPENAI_DEFAULT_CONCURRENCY = 96
OPENAI_DEFAULT_MAX_RETRIES = 1
OPENAI_DEFAULT_MAX_CHARS = 1200
OPENAI_DEFAULT_MAX_PARAGRAPHS = 6
OPENAI_DEFAULT_MODEL = "gpt-5-nano"
OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses"
OPENAI_REASONING_EFFORT_CHOICES = {"none", "minimal", "low", "medium", "high", "xhigh"}

DEEPSEEK_DEFAULT_CHUNK_SIZE = 5
DEEPSEEK_DEFAULT_CONCURRENCY = 96
DEEPSEEK_DEFAULT_MAX_RETRIES = 1
DEEPSEEK_DEFAULT_MAX_CHARS = 1200
DEEPSEEK_DEFAULT_MAX_PARAGRAPHS = 6
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT = f"{DEEPSEEK_BASE_URL}/chat/completions"

GEMINI_DEFAULT_CHUNK_SIZE = 5
GEMINI_DEFAULT_CONCURRENCY = 96
GEMINI_DEFAULT_MAX_RETRIES = 1
GEMINI_DEFAULT_MAX_CHARS = 1200
GEMINI_DEFAULT_MAX_PARAGRAPHS = 6
GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

WEB_TRANSLATOR_DEFAULT_CHUNK_SIZE = 1
# Match the 1.4.2 Google Web speed profile. A zero RPS means that the
# translator does not add a pacing delay between requests.
GOOGLE_WEB_DEFAULT_CONCURRENCY = 96
GOOGLE_WEB_DEFAULT_RPS = 0.0
GOOGLE_WEB_MAX_RPS = 0.0
GOOGLE_WEB_MAX_RETRIES = 2
GOOGLE_WEB_DEFAULT_MAX_CHARS = 1200
GOOGLE_WEB_DEFAULT_MAX_PARAGRAPHS = 1
WEB_TRANSLATOR_DEFAULT_MAX_RETRIES = 1
ARGOS_DEFAULT_CHUNK_SIZE = 6
ARGOS_DEFAULT_CONCURRENCY = 1
ARGOS_DEFAULT_MAX_CHARS = 1200
ARGOS_DEFAULT_MAX_PARAGRAPHS = 6
ARGOS_DEFAULT_MAX_RETRIES = 0
ARGOS_SOURCE_CODE = "en"
ARGOS_TARGET_MAP = {
    "ZH": "zh",
    "ZH-HK": "zt",
    "JA": "ja",
    "KO": "ko",
    "FR": "fr",
    "DE": "de",
    "ES": "es",
    "IT": "it",
    "PT": "pt",
    "RU": "ru",
    "AR": "ar",
    "HI": "hi",
}
KEYLESS_PROVIDERS = {"google-web", "argos"}
SPLIT_FALLBACK_PROVIDERS = {"openai", "deepseek", "gemini", "google-web"}

AI_LINE_SEPARATOR = "\n<<<VTT_TRANSLATOR_LINE_BREAK_8F3B>>>\n"
YUE_TARGET_CODES = {"YUE", "CANTONESE"}
TRADITIONAL_CHINESE_TARGET_CODES = {"ZH-HK"}
CJK_TARGET_CODES = {"ZH", "ZH-HK", "YUE", "CANTONESE"}
SUPPORTED_TARGET_CODES = {
    "ZH", "ZH-HK", "YUE", "CANTONESE", "EN", "JA", "KO", "FR", "DE",
    "ES", "IT", "PT", "RU", "AR", "HI",
}
FALLBACK_MODES = {"immediate", "deferred", "deferred-fastpath"}

CLI_ERROR_CODES = {
    "INVALID_REQUEST",
    "INVALID_SOURCE_VTT",
    "EMPTY_TRANSLATABLE_VTT",
    "UNSUPPORTED_PROVIDER",
    "UNSUPPORTED_TARGET_LANGUAGE",
    "PROVIDER_API_KEY_MISSING",
    "INVALID_REASONING_EFFORT",
    "UNSUPPORTED_PROVIDER_PROTOCOL",
    "INVALID_PROVIDER_RESPONSE",
    "INVALID_PROVIDER_OUTPUT",
    "PROVIDER_REQUEST_FAILED",
    "NETWORK_ERROR",
    "REQUEST_TIMEOUT",
    "TRANSLATION_TIMEOUT",
    "NO_TARGET_TRANSLATION",
    "TRANSLATION_CANCELLED",
    "TRANSLATOR_INPUT_MISSING",
    "TRANSLATOR_INPUT_READ_FAILED",
    "TRANSLATOR_OUTPUT_WRITE_FAILED",
    "TRANSLATOR_PROGRESS_WRITE_FAILED",
    "TRANSLATOR_PROCESS_FAILED",
    "ARGOS_DEPENDENCY_MISSING",
    "ARGOS_MODEL_MISSING",
}

TIMECODE_RE = re.compile(
    r"^\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}\s*-->\s*"
    r"(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}"
)
WEBVTT_RE = re.compile(r"^\s*WEBVTT", re.IGNORECASE)
INDEX_RE = re.compile(r"^\s*\d+\s*$")
VOICE_TAG_RE = re.compile(r"^(?P<prefix>\s*<v\b[^>]*>)(?P<body>.*?)(?P<suffix>\s*</v>\s*)?$")


def _error_code_from_text(message: str) -> str:
    text = str(message or "").upper()
    for code in sorted(CLI_ERROR_CODES, key=len, reverse=True):
        if code in text:
            return code
    if "NO_TARGET_TRANSLATION" in text:
        return "NO_TARGET_TRANSLATION"
    status = re.search(r"HTTP[_\s]+(\d{3})", text)
    if status:
        return f"HTTP_{status.group(1)}"
    if "TIMEOUT" in text or "TIMED OUT" in text:
        return "REQUEST_TIMEOUT"
    if any(marker in text for marker in (
        "INVALID_PROVIDER_OUTPUT",
        "OUTPUT LENGTH MISMATCH",
        "MISSING OUTPUT",
        "MISSING CHOICES",
        "NOT A JSON ARRAY",
        "JSONDECODE",
        "JSON DECODE",
        "EMPTY TRANSLATION RESPONSE",
    )):
        return "INVALID_PROVIDER_OUTPUT"
    if "JSON" in text and ("PARSE" in text or "DECODE" in text or "RESPONSE" in text):
        return "INVALID_PROVIDER_RESPONSE"
    if any(marker in text for marker in ("NETWORK", "CONNECTION", "FAILED TO FETCH", "PROXYERROR", "CONNECTIONERROR")):
        return "NETWORK_ERROR"
    # Keep a specific fallback for an item-level provider request. The UI can
    # still distinguish this from the legacy, completely unclassified
    # TRANSLATION_ERROR used only when no provider context exists.
    return "PROVIDER_REQUEST_FAILED"


def _normalize_cli_error_code(value: object) -> str | None:
    code = re.sub(r"[^A-Z0-9_]+", "_", str(value or "").strip().upper()).strip("_")
    if re.fullmatch(r"HTTP_\d{3}", code):
        status = int(code[-3:])
        return code if 100 <= status <= 599 else None
    return code if code in CLI_ERROR_CODES else None


def _cli_error_code(error: BaseException) -> str:
    explicit = _normalize_cli_error_code(getattr(error, "code", None))
    if explicit:
        return explicit
    text = str(error or "")
    inferred = _normalize_cli_error_code(_error_code_from_text(text))
    return inferred or "TRANSLATOR_PROCESS_FAILED"


def _emit_cli_error(code: str, message: object, *, phase: str = "translation") -> None:
    normalized = _normalize_cli_error_code(code) or "TRANSLATOR_PROCESS_FAILED"
    safe_message = _safe_error_text(message or "翻译进程失败", 800)
    payload = {
        "code": normalized,
        "message": safe_message,
        "phase": phase,
    }
    # These two markers are intentionally line-oriented. The backend merges
    # stdout/stderr from the subprocess and can therefore recover the exact
    # diagnosis even when the process exits before producing RESULT_SUMMARY.
    print(f"ERROR_CODE: {normalized}", file=sys.stderr, flush=True)
    print(f"ERROR_SUMMARY: {json.dumps(payload, ensure_ascii=False, sort_keys=True)}", file=sys.stderr, flush=True)


def _safe_error_text(message: object, limit: int = 240) -> str:
    """Keep item diagnostics useful without echoing credentials or signed URLs."""
    text = str(message or "").replace("\r", " ").replace("\n", " ")
    text = re.sub(
        r"(?i)(\b(?:authorization|bearer|api[_-]?key|client[_-]?key|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|secret|key|signature|sig|x-amz-signature|expires|x-amz-expires)\b\s*[:=]\s*)(?:(?:bearer|basic|deepl-auth-key)\s+)?[^\s,;&}]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(
        r"(?i)([?&](?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|password|secret|key|signature|sig|x-amz-signature|expires|x-amz-expires)=)[^&#\s]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)\b(?:Bearer|Basic|DeepL-Auth-Key)\s+[^\s,;&}]+", "Bearer [REDACTED]", text)
    text = re.sub(r"(?i)\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED_KEY]", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _http_error(status_code: int) -> RuntimeError:
    """Create a typed HTTP error without copying an upstream response body.

    Provider bodies can contain request echoes, account identifiers, or other
    sensitive diagnostics. The status is enough for retry/classification and
    is preserved on the exception for the backend/UI error model.
    """
    error = RuntimeError(f"HTTP {int(status_code)}")
    error.status_code = int(status_code)
    return error


def _failure_codes(items: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items or []:
        code = re.sub(r"[^A-Z0-9_]+", "_", str(item.get("code") or "").strip().upper()).strip("_")
        code = re.sub(r"^HTTP_+(\d{3})$", r"HTTP_\1", code)
        if not code or code in {"ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR", "FAILURE_DETAIL_MISSING"}:
            code = "FAILURE_DETAIL_MISSING"
        counts[code] = counts.get(code, 0) + 1
    return counts


def _validate_provider_batch_output(value: object, expected_len: int) -> list[str]:
    """Reject provider outputs that cannot be mapped one-to-one to inputs.

    Treating arbitrary objects as strings (for example ``str({})``) creates a
    syntactically valid VTT while silently losing the provider diagnosis. The
    translation boundary must accept only a list of non-empty strings with the
    exact requested cardinality.
    """
    if not isinstance(value, list):
        raise RuntimeError(
            f"INVALID_PROVIDER_OUTPUT: expected a list of {expected_len} items, got {type(value).__name__}"
        )
    if len(value) != expected_len:
        raise RuntimeError(
            f"INVALID_PROVIDER_OUTPUT: expected {expected_len} items, got {len(value)}"
        )
    invalid_index = next(
        (
            index
            for index, item in enumerate(value)
            if not isinstance(item, str) or not item.strip()
        ),
        None,
    )
    if invalid_index is not None:
        raise RuntimeError(
            f"INVALID_PROVIDER_OUTPUT: item {invalid_index + 1} is not a non-empty string"
        )
    return [item.strip() for item in value]


def is_timecode(line: str) -> bool:
    return bool(TIMECODE_RE.match(line))


def is_header(line: str) -> bool:
    return bool(WEBVTT_RE.match(line))


def is_index(line: str) -> bool:
    return bool(INDEX_RE.match(line))


def should_translate(line: str) -> bool:
    if not line.strip():
        return False
    # The caller now invokes this only for lines inside a timed cue. A numeric
    # caption such as "123" is valid cue text; numeric cue identifiers are
    # excluded by timed_text_line_indices() because they occur before the
    # cue's timecode.
    if is_header(line) or is_timecode(line):
        return False
    if re.match(r"^(?:NOTE|STYLE|REGION)\b", line.strip(), re.IGNORECASE):
        return False
    return True


def timed_text_line_indices(lines: List[str]) -> list[int]:
    """Return only translatable physical lines inside timed VTT cues.

    A document-wide "non-empty line" filter is unsafe for WebVTT: cue IDs,
    header metadata and NOTE/STYLE blocks are not subtitle text. Keeping the
    state machine here makes the translator's total counter and its output
    line mapping agree with the backend/extension validators.
    """
    indexes: list[int] = []
    in_cue = False
    for index, line in enumerate(lines):
        if is_timecode(line):
            in_cue = True
            continue
        if not line.strip():
            in_cue = False
            continue
        if not in_cue or not should_translate(line):
            continue
        indexes.append(index)
    return indexes


def read_text(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines(keepends=False)
    except UnicodeDecodeError:
        try:
            import chardet

            raw = path.read_bytes()
            enc = chardet.detect(raw).get("encoding") or "utf-8"
            return raw.decode(enc, errors="replace").splitlines(keepends=False)
        except Exception:
            return path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=False)


def batch_indices(total: int, batch_size: int):
    start = 0
    while start < total:
        end = min(start + batch_size, total)
        yield start, end
        start = end


def build_text_batches(
    lines: List[str],
    translatable_idx: list[int],
    chunk_size: int,
    max_chars: int = 0,
    max_paragraphs: int = 0,
    text_for_len: dict[int, str] | None = None,
) -> list[tuple[int, int, list[int]]]:
    if max_chars <= 0 and max_paragraphs <= 0:
        return [
            (start, end, translatable_idx[start:end])
            for start, end in batch_indices(len(translatable_idx), chunk_size)
        ]

    batches: list[tuple[int, int, list[int]]] = []
    current_ids: list[int] = []
    current_chars = 0
    start_ord = 0

    for ordinal, line_idx in enumerate(translatable_idx):
        text_len = len(text_for_len.get(line_idx, lines[line_idx]) if text_for_len else lines[line_idx])
        would_exceed_chars = max_chars > 0 and current_ids and (current_chars + text_len > max_chars)
        would_exceed_paragraphs = max_paragraphs > 0 and len(current_ids) >= max_paragraphs
        if would_exceed_chars or would_exceed_paragraphs:
            batches.append((start_ord, ordinal, current_ids))
            current_ids = []
            current_chars = 0
            start_ord = ordinal

        current_ids.append(line_idx)
        current_chars += text_len

    if current_ids:
        batches.append((start_ord, len(translatable_idx), current_ids))

    return batches


def provider_defaults(provider: str) -> dict[str, int | str]:
    provider_name = (provider or "deepl").strip().lower()
    if provider_name == "google-web":
        return {
            "chunk": WEB_TRANSLATOR_DEFAULT_CHUNK_SIZE,
            "concurrency": GOOGLE_WEB_DEFAULT_CONCURRENCY,
            "rps": GOOGLE_WEB_DEFAULT_RPS,
            "max_chars": GOOGLE_WEB_DEFAULT_MAX_CHARS,
            "max_paragraphs": GOOGLE_WEB_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": WEB_TRANSLATOR_DEFAULT_MAX_RETRIES,
            "endpoint": "",
            "model": "",
        }
    if provider_name == "argos":
        return {
            "chunk": ARGOS_DEFAULT_CHUNK_SIZE,
            "concurrency": ARGOS_DEFAULT_CONCURRENCY,
            "rps": 0.0,
            "max_chars": ARGOS_DEFAULT_MAX_CHARS,
            "max_paragraphs": ARGOS_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": ARGOS_DEFAULT_MAX_RETRIES,
            "endpoint": "",
            "model": "",
        }
    if provider_name == "openai":
        return {
            "chunk": OPENAI_DEFAULT_CHUNK_SIZE,
            "concurrency": OPENAI_DEFAULT_CONCURRENCY,
            "max_chars": OPENAI_DEFAULT_MAX_CHARS,
            "max_paragraphs": OPENAI_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": OPENAI_DEFAULT_MAX_RETRIES,
            "endpoint": OPENAI_RESPONSES_ENDPOINT,
            "model": OPENAI_DEFAULT_MODEL,
        }
    if provider_name == "deepseek":
        return {
            "chunk": DEEPSEEK_DEFAULT_CHUNK_SIZE,
            "concurrency": DEEPSEEK_DEFAULT_CONCURRENCY,
            "max_chars": DEEPSEEK_DEFAULT_MAX_CHARS,
            "max_paragraphs": DEEPSEEK_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": DEEPSEEK_DEFAULT_MAX_RETRIES,
            "endpoint": DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT,
            "model": DEEPSEEK_DEFAULT_MODEL,
        }
    if provider_name == "gemini":
        return {
            "chunk": GEMINI_DEFAULT_CHUNK_SIZE,
            "concurrency": GEMINI_DEFAULT_CONCURRENCY,
            "max_chars": GEMINI_DEFAULT_MAX_CHARS,
            "max_paragraphs": GEMINI_DEFAULT_MAX_PARAGRAPHS,
            "max_retries": GEMINI_DEFAULT_MAX_RETRIES,
            "endpoint": GEMINI_BASE_URL,
            "model": GEMINI_DEFAULT_MODEL,
        }
    return {
        "chunk": DEEPL_DEFAULT_CHUNK_SIZE,
        "concurrency": DEEPL_DEFAULT_CONCURRENCY,
        "max_retries": DEEPL_DEFAULT_MAX_RETRIES,
        "endpoint": "https://api-free.deepl.com/v2/translate",
        "model": "",
    }


def normalize_openai_compatible_endpoint(endpoint: str, provider: str) -> str:
    ep = (endpoint or "").strip()
    if not ep:
        if provider == "openai":
            return OPENAI_RESPONSES_ENDPOINT
        return DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT

    if provider == "deepseek" and ep.startswith("https://api.deepseek.com"):
        if ep.endswith("/chat/completions") or ep.endswith("/v1/chat/completions"):
            return ep
        return DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT

    if ep.endswith("/v1/responses"):
        return ep

    if provider == "openai" and ep.startswith("https://api.openai.com"):
        return ep.rstrip("/") + "/v1/responses"

    return ep


def normalize_gemini_endpoint(endpoint: str, model: str) -> str:
    ep = (endpoint or GEMINI_BASE_URL).strip().rstrip("/")
    if ep.endswith(":generateContent"):
        return ep
    if "/models/" in ep:
        return f"{ep}:generateContent"
    return f"{ep}/models/{model}:generateContent"


def split_voice_tag(line: str) -> tuple[str, str, str]:
    match = VOICE_TAG_RE.match(line)
    if not match:
        return "", line.strip(), ""
    return match.group("prefix") or "", (match.group("body") or "").strip(), match.group("suffix") or ""


def _format_ai_target_language(target_lang: str) -> str:
    code = (target_lang or "").strip().upper()
    if code in YUE_TARGET_CODES:
        return (
            "Traditional Cantonese (Yue Chinese), using Traditional Chinese characters "
            "and natural spoken Cantonese phrasing"
        )
    if code in TRADITIONAL_CHINESE_TARGET_CODES:
        return (
            "Traditional Chinese, using native Traditional Chinese wording, punctuation, "
            "and style that feels natural to Traditional Chinese readers"
        )
    return target_lang


def _resolve_deepl_target_lang(target_lang: str) -> str:
    code = (target_lang or "").strip().upper()
    if code in TRADITIONAL_CHINESE_TARGET_CODES:
        return "ZH-HANT"
    return target_lang


def _resolve_argos_target_lang(target_lang: str) -> str:
    code = (target_lang or "ZH").strip().upper()
    if code in YUE_TARGET_CODES:
        raise ValueError(
            f"UNSUPPORTED_TARGET_LANGUAGE: provider=argos does not support target={code}; "
            "use an AI provider for Cantonese"
        )
    if code == "EN":
        raise ValueError(
            "UNSUPPORTED_TARGET_LANGUAGE: provider=argos uses English as its source language; "
            "target=EN would not translate the subtitles"
        )
    try:
        return ARGOS_TARGET_MAP[code]
    except KeyError as exc:
        raise ValueError(
            f"UNSUPPORTED_TARGET_LANGUAGE: provider=argos does not support target={code}"
        ) from exc


def _load_argos_translate_module():
    # Argos 1.11 installs Stanza, whose default sentencizer may fetch its
    # resource index on first use. MiniSBD ships with Argos and keeps this
    # provider offline; an explicit environment setting remains authoritative.
    os.environ.setdefault("ARGOS_CHUNK_TYPE", "MINISBD")
    try:
        from argostranslate import translate as argos_translate
        from argostranslate import sbd as argos_sbd
    except (ImportError, ModuleNotFoundError) as exc:
        raise RuntimeError(
            "ARGOS_DEPENDENCY_MISSING: install the optional Argos runtime with "
            "'python -m pip install --upgrade pip' then "
            "'python -m pip install -r backend/requirements-argos.txt'"
        ) from exc
    sentence_model = Path(argos_sbd.minisbd_models.cache_dir) / "en.onnx"
    if not sentence_model.is_file():
        raise RuntimeError(
            "ARGOS_MODEL_MISSING: MiniSBD English sentence model is not installed; run "
            "'python -c \"from argostranslate import sbd; "
            "sbd.minisbd_models.download_models([\\\"en\\\"])\"' while online"
        )
    return argos_translate


def argos_translate_batch(texts: List[str], target_lang: str) -> List[str]:
    """Translate an English subtitle batch with already-installed Argos models."""
    target_code = _resolve_argos_target_lang(target_lang)
    argos_translate = _load_argos_translate_module()
    try:
        installed_languages = list(argos_translate.get_installed_languages())
    except Exception as exc:
        raise RuntimeError(f"ARGOS_MODEL_MISSING: unable to inspect installed models: {exc}") from exc

    languages = {str(language.code).lower(): language for language in installed_languages}
    source_language = languages.get(ARGOS_SOURCE_CODE)
    target_language = languages.get(target_code)
    translation = (
        source_language.get_translation(target_language)
        if source_language is not None and target_language is not None
        else None
    )
    if translation is None:
        installed_codes = ",".join(sorted(languages)) or "none"
        raise RuntimeError(
            f"ARGOS_MODEL_MISSING: no installed translation path {ARGOS_SOURCE_CODE}->{target_code}; "
            f"run 'argospm update' and 'argospm install translate-{ARGOS_SOURCE_CODE}_{target_code}'; "
            f"installed_languages={installed_codes}"
        )

    translated = [str(translation.translate(text)).strip() for text in texts]
    return _validate_provider_batch_output(translated, len(texts))


def _resolve_web_target_lang(target_lang: str, provider: str) -> str:
    code = (target_lang or "ZH").strip().upper()
    google_map = {
        "ZH": "zh-CN",
        "ZH-HK": "zh-TW",
        "YUE": "yue",
        "CANTONESE": "yue",
        "JA": "ja",
        "KO": "ko",
        "EN": "en",
        "FR": "fr",
        "DE": "de",
        "ES": "es",
        "IT": "it",
        "PT": "pt",
        "RU": "ru",
        "AR": "ar",
        "HI": "hi",
    }
    return google_map.get(code, code.lower())


def google_web_translate_batch(
    texts: List[str],
    target_lang: str,
    max_retries: int = WEB_TRANSLATOR_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    request_timeout: float = 30.0,
    rps: float = GOOGLE_WEB_DEFAULT_RPS,
) -> List[str]:
    # Unofficial endpoint used only for local experimental testing. It can break or rate-limit.
    target = _resolve_web_target_lang(target_lang, "google-web")
    requested_or_default_rps = max(0.0, float(rps or GOOGLE_WEB_DEFAULT_RPS))
    effective_rps = (
        max(0.1, min(requested_or_default_rps, GOOGLE_WEB_MAX_RPS))
        if GOOGLE_WEB_MAX_RPS > 0
        else requested_or_default_rps
    )
    effective_retries = min(GOOGLE_WEB_MAX_RETRIES, max(0, int(max_retries or 0)))
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
    })
    out: list[str] = []
    next_request_at = 0.0
    for item_index, text in enumerate(texts):
        url = (
            "https://translate.googleapis.com/translate_a/single"
            f"?client=gtx&sl=auto&tl={quote(target)}&dt=t&q={quote(text)}"
        )
        attempt = 0
        while True:
            if effective_rps > 0:
                wait_for = next_request_at - time.monotonic()
                if wait_for > 0:
                    time.sleep(wait_for)
                next_request_at = max(next_request_at, time.monotonic()) + (1.0 / effective_rps)
            try:
                resp = session.get(url, timeout=request_timeout)
                if resp.status_code != 200:
                    error = RuntimeError(f"HTTP {resp.status_code}")
                    error.status_code = resp.status_code
                    retry_after = resp.headers.get("Retry-After", "")
                    try:
                        retry_after_cap = GOOGLE_WEB_MAX_RPS * 10 if GOOGLE_WEB_MAX_RPS > 0 else 300.0
                        error.retry_after = max(0.0, min(float(retry_after), retry_after_cap))
                    except (TypeError, ValueError):
                        error.retry_after = None
                    raise error
                data = resp.json()
                translated = "".join(
                    part[0] for part in (data[0] or [])
                    if isinstance(part, list) and part and isinstance(part[0], str)
                ).strip()
                if not translated:
                    raise RuntimeError("empty translation response")
                out.append(translated)
                break
            except Exception as exc:
                if attempt >= effective_retries:
                    code = (
                        f"HTTP_{getattr(exc, 'status_code', '')}"
                        if getattr(exc, "status_code", None)
                        else _error_code_from_text(str(exc))
                    )
                    print(
                        f"[google-web][error] item={item_index + 1} code={code} "
                        f"message={_safe_error_text(exc)}; item failed",
                        file=sys.stderr,
                        flush=True,
                    )
                    # Do not silently turn a provider failure into a
                    # successful result containing the original text. The
                    # native translator enforces one cue per Google batch, so
                    # the normal item-failure path can record this exact cue,
                    # preserve partial progress, and prevent false caching.
                    raise
                attempt += 1
                retry_after = getattr(exc, "retry_after", None)
                delay = retry_after if retry_after is not None else min(30.0, max(2.0, base_delay * (2 ** (attempt - 1))))
                print(
                    f"[google-web][retry] item={item_index + 1} attempt={attempt}/{effective_retries} "
                    f"delay={delay:.2f}s code={getattr(exc, 'status_code', '') or _error_code_from_text(str(exc))}",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(delay)
    return out


def deepl_translate_batch(
    texts: List[str],
    endpoint: str,
    api_key: str,
    target_lang: str,
    formality: str = None,
    max_retries: int = 4,
    base_delay: float = 1.0,
    request_timeout: float = 90.0,
) -> List[str]:
    params = [("text", t) for t in texts]
    resolved_target_lang = _resolve_deepl_target_lang(target_lang)
    data = {
        "target_lang": resolved_target_lang,
        "preserve_formatting": "1",
        "split_sentences": "1",
    }
    if formality:
        data["formality"] = formality
    headers = {"Authorization": f"DeepL-Auth-Key {api_key}"}
    req_data = params + list(data.items())

    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, data=req_data, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                j = resp.json()
                return [item.get("text", "") for item in j.get("translations", [])]
            raise _http_error(resp.status_code)
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def _extract_responses_output_text(resp_json: dict) -> str:
    text = resp_json.get("output_text")
    if isinstance(text, str) and text.strip():
        return text

    output = resp_json.get("output", [])
    if isinstance(output, list):
        chunks = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content", [])
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    t = c.get("text")
                    if isinstance(t, str):
                        chunks.append(t)
        joined = "".join(chunks).strip()
        if joined:
            return joined

    raise RuntimeError("OpenAI-compatible response missing output_text")


def _strip_code_fence(raw_text: str) -> str:
    text = raw_text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


def _parse_indexed_json_text(raw_text: str, expected_len: int) -> dict[int, str]:
    text = _strip_code_fence(raw_text)
    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise RuntimeError("Model output is not a JSON array")

    out: dict[int, str] = {}
    for item in parsed:
        if not isinstance(item, dict):
            continue
        idx = item.get("i")
        val = item.get("text")
        if isinstance(idx, int) and 0 <= idx < expected_len and isinstance(val, str):
            out[idx] = val
    return out


def _build_delimited_prompt(texts: List[str], target_lang: str) -> tuple[str, str]:
    target_text = _format_ai_target_language(target_lang)
    system_text = (
        f"You are a professional {target_text} native translator who needs to fluently translate text into {target_text}.\n\n"
        "## Translation Rules\n"
        "1. Output only translated content, with no explanations or extra text.\n"
        "2. Keep exactly the same number of paragraphs/items as input.\n"
        "3. Keep non-translatable content unchanged (proper nouns, code, URLs, course codes).\n"
        "4. Do not merge, split, drop, or reorder any item.\n"
        "5. If input uses the separator token, output must use the same separator token.\n\n"
        "## OUTPUT FORMAT\n"
        "- Single item input: output only one translated item.\n"
        f"- Multi-item input: use '{AI_LINE_SEPARATOR.strip()}' as the separator between translated items."
    )
    user_text = (
        f"Translate to {target_text}. Return only translation text with exact item count and order.\n"
        "Input:\n"
        f"{AI_LINE_SEPARATOR.join(texts)}"
    )
    return system_text, user_text


def _build_indexed_json_prompt(texts: List[str], target_lang: str) -> tuple[str, str]:
    target_text = _format_ai_target_language(target_lang)
    payload = [{"i": i, "text": t} for i, t in enumerate(texts)]
    system_text = (
        "You are a subtitle translation engine. Output ONLY a JSON array. "
        "Each item must be an object with keys i and text. "
        "Do not drop, merge, reorder, or add items."
    )
    user_text = (
        f"Translate each text to {target_text}. Keep indexes unchanged.\n"
        f"Input JSON:\n{json.dumps(payload, ensure_ascii=False)}\n"
        "Return JSON array only."
    )
    return system_text, user_text


def _parse_delimited_output(raw_text: str, expected_len: int) -> List[str]:
    text = _strip_code_fence(raw_text).strip()
    parts = [part.strip() for part in text.split(AI_LINE_SEPARATOR)]
    if len(parts) != expected_len:
        compact_separator = AI_LINE_SEPARATOR.strip()
        parts = [part.strip() for part in text.split(compact_separator)]
    if len(parts) != expected_len:
        raise RuntimeError(f"AI output length mismatch: expected {expected_len}, got {len(parts)}")
    return parts


def _openai_call_responses(
    payload: dict,
    api_key: str,
    endpoint: str,
    max_retries: int,
    base_delay: float,
    request_timeout: float,
) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                return _extract_responses_output_text(resp.json())
            raise _http_error(resp.status_code)
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def _resolve_openai_reasoning_effort(model: str, requested_effort: str) -> str:
    model_lower = (model or "").strip().lower()
    requested = (requested_effort or "").strip().lower()
    if requested and requested not in OPENAI_REASONING_EFFORT_CHOICES:
        raise ValueError(
            f"INVALID_REASONING_EFFORT: reasoning_effort '{requested}' is invalid; "
            f"allowed={sorted(OPENAI_REASONING_EFFORT_CHOICES)}"
        )
    effort = requested or "low"

    # gpt-5.4 family supports none/low/medium/high/xhigh.
    if model_lower.startswith("gpt-5.4"):
        return effort if effort in {"none", "low", "medium", "high", "xhigh"} else "low"
    # gpt-5-nano family supports minimal/low/medium/high.
    if model_lower.startswith("gpt-5"):
        return effort if effort in {"minimal", "low", "medium", "high"} else "low"
    # non GPT-5 models in this tool use low as the only exposed option.
    return "low"


def _openai_call_chat_completions(
    payload: dict,
    api_key: str,
    endpoint: str,
    max_retries: int,
    base_delay: float,
    request_timeout: float,
) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                data = resp.json()
                choices = data.get("choices", [])
                if isinstance(choices, list) and choices:
                    message = choices[0].get("message", {})
                    content = message.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
                raise RuntimeError("Chat response missing choices[0].message.content")
            raise _http_error(resp.status_code)
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def _gemini_call_generate_content(
    payload: dict,
    api_key: str,
    endpoint: str,
    max_retries: int,
    base_delay: float,
    request_timeout: float,
) -> str:
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    attempt = 0
    while True:
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=request_timeout)
            if resp.status_code == 200:
                data = resp.json()
                candidates = data.get("candidates", [])
                if isinstance(candidates, list) and candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
                    if text:
                        return text
                raise RuntimeError("Gemini response missing candidates[0].content.parts text")
            raise _http_error(resp.status_code)
        except Exception:
            if attempt >= max_retries:
                raise
            attempt += 1
            time.sleep(base_delay * attempt)


def openai_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str = OPENAI_DEFAULT_MODEL,
    endpoint: str = OPENAI_RESPONSES_ENDPOINT,
    max_retries: int = OPENAI_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
    openai_reasoning_effort: str = "low",
) -> List[str]:
    def call(system_text: str, user_text: str) -> str:
        payload = {
            "model": model,
            "input": [
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": system_text}],
                },
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": user_text}],
                },
            ],
        }
        resolved_reasoning_effort = _resolve_openai_reasoning_effort(model, openai_reasoning_effort)
        if resolved_reasoning_effort:
            payload["reasoning"] = {"effort": resolved_reasoning_effort}
        return _openai_call_responses(
            payload=payload,
            api_key=api_key,
            endpoint=endpoint,
            max_retries=max_retries,
            base_delay=base_delay,
            request_timeout=request_timeout,
        )

    system_text, user_text = _build_delimited_prompt(texts, target_lang)
    raw = call(system_text, user_text)
    try:
        return _parse_delimited_output(raw, expected_len=len(texts))
    except Exception:
        if not strict_json_fallback:
            raise
        print(f"[fallback] openai batch size={len(texts)} -> indexed-json retry", file=sys.stderr)
        system_text, user_text = _build_indexed_json_prompt(texts, target_lang)
        raw = call(system_text, user_text)
        parsed = _parse_indexed_json_text(raw, expected_len=len(texts))
        if len(parsed) != len(texts):
            raise RuntimeError(f"AI output length mismatch: expected {len(texts)}, got {len(parsed)}")
        return [parsed[i].strip() for i in range(len(texts))]


def chat_completions_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str,
    endpoint: str,
    max_retries: int = DEEPSEEK_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
    extra_body: dict | None = None,
    provider_label: str = "chat-completions",
) -> List[str]:
    def call(system_text: str, user_text: str) -> str:
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_text},
                {"role": "user", "content": user_text},
            ],
            "temperature": 0,
        }
        if extra_body:
            payload.update(extra_body)
        return _openai_call_chat_completions(
            payload=payload,
            api_key=api_key,
            endpoint=endpoint,
            max_retries=max_retries,
            base_delay=base_delay,
            request_timeout=request_timeout,
        )

    system_text, user_text = _build_delimited_prompt(texts, target_lang)
    raw = call(system_text, user_text)
    try:
        return _parse_delimited_output(raw, expected_len=len(texts))
    except Exception:
        if not strict_json_fallback:
            raise
        print(f"[fallback] {provider_label} batch size={len(texts)} -> indexed-json retry", file=sys.stderr)
        system_text, user_text = _build_indexed_json_prompt(texts, target_lang)
        raw = call(system_text, user_text)
        parsed = _parse_indexed_json_text(raw, expected_len=len(texts))
        if len(parsed) != len(texts):
            raise RuntimeError(f"AI output length mismatch: expected {len(texts)}, got {len(parsed)}")
        return [parsed[i].strip() for i in range(len(texts))]


def deepseek_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str = DEEPSEEK_DEFAULT_MODEL,
    endpoint: str = DEEPSEEK_CHAT_COMPLETIONS_ENDPOINT,
    max_retries: int = DEEPSEEK_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
    no_thinking: bool = True,
) -> List[str]:
    return chat_completions_translate_batch(
        texts=texts,
        api_key=api_key,
        target_lang=target_lang,
        model=model,
        endpoint=endpoint,
        max_retries=max_retries,
        base_delay=base_delay,
        strict_json_fallback=strict_json_fallback,
        request_timeout=request_timeout,
        extra_body={"thinking": {"type": "disabled"}} if no_thinking else {"thinking": {"type": "enabled"}},
        provider_label="deepseek",
    )


def gemini_translate_batch(
    texts: List[str],
    api_key: str,
    target_lang: str,
    model: str = GEMINI_DEFAULT_MODEL,
    endpoint: str = GEMINI_BASE_URL,
    max_retries: int = GEMINI_DEFAULT_MAX_RETRIES,
    base_delay: float = 1.0,
    strict_json_fallback: bool = True,
    request_timeout: float = 90.0,
) -> List[str]:
    def call(system_text: str, user_text: str) -> str:
        payload = {
            "systemInstruction": {"parts": [{"text": system_text}]},
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "generationConfig": {"temperature": 0},
        }
        return _gemini_call_generate_content(
            payload=payload,
            api_key=api_key,
            endpoint=normalize_gemini_endpoint(endpoint, model),
            max_retries=max_retries,
            base_delay=base_delay,
            request_timeout=request_timeout,
        )

    system_text, user_text = _build_delimited_prompt(texts, target_lang)
    raw = call(system_text, user_text)
    try:
        return _parse_delimited_output(raw, expected_len=len(texts))
    except Exception:
        if not strict_json_fallback:
            raise
        print(f"[fallback] gemini batch size={len(texts)} -> indexed-json retry", file=sys.stderr)
        system_text, user_text = _build_indexed_json_prompt(texts, target_lang)
        raw = call(system_text, user_text)
        parsed = _parse_indexed_json_text(raw, expected_len=len(texts))
        if len(parsed) != len(texts):
            raise RuntimeError(f"AI output length mismatch: expected {len(texts)}, got {len(parsed)}")
        return [parsed[i].strip() for i in range(len(texts))]


def translate_lines_native(
    lines: List[str],
    api_key: str,
    provider: str = "deepl",
    endpoint: str = "https://api-free.deepl.com/v2/translate",
    target_lang: str = "ZH",
    model: str = OPENAI_DEFAULT_MODEL,
    bilingual: bool = False,
    every: int = 10,
    chunk: int = DEEPL_DEFAULT_CHUNK_SIZE,
    concurrency: int = 1,
    max_chars: int = 0,
    max_paragraphs: int = 0,
    rps: float = 0,
    max_retries: int = DEEPL_DEFAULT_MAX_RETRIES,
    progress_callback: Callable[[int, int], None] | None = None,
    partial_callback: Callable[[int, int, List[str]], None] | None = None,
    stop_check: Callable[[], bool] | None = None,
    batch_error_callback: Callable[[int, int, str], None] | None = None,
    log_progress: bool = True,
    debug_progress: bool = False,
    fallback_mode: str = "immediate",
    request_timeout: float = 90.0,
    slow_split_threshold: float = 0.0,
    repair_concurrency: int = 1,
    no_thinking: bool = True,
    openai_reasoning_effort: str = "low",
    deepl_formality: str = "",
    outcome_callback: Callable[[dict], None] | None = None,
) -> List[str]:
    provider_name = (provider or "deepl").strip().lower()
    if provider_name not in {"deepl", "openai", "deepseek", "gemini", "google-web", "argos"}:
        raise ValueError(f"UNSUPPORTED_PROVIDER: Unsupported provider: {provider_name}")
    target_code = str(target_lang or "ZH").strip().upper()
    if target_code not in SUPPORTED_TARGET_CODES:
        raise ValueError(
            f"UNSUPPORTED_TARGET_LANGUAGE: unsupported target language '{target_code}'; "
            f"allowed={sorted(SUPPORTED_TARGET_CODES)}"
        )
    if provider_name == "deepl" and target_code in YUE_TARGET_CODES:
        raise ValueError(
            f"UNSUPPORTED_TARGET_LANGUAGE: provider=deepl does not support target={target_code}; "
            "use an AI provider"
        )
    if provider_name == "argos":
        _resolve_argos_target_lang(target_code)
    target_lang = target_code

    effective_rps = rps
    if provider_name == "google-web":
        # Match the 1.4.2 speed profile while keeping one cue per batch so
        # partial VTT updates remain independent and observable.
        concurrency = max(1, min(int(concurrency or GOOGLE_WEB_DEFAULT_CONCURRENCY), GOOGLE_WEB_DEFAULT_CONCURRENCY))
        chunk = 1
        max_paragraphs = 1
        requested_or_default_rps = max(0.0, float(rps or GOOGLE_WEB_DEFAULT_RPS))
        effective_rps = (
            max(0.1, min(requested_or_default_rps, GOOGLE_WEB_MAX_RPS))
            if GOOGLE_WEB_MAX_RPS > 0
            else requested_or_default_rps
        )
        max_retries = min(GOOGLE_WEB_MAX_RETRIES, max(0, int(max_retries or 0)))
        print(
            f"[google-web] effective settings: concurrency={concurrency} "
            f"rps={effective_rps:g} max_paragraphs=1 retries={max_retries}",
            flush=True,
        )
    elif provider_name == "argos":
        # CTranslate2 already parallelizes within one model. Running several
        # Python threads against the same model usually increases memory and
        # contention without improving subtitle latency.
        concurrency = ARGOS_DEFAULT_CONCURRENCY
        max_retries = ARGOS_DEFAULT_MAX_RETRIES
        effective_rps = 0.0
        print(
            f"[argos] effective settings: source={ARGOS_SOURCE_CODE} "
            f"concurrency={concurrency} max_paragraphs={max_paragraphs} retries={max_retries}",
            flush=True,
        )

    translatable_idx = timed_text_line_indices(lines)
    line_parts = {i: split_voice_tag(lines[i]) for i in translatable_idx}
    source_texts = {i: line_parts[i][1] for i in translatable_idx}
    total = len(translatable_idx)
    if total == 0:
        raise ValueError("EMPTY_TRANSLATABLE_VTT: VTT 中没有可翻译文本")
    out_lines = list(lines)
    failed_items: list[dict] = []
    provider_results = 0
    target_results = 0
    unchanged_results = 0
    cue_index_by_line: dict[int, int] = {}
    cue_index = 0
    for line_index, line in enumerate(lines):
        if is_timecode(line):
            cue_index += 1
        if line_index in source_texts:
            cue_index_by_line[line_index] = cue_index
    batches = build_text_batches(
        lines,
        translatable_idx,
        chunk_size=max(1, chunk),
        max_chars=max(0, max_chars),
        max_paragraphs=max(0, max_paragraphs),
        text_for_len=source_texts,
    )
    workers = max(1, min(int(concurrency or 1), len(batches) or 1))
    fallback_mode = (fallback_mode or "immediate").strip().lower()
    if fallback_mode not in FALLBACK_MODES:
        raise ValueError(
            f"INVALID_REQUEST: unsupported fallback_mode '{fallback_mode}'; "
            f"allowed={sorted(FALLBACK_MODES)}"
        )
    if repair_concurrency < 1:
        repair_concurrency = 1
    fastpath_only_main = fallback_mode == "deferred-fastpath"
    def dbg(msg: str):
        if not debug_progress:
            return
        print(f"[debug] {msg}", flush=True)

    def translate_batch_with_provider(batch_texts: list[str]) -> list[str]:
        if provider_name == "deepl":
            return deepl_translate_batch(
                batch_texts,
                endpoint=endpoint,
                api_key=api_key,
                target_lang=target_lang,
                max_retries=max_retries,
                request_timeout=request_timeout,
                formality=deepl_formality or None,
            )
        if provider_name == "openai":
            return openai_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=not fastpath_only_main,
                request_timeout=request_timeout,
                openai_reasoning_effort=openai_reasoning_effort,
            )
        if provider_name == "deepseek":
            return deepseek_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=not fastpath_only_main,
                request_timeout=request_timeout,
                no_thinking=no_thinking,
            )
        if provider_name == "google-web":
            return google_web_translate_batch(
                batch_texts,
                target_lang=target_lang,
                max_retries=max_retries,
                request_timeout=request_timeout,
                rps=effective_rps,
            )
        if provider_name == "argos":
            return argos_translate_batch(batch_texts, target_lang=target_lang)
        return gemini_translate_batch(
            batch_texts,
            api_key=api_key,
            target_lang=target_lang,
            model=model,
            endpoint=endpoint,
            max_retries=max_retries,
            strict_json_fallback=not fastpath_only_main,
            request_timeout=request_timeout,
        )

    def translate_batch_with_provider_strict(batch_texts: list[str]) -> list[str]:
        if provider_name == "deepl":
            return deepl_translate_batch(
                batch_texts,
                endpoint=endpoint,
                api_key=api_key,
                target_lang=target_lang,
                max_retries=max_retries,
                formality=deepl_formality or None,
            )
        if provider_name == "openai":
            return openai_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=True,
                request_timeout=request_timeout,
                openai_reasoning_effort=openai_reasoning_effort,
            )
        if provider_name == "deepseek":
            return deepseek_translate_batch(
                batch_texts,
                api_key=api_key,
                target_lang=target_lang,
                model=model,
                endpoint=normalize_openai_compatible_endpoint(endpoint, provider_name),
                max_retries=max_retries,
                strict_json_fallback=True,
                request_timeout=request_timeout,
                no_thinking=no_thinking,
            )
        if provider_name == "google-web":
            return google_web_translate_batch(
                batch_texts,
                target_lang=target_lang,
                max_retries=max_retries,
                request_timeout=request_timeout,
                rps=effective_rps,
            )
        if provider_name == "argos":
            return argos_translate_batch(batch_texts, target_lang=target_lang)
        return gemini_translate_batch(
            batch_texts,
            api_key=api_key,
            target_lang=target_lang,
            model=model,
            endpoint=endpoint,
            max_retries=max_retries,
            strict_json_fallback=True,
            request_timeout=request_timeout,
        )

    def translate_batch_recursive(
        batch_texts: list[str],
        item_offset: int = 0,
        failed_positions: list[int] | None = None,
    ) -> tuple[list[str], bool, str | None]:
        failed_positions = failed_positions if failed_positions is not None else []
        try:
            t0 = time.perf_counter()
            translated = translate_batch_with_provider(batch_texts)
            translated = _validate_provider_batch_output(translated, len(batch_texts))
            elapsed = time.perf_counter() - t0
            if (
                provider_name in SPLIT_FALLBACK_PROVIDERS
                and slow_split_threshold > 0
                and len(batch_texts) > 1
                and elapsed > slow_split_threshold
            ):
                raise RuntimeError(
                    f"slow batch {elapsed:.3f}s>{slow_split_threshold:.3f}s, split retry"
                )
            return translated, False, None
        except Exception as e:
            # For AI providers, split-fallback improves strict-mode completion rate.
            can_split_fallback = provider_name in SPLIT_FALLBACK_PROVIDERS
            if can_split_fallback and len(batch_texts) > 1:
                mid = len(batch_texts) // 2
                left, left_failed, left_err = translate_batch_recursive(batch_texts[:mid], item_offset, failed_positions)
                right, right_failed, right_err = translate_batch_recursive(batch_texts[mid:], item_offset + mid, failed_positions)
                combined_err = "; ".join(err for err in [left_err, right_err] if err)
                if left and right and len(left) + len(right) == len(batch_texts):
                    recovered_with_fallback = left_failed or right_failed
                    return left + right, recovered_with_fallback, combined_err
            if can_split_fallback and len(batch_texts) == 1:
                # Keep progress by isolating hard failures to a single line.
                failed_positions.append(item_offset)
                return [batch_texts[0]], True, str(e)
            raise

    def translate_batch(
        bstart: int, bend: int, batch_ids: list[int]
    ) -> tuple[int, int, list[int], list[str], bool, str | None, bool, list[int]]:
        batch_texts = [source_texts[i] for i in batch_ids]
        t0 = time.perf_counter()
        dbg(f"batch start {bstart+1}-{bend} size={len(batch_ids)}")
        if fallback_mode in {"deferred", "deferred-fastpath"}:
            try:
                translated = translate_batch_with_provider(batch_texts)
                translated = _validate_provider_batch_output(translated, len(batch_texts))
                dbg(
                    f"batch done {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s fallback=False"
                )
                return bstart, bend, batch_ids, translated, False, None, False, []
            except Exception as e:
                dbg(
                    f"batch defer {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s err={str(e)[:120]}"
                )
                return bstart, bend, batch_ids, batch_texts, False, str(e), True, []
        try:
            fallback_positions: list[int] = []
            translated, had_fallback, warn_text = translate_batch_recursive(batch_texts, 0, fallback_positions)
            dbg(
                f"batch done {bstart+1}-{bend} size={len(batch_ids)} "
                f"elapsed={time.perf_counter()-t0:.3f}s fallback={had_fallback}"
            )
            return bstart, bend, batch_ids, translated, had_fallback, warn_text, False, fallback_positions
        except Exception as e:
            dbg(
                f"batch fail {bstart+1}-{bend} size={len(batch_ids)} "
                f"elapsed={time.perf_counter()-t0:.3f}s err={str(e)[:120]}"
            )
            return bstart, bend, batch_ids, batch_texts, True, str(e), False, list(range(len(batch_ids)))

    def apply_batch_result(
        bstart: int,
        bend: int,
        batch_ids: list[int],
        translated: list[str],
        had_fallback: bool,
        error_text: str | None,
        deferred_only: bool,
        fallback_positions: list[int] | None = None,
    ) -> int:
        nonlocal provider_results, target_results, unchanged_results
        if deferred_only:
            return len(batch_ids)
        translated = _validate_provider_batch_output(translated, len(batch_ids))
        raw_fallback_positions = list(fallback_positions or [])
        if any(
            not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(batch_ids)
            for index in raw_fallback_positions
        ):
            raise ValueError(
                f"INCONSISTENT_TRANSLATION_RESULT: fallback item index is outside batch {bstart + 1}-{bend}"
            )
        failed_indexes = set(raw_fallback_positions)
        staged_failures: list[tuple[int, str]] = []
        if had_fallback and failed_indexes:
            safe_error = _safe_error_text(error_text or "unknown error")
            print(f"WARNING: {provider_name} batch failed ({bstart+1}-{bend}): {safe_error}", file=sys.stderr)
            if batch_error_callback:
                batch_error_callback(bstart + 1, bend, safe_error)

        for idx_in_batch in failed_indexes:
            staged_failures.append((idx_in_batch, _safe_error_text(error_text or "provider failed; original text kept")))

        target_requires_cjk = str(target_lang or "ZH").strip().upper() in CJK_TARGET_CODES
        staged_lines: list[tuple[int, str]] = []
        staged_provider_results = 0
        staged_target_results = 0
        staged_unchanged_results = 0
        for idx_in_batch, line_idx in enumerate(batch_ids):
            translated_text = translated[idx_in_batch].strip()
            if not translated_text:
                empty_message = f"INVALID_PROVIDER_OUTPUT: empty item at line {line_idx + 1}"
                if idx_in_batch not in failed_indexes:
                    failed_indexes.add(idx_in_batch)
                    staged_failures.append((idx_in_batch, empty_message))
                staged_lines.append((line_idx, lines[line_idx]))
                continue
            if idx_in_batch not in failed_indexes and target_requires_cjk and not re.search(
                r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", translated_text
            ):
                target_message = "NO_TARGET_TRANSLATION: Provider returned a non-empty result without recognizable target-language text"
                failed_indexes.add(idx_in_batch)
                if translated_text.strip().casefold() == str(source_texts[line_idx]).strip().casefold():
                    staged_unchanged_results += 1
                staged_failures.append((idx_in_batch, target_message))
            prefix, _body, suffix = line_parts[line_idx]
            if idx_in_batch in failed_indexes:
                # A failed item must remain exactly the source cue text. In
                # bilingual mode, adding the original again would look like a
                # successful duplicate translation in the rendered VTT.
                staged_lines.append((line_idx, lines[line_idx]))
                continue
            if bilingual:
                staged_lines.append((line_idx, lines[line_idx] + "\n" + f"{prefix}{translated_text}{suffix}"))
            else:
                if prefix or suffix:
                    staged_lines.append((line_idx, f"{prefix}{translated_text}{suffix}"))
                else:
                    staged_lines.append((line_idx, translated_text))
            staged_provider_results += 1
            if re.search(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", translated_text):
                staged_target_results += 1
            if translated_text.strip().casefold() == str(source_texts[line_idx]).strip().casefold():
                staged_unchanged_results += 1

        # Commit only after all outputs have been classified. A malformed
        # item must not leave earlier translated lines or counters behind an
        # error path.
        for line_idx, value in staged_lines:
            out_lines[line_idx] = value
        seen_failures: set[int] = set()
        for idx_in_batch, failure_message in staged_failures:
            if idx_in_batch in seen_failures:
                continue
            seen_failures.add(idx_in_batch)
            failure_code = _error_code_from_text(failure_message)
            status_match = re.search(r"\bHTTP[_\s]+(\d{3})\b", str(failure_message or ""), re.IGNORECASE)
            failure_status = int(status_match.group(1)) if status_match else (
                int(failure_code[-3:]) if re.fullmatch(r"HTTP_\d{3}", failure_code) else None
            )
            item = {
                "batch": bstart + 1,
                "line": batch_ids[idx_in_batch] + 1,
                "cue": cue_index_by_line.get(batch_ids[idx_in_batch]),
                "code": failure_code,
                "message": _safe_error_text(failure_message),
            }
            if failure_status is not None and 100 <= failure_status <= 599:
                item["status"] = failure_status
            failed_items.append(item)
        provider_results += staged_provider_results
        target_results += staged_target_results
        unchanged_results += staged_unchanged_results

        return len(batch_ids)

    completed = 0
    deferred_failures: list[tuple[int, int, list[int], str]] = []

    def report_progress() -> None:
        # The local-backend path needs the actual partially translated VTT,
        # not only a numeric counter.  Keep the callback best-effort so a
        # progress-file problem never aborts an otherwise healthy translation.
        if partial_callback:
            try:
                partial_callback(completed, total, list(out_lines))
            except Exception as exc:
                print(f"WARNING: partial progress callback failed: {str(exc)[:160]}", file=sys.stderr)
        if progress_callback:
            progress_callback(completed, total)

    if workers == 1:
        for bstart, bend, batch_ids in batches:
            if stop_check and not stop_check():
                break

            result = translate_batch(bstart, bend, batch_ids)
            _bstart, _bend, _batch_ids, _translated, _had_fallback, _err_text, _deferred, _fallback_positions = result
            if _deferred:
                deferred_failures.append((_bstart, _bend, _batch_ids, _err_text or "unknown error"))
            else:
                completed += apply_batch_result(
                    _bstart, _bend, _batch_ids, _translated, _had_fallback, _err_text,
                    _deferred, _fallback_positions,
                )

            report_progress()
            if log_progress and ((completed == total) or (completed % every == 0) or (bstart == 0)):
                print(f"[{completed}/{total}] Translating...", flush=True)

        if fallback_mode == "immediate":
            if outcome_callback:
                outcome_callback({
                    "total": total,
                    "processed": completed,
                    "translated": max(0, provider_results),
                    "failed": len(failed_items),
                    "failed_items": failed_items[:50],
                    "failed_batches": len({item.get("batch") for item in failed_items if item.get("batch") is not None}),
                    "failure_codes": _failure_codes(failed_items),
                    "failureCodes": _failure_codes(failed_items),
                    "provider_results": provider_results,
                    "target_results": target_results,
                    "unchanged_results": unchanged_results,
                })
            return out_lines

    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_batch = {}
            next_submit_at = time.perf_counter()
            submit_interval = (1.0 / rps) if rps and rps > 0 else 0.0
            for bstart, bend, batch_ids in batches:
                if stop_check and not stop_check():
                    break
                if submit_interval > 0:
                    sleep_for = next_submit_at - time.perf_counter()
                    if sleep_for > 0:
                        time.sleep(sleep_for)
                    next_submit_at = max(next_submit_at + submit_interval, time.perf_counter())
                future = executor.submit(translate_batch, bstart, bend, batch_ids)
                future_to_batch[future] = (bstart, bend)

            for future in concurrent.futures.as_completed(future_to_batch):
                if stop_check and not stop_check():
                    break
                result = future.result()
                _bstart, _bend, _batch_ids, _translated, _had_fallback, _err_text, _deferred, _fallback_positions = result
                if _deferred:
                    deferred_failures.append((_bstart, _bend, _batch_ids, _err_text or "unknown error"))
                else:
                    completed += apply_batch_result(
                        _bstart, _bend, _batch_ids, _translated, _had_fallback, _err_text,
                        _deferred, _fallback_positions,
                    )

                report_progress()
                if log_progress and ((completed == total) or (completed % every == 0) or completed <= chunk):
                    print(f"[{completed}/{total}] Translating...", flush=True)

    if fallback_mode == "deferred" and deferred_failures:
        print(
            f"[repair] deferred fallback phase: {len(deferred_failures)} failed batch(es), "
            f"concurrency={repair_concurrency}",
            flush=True,
        )
        def run_deferred_repair(item: tuple[int, int, list[int], str]) -> tuple[int, int, list[int], list[str], bool, str | None, list[int]]:
            bstart, bend, batch_ids, err_text = item
            dbg(f"repair start {bstart+1}-{bend} size={len(batch_ids)}")
            batch_texts = [source_texts[i] for i in batch_ids]
            fallback_positions: list[int] = []
            try:
                translated, had_fallback, warn_text = translate_batch_recursive(batch_texts, 0, fallback_positions)
                dbg(f"repair done {bstart+1}-{bend} size={len(batch_ids)}")
                return bstart, bend, batch_ids, translated, had_fallback, (warn_text or err_text), fallback_positions
            except Exception as repair_err:
                safe_error = _safe_error_text(f"{err_text}; {repair_err}")
                dbg(f"repair fail {bstart+1}-{bend} size={len(batch_ids)} err={safe_error[:120]}")
                return (
                    bstart,
                    bend,
                    batch_ids,
                    batch_texts,
                    True,
                    safe_error,
                    list(range(len(batch_ids))),
                )

        with concurrent.futures.ThreadPoolExecutor(max_workers=repair_concurrency) as repair_executor:
            repair_futures = [repair_executor.submit(run_deferred_repair, item) for item in deferred_failures]
            for future in concurrent.futures.as_completed(repair_futures):
                bstart, bend, batch_ids, translated, had_fallback, err_text, fallback_positions = future.result()
                completed += apply_batch_result(
                    bstart,
                    bend,
                    batch_ids,
                    translated,
                    had_fallback,
                    err_text,
                    False,
                    fallback_positions,
                )
                report_progress()
                if log_progress:
                    print(f"[{completed}/{total}] Translating...", flush=True)

    if fallback_mode == "deferred-fastpath" and deferred_failures:
        print(
            f"[repair] deferred-fastpath phase: {len(deferred_failures)} failed batch(es), "
            f"concurrency={repair_concurrency}",
            flush=True,
        )
        def run_fastpath_repair(item: tuple[int, int, list[int], str]) -> tuple[int, int, list[int], list[str], bool, str, list[int]]:
            bstart, bend, batch_ids, err_text = item
            dbg(f"repair start {bstart+1}-{bend} size={len(batch_ids)}")
            batch_texts = [source_texts[i] for i in batch_ids]
            t0 = time.perf_counter()
            try:
                translated = _validate_provider_batch_output(
                    translate_batch_with_provider_strict(batch_texts),
                    len(batch_texts),
                )
                dbg(
                    f"repair done {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s strict_json=True"
                )
                # A successful strict repair is not a failure and must not
                # trigger a false warning/cache bypass.
                return bstart, bend, batch_ids, translated, False, err_text, []
            except Exception as repair_err:
                dbg(
                    f"repair fail {bstart+1}-{bend} size={len(batch_ids)} "
                    f"elapsed={time.perf_counter()-t0:.3f}s err={str(repair_err)[:120]}"
                )
                return (
                    bstart,
                    bend,
                    batch_ids,
                    [source_texts[i] for i in batch_ids],
                    True,
                    str(repair_err),
                    list(range(len(batch_ids))),
                )

        with concurrent.futures.ThreadPoolExecutor(max_workers=repair_concurrency) as repair_executor:
            repair_futures = [repair_executor.submit(run_fastpath_repair, item) for item in deferred_failures]
            for future in concurrent.futures.as_completed(repair_futures):
                bstart, bend, batch_ids, translated, had_fallback, err_text, fallback_positions = future.result()
                completed += apply_batch_result(
                    bstart,
                    bend,
                    batch_ids,
                    translated,
                    had_fallback,
                    err_text,
                    False,
                    fallback_positions,
                )
                report_progress()
                if log_progress:
                    print(f"[{completed}/{total}] Translating...", flush=True)

    if outcome_callback:
        outcome_callback({
            "total": total,
            "processed": completed,
            "translated": max(0, provider_results),
            "failed": len(failed_items),
            "failed_items": failed_items[:50],
            "failed_batches": len({item.get("batch") for item in failed_items if item.get("batch") is not None}),
            "failure_codes": _failure_codes(failed_items),
            "failureCodes": _failure_codes(failed_items),
            "provider_results": provider_results,
            "target_results": target_results,
            "unchanged_results": unchanged_results,
        })
    return out_lines


class CliArgumentParser(argparse.ArgumentParser):
    """Emit the same machine-readable error marker as runtime failures."""

    def error(self, message):
        _emit_cli_error("INVALID_REQUEST", message, phase="config")
        raise SystemExit(2)


def main():
    ap = CliArgumentParser(description="Translate VTT using cloud APIs, Google Web, or local Argos models.")
    ap.add_argument("input", help="Path to input .vtt")
    ap.add_argument("--out", required=True, help="Path to output .vtt")
    ap.add_argument(
        "--key",
        default=os.getenv("TRANSLATOR_API_KEY", ""),
        help="API key for selected provider; optional for Google Web and Argos",
    )
    ap.add_argument(
        "--provider",
        default="deepl",
        choices=["deepl", "openai", "deepseek", "gemini", "google-web", "argos"],
        help="Translation provider",
    )
    ap.add_argument(
        "--endpoint",
        default="https://api-free.deepl.com/v2/translate",
        help="Provider endpoint (DeepL Free/Pro, OpenAI Responses, or Chat Completions endpoint)",
    )
    ap.add_argument("--model", default="", help="Model name for openai/deepseek/gemini")
    ap.add_argument("--target", default="ZH", help="Target language code (e.g. ZH / ZH-HK / YUE / EN / JA)")
    ap.add_argument("--bilingual", action="store_true", help="Keep original + translated line")
    ap.add_argument("--every", type=int, default=10, help="Print progress every N lines")
    ap.add_argument("--chunk", type=int, default=None, help="Number of lines per API request")
    ap.add_argument("--concurrency", type=int, default=None, help="Concurrent batches for AI/API providers")
    ap.add_argument("--max-chars", type=int, default=None, help="Max characters per AI request; 0 disables char batching")
    ap.add_argument("--max-paragraphs", type=int, default=None, help="Max text lines per AI request; 0 disables paragraph batching")
    ap.add_argument("--rps", type=float, default=0, help="Max request submissions per second; 0 disables rate limiting")
    ap.add_argument("--max-retries", type=int, default=None, help="Max retries per request")
    ap.add_argument(
        "--progress-file",
        default="",
        help="Optional path for atomically written partial VTT snapshots",
    )
    ap.add_argument("--debug-progress", action="store_true", help="Print per-batch debug timing")
    ap.add_argument("--request-timeout", type=float, default=10.0, help="Per-request timeout in seconds")
    ap.add_argument(
        "--openai-reasoning-effort",
        default="low",
        choices=sorted(OPENAI_REASONING_EFFORT_CHOICES),
        help="OpenAI reasoning effort (default: low)",
    )
    ap.add_argument("--no-thinking", action="store_true", help="DeepSeek only: disable thinking mode")
    ap.add_argument("--with-thinking", action="store_true", help="DeepSeek only: enable thinking mode")
    ap.add_argument(
        "--deepl-formality",
        default="",
        choices=["", "more", "less", "prefer_more", "prefer_less"],
        help="DeepL only: formality preference",
    )
    ap.add_argument(
        "--slow-split-threshold",
        type=float,
        default=0.0,
        help="If a batch takes longer than this threshold (seconds), split and retry for AI providers; 0 disables",
    )
    ap.add_argument(
        "--fallback-mode",
        default="immediate",
        choices=["immediate", "deferred", "deferred-fastpath"],
        help="Mismatch fallback strategy: immediate retry or deferred repair after main pass",
    )
    ap.add_argument(
        "--repair-concurrency",
        type=int,
        default=1,
        help="Concurrency for deferred repair phase; 1 means serial repair",
    )
    args = ap.parse_args()

    in_path = Path(args.input).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    if not in_path.exists():
        _emit_cli_error("TRANSLATOR_INPUT_MISSING", f"Input not found: {in_path}", phase="source")
        return 1

    print(f"Reading: {in_path}")
    try:
        lines = read_text(in_path)
    except (OSError, UnicodeError) as exc:
        _emit_cli_error("TRANSLATOR_INPUT_READ_FAILED", f"Unable to read input VTT: {exc}", phase="source")
        return 1
    normalized_target = args.target.strip().upper()
    if normalized_target not in SUPPORTED_TARGET_CODES:
        _emit_cli_error(
            "UNSUPPORTED_TARGET_LANGUAGE",
            f"Unsupported target language '{normalized_target or '(empty)'}'; allowed={sorted(SUPPORTED_TARGET_CODES)}",
            phase="config",
        )
        return 1
    if args.provider == "deepl" and normalized_target in YUE_TARGET_CODES:
        _emit_cli_error(
            "UNSUPPORTED_TARGET_LANGUAGE",
            "DeepL does not support Traditional Cantonese (YUE/CANTONESE); use an AI provider",
            phase="config",
        )
        return 1
    if args.provider == "argos":
        try:
            _resolve_argos_target_lang(normalized_target)
        except ValueError as exc:
            _emit_cli_error("UNSUPPORTED_TARGET_LANGUAGE", str(exc), phase="config")
            return 1
    if args.provider not in KEYLESS_PROVIDERS and not (args.key or "").strip():
        _emit_cli_error("PROVIDER_API_KEY_MISSING", f"--key is required for provider={args.provider}", phase="config")
        return 1
    if args.provider == "google-web":
        print(
            f"WARNING: provider={args.provider} uses an unofficial web endpoint for local stability testing only.",
            file=sys.stderr,
        )

    defaults = provider_defaults(args.provider)
    resolved_endpoint = args.endpoint
    if args.provider in KEYLESS_PROVIDERS:
        resolved_endpoint = ""
    if args.provider in {"openai", "deepseek", "gemini"} and resolved_endpoint in {
        "https://api-free.deepl.com/v2/translate",
        "https://api.deepl.com/v2/translate",
    }:
        resolved_endpoint = str(defaults["endpoint"])
    if args.provider in {"openai", "deepseek"}:
        resolved_endpoint = normalize_openai_compatible_endpoint(resolved_endpoint, args.provider)

    resolved_model = args.model or str(defaults["model"])
    if args.provider == "gemini":
        resolved_endpoint = normalize_gemini_endpoint(resolved_endpoint, resolved_model)
    resolved_chunk = max(1, int(args.chunk if args.chunk is not None else defaults["chunk"]))
    resolved_concurrency = max(1, int(args.concurrency if args.concurrency is not None else defaults["concurrency"]))
    resolved_max_chars = max(0, int(args.max_chars if args.max_chars is not None else defaults.get("max_chars", 0)))
    resolved_max_paragraphs = max(0, int(args.max_paragraphs if args.max_paragraphs is not None else defaults.get("max_paragraphs", 0)))
    resolved_max_retries = max(0, int(args.max_retries if args.max_retries is not None else defaults["max_retries"]))
    resolved_rps = max(0.0, float(args.rps))
    if args.provider == "google-web":
        resolved_concurrency = min(resolved_concurrency, GOOGLE_WEB_DEFAULT_CONCURRENCY)
        resolved_max_paragraphs = 1
        resolved_rps = (
            max(0.1, min(resolved_rps or GOOGLE_WEB_DEFAULT_RPS, GOOGLE_WEB_MAX_RPS))
            if GOOGLE_WEB_MAX_RPS > 0
            else max(0.0, resolved_rps)
        )
        resolved_max_retries = min(resolved_max_retries, GOOGLE_WEB_MAX_RETRIES)
    elif args.provider == "argos":
        resolved_concurrency = ARGOS_DEFAULT_CONCURRENCY
        resolved_rps = 0.0
        resolved_max_retries = ARGOS_DEFAULT_MAX_RETRIES

    print(
        f"Translating via provider={args.provider} endpoint={resolved_endpoint} "
        f"target={args.target} chunk={resolved_chunk} concurrency={resolved_concurrency} "
        f"max_chars={resolved_max_chars} max_paragraphs={resolved_max_paragraphs} "
        f"rps={resolved_rps:g} max_retries={resolved_max_retries} ..."
    )
    failed_batches = 0
    outcome: dict = {}
    progress_path = Path(args.progress_file).expanduser().resolve() if args.progress_file else None
    progress_write_warnings: list[str] = []

    def write_partial_vtt(_completed: int, _total: int, partial_lines: List[str]) -> None:
        if not progress_path:
            return
        try:
            progress_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path = progress_path.with_name(
                f".{progress_path.name}.{os.getpid()}.tmp"
            )
            temporary_path.write_text("\n".join(partial_lines), encoding="utf-8")
            os.replace(temporary_path, progress_path)
        except OSError as exc:
            warning = _safe_error_text(
                f"TRANSLATOR_PROGRESS_WRITE_FAILED: unable to write progress snapshot: {exc}",
                320,
            )
            if warning not in progress_write_warnings:
                progress_write_warnings.append(warning)
            # A progress snapshot is observability, not the translation result
            # itself. Keep the provider work alive, but carry this warning into
            # RESULT_SUMMARY so the backend/UI can report it explicitly instead
            # of silently losing the only partial-progress surface.
            print(f"WARNING: {warning}", file=sys.stderr, flush=True)

    def on_batch_error(_start: int, _end: int, _err: str):
        nonlocal failed_batches
        failed_batches += 1

    def on_outcome(summary: dict):
        outcome.clear()
        outcome.update(summary)

    try:
        out_lines = translate_lines_native(
            lines,
            api_key=args.key,
            provider=args.provider,
            endpoint=resolved_endpoint,
            target_lang=args.target,
            model=resolved_model,
            bilingual=args.bilingual,
            every=max(1, args.every),
            chunk=resolved_chunk,
            concurrency=resolved_concurrency,
            max_chars=resolved_max_chars,
            max_paragraphs=resolved_max_paragraphs,
            rps=resolved_rps,
            max_retries=resolved_max_retries,
            partial_callback=write_partial_vtt if progress_path else None,
            batch_error_callback=on_batch_error,
            debug_progress=args.debug_progress,
            fallback_mode=args.fallback_mode,
            request_timeout=max(1.0, float(args.request_timeout)),
            slow_split_threshold=max(0.0, float(args.slow_split_threshold)),
            repair_concurrency=max(1, int(args.repair_concurrency)),
            no_thinking=(False if args.with_thinking else True),
            openai_reasoning_effort=args.openai_reasoning_effort,
            deepl_formality=args.deepl_formality,
            outcome_callback=on_outcome,
        )
    except KeyboardInterrupt:
        _emit_cli_error("TRANSLATION_CANCELLED", "翻译被用户取消；结果没有被当作完整成功", phase="translation")
        return 130
    except Exception as exc:
        _emit_cli_error(_cli_error_code(exc), exc, phase="translation")
        return 1

    print(f"Writing: {out_path}")
    try:
        out_path.write_text("\n".join(out_lines), encoding="utf-8")
    except OSError as exc:
        _emit_cli_error("TRANSLATOR_OUTPUT_WRITE_FAILED", f"Unable to write output VTT: {exc}", phase="translation")
        return 1
    if failed_batches > 0:
        print(
            f"Done with warnings: {failed_batches} batch(es) failed and kept original text.",
            file=sys.stderr,
        )
    if progress_write_warnings:
        outcome["warnings"] = progress_write_warnings[:30]
    outcome.setdefault("failed_batches", failed_batches)
    print(f"RESULT_SUMMARY: {json.dumps(outcome, ensure_ascii=False, sort_keys=True)}", flush=True)
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
