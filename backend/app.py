from __future__ import annotations

from functools import lru_cache
import os
import sys
import subprocess
import tempfile
import hashlib
import json
import logging
import threading
import time
import uuid
import re
import unicodedata
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi import Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


CACHE_DIR = Path(os.getenv("ECHO360_CACHE_DIR", str(Path(__file__).resolve().parent / ".cache")))
CACHE_SCHEMA_VERSION = 2
DEFAULT_TRANSLATOR_SCRIPT = Path(__file__).resolve().parent.parent / "translator" / "translate_vtt_zh_deepl_native.py"
TRANSLATOR_SCRIPT = Path(os.getenv("TRANSLATOR_SCRIPT", str(DEFAULT_TRANSLATOR_SCRIPT)))
JOB_TTL_SECONDS = 60 * 60
JOB_MAX_COUNT = 100
KEYLESS_PROVIDERS = {"google-web", "argos"}
CJK_TARGET_CODES = {"ZH", "ZH-HK", "YUE", "CANTONESE"}
SUPPORTED_TARGET_CODES = {
    "ZH", "ZH-HK", "YUE", "CANTONESE", "EN", "JA", "KO", "FR", "DE",
    "ES", "IT", "PT", "RU", "AR", "HI",
}
FALLBACK_MODES = {"immediate", "deferred", "deferred-fastpath"}
DEEPL_UNSUPPORTED_TARGET_CODES = {"YUE", "CANTONESE"}
ARGOS_UNSUPPORTED_TARGET_CODES = {"YUE", "CANTONESE", "EN"}
CORS_ORIGIN_PATTERN = (
    r"^(?:"
    r"(?:chrome-extension|moz-extension|safari-web-extension)://[A-Za-z0-9._-]+|"
    r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?|"
    r"https?://canvas\.sydney\.edu\.au(?::\d+)?|"
    r"https?://(?:[A-Za-z0-9-]+\.)*instructuremedia\.com(?::\d+)?|"
    r"https?://(?:[A-Za-z0-9-]+\.)*echo360\.(?:org|com|net|net\.au)(?::\d+)?"
    r")$"
)
WEB_PROVIDER_LIMITS = {
    # Cap Google Web at half of the former 96-worker profile. rps=0 means no
    # default pacing; max_paragraphs=1 remains an incremental-display choice.
    "google-web": {"concurrency": 48, "rps": 0.0, "max_chars": 1200, "max_paragraphs": 1, "timeout": 15.0},
    # Argos runs in the translator subprocess and uses English as the source.
    # A single worker avoids loading/contending on the same CTranslate2 model
    # from multiple Python threads.
    "argos": {"concurrency": 1, "rps": 0.0, "max_chars": 1200, "max_paragraphs": 6, "timeout": 120.0},
}


class TranslateRequest(BaseModel):
    vtt_text: str = Field(..., min_length=1)
    api_key: str = ""
    # Keep the backend's omitted-field behavior aligned with the extension's
    # first-install configuration.  The browser normally sends this field,
    # but direct/API callers and older clients may omit it.
    provider: str = "google-web"
    model: str = ""
    endpoint: str = ""
    target: str = "ZH"
    max_paragraphs: int = Field(6, ge=0)
    max_chars: int = Field(1200, ge=0)
    concurrency: int = Field(96, ge=1)
    rps: float = Field(0.0, ge=0)
    retries: int = Field(1, ge=0)
    bilingual: bool = False
    # Pydantic evaluates model-field annotations at class creation time.
    # Optional keeps this entrypoint importable on macOS's Python 3.9; the
    # newer ``T | None`` spelling is safe for ordinary deferred annotations
    # below, but Pydantic cannot backport it without an extra dependency.
    timeout: Optional[int] = Field(None, ge=1)
    reasoning_effort: Optional[str] = None
    deepseek_thinking_mode: str = "disabled"
    deepl_formality: str = ""
    fallback_mode: str = "immediate"
    repair_concurrency: int = Field(1, ge=1)
    slow_split_threshold: float = Field(0.0, ge=0)


class TranslateAsyncRequest(TranslateRequest):
    force_refresh: bool = False


app = FastAPI(title="Echo360 Online Subtitle Translator", version="0.1.0")
logger = logging.getLogger("echo360-translator")
PROGRESS_RE = re.compile(r"\[(\d+)/(\d+)\]\s+Translating")
_jobs_lock = threading.Lock()
_jobs: dict[str, dict] = {}

ERROR_TITLES = {
    "INVALID_REQUEST": "翻译请求参数无效",
    "INVALID_SOURCE_VTT": "原始字幕格式无效",
    "SOURCE_ALREADY_TRANSLATED": "检测到译文被当作原文",
    "EMPTY_TRANSLATABLE_VTT": "字幕中没有可翻译文本",
    "UNSUPPORTED_PROVIDER": "翻译服务不受支持",
    "UNSUPPORTED_TARGET_LANGUAGE": "目标语言不受支持",
    "PROVIDER_API_KEY_MISSING": "缺少翻译服务 API Key",
    "ARGOS_DEPENDENCY_MISSING": "缺少 Argos Translate 运行依赖",
    "ARGOS_MODEL_MISSING": "缺少 Argos 翻译模型",
    "INVALID_REASONING_EFFORT": "Reasoning Effort 配置无效",
    "JOB_NOT_FOUND": "后台翻译任务不存在",
    "TRANSLATOR_PROCESS_FAILED": "本地翻译进程失败",
    "TRANSLATOR_INPUT_WRITE_FAILED": "翻译输入文件写入失败",
    "TRANSLATOR_INPUT_MISSING": "翻译输入文件不存在",
    "TRANSLATOR_INPUT_READ_FAILED": "翻译输入文件读取失败",
    "TRANSLATOR_OUTPUT_WRITE_FAILED": "翻译结果文件写入失败",
    "TRANSLATOR_PROGRESS_WRITE_FAILED": "翻译进度文件写入失败",
    "TRANSLATOR_OUTPUT_READ_FAILED": "翻译结果文件读取失败",
    "TRANSLATOR_SUMMARY_MISSING": "翻译进程没有提供结果摘要",
    "TRANSLATOR_SUMMARY_INVALID": "翻译进程结果摘要损坏",
    "INCONSISTENT_TRANSLATION_RESULT": "翻译结果与统计不一致",
    "TRANSLATOR_SCRIPT_MISSING": "本地翻译脚本缺失",
    "TRANSLATOR_OUTPUT_MISSING": "翻译结果文件缺失",
    "INVALID_TRANSLATED_VTT": "翻译结果不是有效 WebVTT",
    "INCOMPLETE_TRANSLATED_VTT": "翻译结果字幕条目不完整",
    "TRANSLATION_TIMELINE_MISMATCH": "翻译结果时间轴与原始字幕不一致",
    "TRANSLATION_FAILURE_DETAILS_MISSING": "翻译失败但缺少失败明细",
    "PROVIDER_REQUEST_FAILED": "翻译服务请求失败",
    "NETWORK_ERROR": "无法连接翻译服务",
    "REQUEST_TIMEOUT": "翻译请求超时",
    "TRANSLATION_TIMEOUT": "翻译请求超时",
    "INVALID_PROVIDER_RESPONSE": "翻译服务返回格式无效",
    "INVALID_PROVIDER_OUTPUT": "翻译服务返回内容无效",
    "TRANSLATION_CANCELLED": "翻译已取消",
    "GOOGLE_WEB_ALL_REQUESTS_FAILED": "Google 网页翻译全部请求失败",
    "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN": "Google 网页翻译限流熔断",
    "GOOGLE_WEB_INVALID_RESPONSES": "Google 网页翻译返回格式无效",
    "GOOGLE_WEB_NO_TARGET_TRANSLATIONS": "Google 网页翻译没有返回目标语言",
    "INVALID_BACKEND_RESPONSE": "本地后端返回格式无效",
    "JOB_FAILED_UNCLASSIFIED": "后台任务失败但没有错误详情",
    "CACHE_INVALID_IGNORED": "无效翻译缓存已忽略",
    "CACHE_READ_FAILED": "翻译缓存读取失败",
    "CACHE_WRITE_FAILED": "翻译完成，但缓存保存失败",
    "NO_TRANSLATIONS": "翻译服务没有返回可用译文",
    "FAILURE_DETAIL_MISSING": "翻译失败条目缺少错误详情",
    "INTERNAL_ERROR": "本地后端内部错误",
}

GENERIC_ERROR_CODES = {
    "",
    "ERROR",
    "UNKNOWN",
    "UNKNOWN_ERROR",
    "TRANSLATION_ERROR",
    # This is an internal derived-map sentinel, not an acceptable provider
    # diagnosis at an API boundary.
    "FAILURE_DETAIL_MISSING",
}

# These values describe a transport/process boundary. If a nested diagnostic
# contains a concrete provider or HTTP code, the concrete code is the one the
# client should display; the boundary code remains available as context.
BOUNDARY_WRAPPER_CODES = {
    "BACKEND_REQUEST_ERROR",
    "BACKEND_NETWORK_ERROR",
    "RUNTIME_MESSAGE_ERROR",
    "DIRECT_JOB_CREATE_FAILED",
    "DIRECT_JOB_READ_FAILED",
    "JOB_FAILED_UNCLASSIFIED",
    "TRANSLATOR_PROCESS_FAILED",
    "INTERNAL_ERROR",
    "PROVIDER_REQUEST_FAILED",
    "INVALID_BACKEND_RESPONSE",
}


def problem_payload(
    status: int,
    code: str,
    detail: str,
    *,
    title: str | None = None,
    phase: str = "backend",
    instance: str = "",
    **extensions,
) -> dict:
    normalized_code = canonical_error_code(code, status, detail)
    payload = {
        "type": f"urn:echo360:translator:error:{normalized_code.lower()}",
        "title": ERROR_TITLES.get(normalized_code) or title or "翻译请求失败",
        "status": int(status),
        # Error details cross the local-backend boundary and are displayed or
        # copied by the extension. Redact here as the last safety boundary so
        # a provider response or a future exception cannot echo credentials.
        "detail": redact_sensitive_detail(detail or "请求失败", 2000),
        # `code` is a compatibility alias used by older extension builds;
        # `error_code` remains the canonical application extension member.
        "code": normalized_code,
        "error_code": normalized_code,
        "phase": str(phase or "backend"),
    }
    if instance:
        payload["instance"] = instance
    # RFC 9457's core members are authoritative. Do not let an untrusted
    # provider response or a future caller accidentally overwrite `type`,
    # `title`, `status`, `detail`, `instance`, `error_code`, or `phase` via
    # extensions. Such overwrites create contradictory problem documents and
    # make the same failure render differently in different clients.
    reserved = {"type", "title", "status", "detail", "instance", "code", "error_code", "phase"}
    for key, value in extensions.items():
        if key not in reserved and value is not None:
            payload[key] = sanitize_problem_value(value)
    return payload


def raise_problem(status: int, code: str, detail: str, **kwargs):
    raise HTTPException(status_code=status, detail=problem_payload(status, code, detail, **kwargs))


def redact_sensitive_detail(value: object, limit: int = 1200) -> str:
    """Keep diagnostics useful without echoing credentials or huge provider bodies."""
    text = str(value or "").replace("\x00", "")
    text = re.sub(
        r"(?i)(\b(?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|password|secret|key)\b\s*[\"']?\s*[:=]\s*[\"']?)(?:(?:Bearer|Basic|DeepL-Auth-Key)\s+)?(?:\"[^\"]*\"|'[^']*'|[^\s,;&}\]\"']+)",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)\b(?:Bearer|Basic|DeepL-Auth-Key)\s+[^\s,;&}\]\"']+", "Bearer [REDACTED]", text)
    text = re.sub(
        r"(?i)([?&](?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|password|secret|key|signature|sig|x-amz-signature|expires|x-amz-expires)=)[^&#\s]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"(?i)(sk-[A-Za-z0-9_-]{8,})", "[REDACTED_KEY]", text)
    return text[:limit]


def canonical_error_code(value: object, status: int | None = None, detail: object = "") -> str:
    """Return a stable, non-generic machine-readable error code."""
    code = re.sub(r"[^A-Z0-9_]", "_", str(value or "").strip().upper())
    code = re.sub(r"^HTTP_(\d{3})$", r"HTTP_\1", code)
    if re.fullmatch(r"HTTP_\d{3}", code):
        status_code = int(code[-3:])
        if 100 <= status_code <= 599:
            # Preserve a typed upstream status even when the local adapter
            # itself returns a different outer status (for example a provider
            # HTTP_429 wrapped by a local process failure). Replacing it with
            # HTTP_500 destroys the actionable rate-limit diagnosis.
            return code
    if code in GENERIC_ERROR_CODES:
        if isinstance(status, int) and 400 <= status <= 599:
            return f"HTTP_{status}" if status < 500 else "INTERNAL_ERROR"
        text = str(detail or "").upper()
        if any(marker in text for marker in ("NETWORK", "CONNECTION", "FAILED TO FETCH", "LOAD FAILED")):
            return "NETWORK_ERROR"
        return "INTERNAL_ERROR"
    return code


def sanitize_problem_value(value: object, depth: int = 0, seen: set[int] | None = None):
    """Recursively sanitize RFC-problem extensions before returning JSON."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_sensitive_detail(value, 800)
    if depth >= 4:
        return "[详情已截断]"
    if seen is None:
        seen = set()
    identity = id(value)
    if identity in seen:
        return "[Circular]"
    seen.add(identity)
    if isinstance(value, list):
        result = [sanitize_problem_value(item, depth + 1, seen) for item in value[:50]]
        seen.remove(identity)
        return result
    if isinstance(value, dict):
        result = {}
        for key, item in list(value.items())[:50]:
            key_text = str(key)
            if re.match(r"(?i)^(?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|secret|key|signature|sig|x-amz-signature|expires|x-amz-expires)$", key_text):
                result[key_text] = "[REDACTED]"
            else:
                result[key_text] = sanitize_problem_value(item, depth + 1, seen)
        seen.remove(identity)
        return result
    return redact_sensitive_detail(value, 800)


def _problem_code_values(value: object, depth: int = 0) -> list[object]:
    """Collect explicit/nested problem codes without treating arbitrary text as a code."""
    if not isinstance(value, dict) or depth > 4:
        return []
    values: list[object] = []
    for key in (
        "causeCode", "cause_code", "rootCode", "root_code",
        "underlyingCode", "underlying_code", "upstreamCode", "upstream_code",
    ):
        if value.get(key) is not None:
            values.append(value.get(key))
    for key in ("error_code", "errorCode", "code"):
        if value.get(key) is not None:
            values.append(value.get(key))
    for key in ("details", "cause", "causeError", "cause_error", "upstream", "problem", "error_detail", "errorDetail", "data"):
        values.extend(_problem_code_values(value.get(key), depth + 1))
    return values


def _problem_diagnostic_statuses(value: object, depth: int = 0) -> list[int]:
    if not isinstance(value, dict) or depth > 4:
        return []
    statuses: list[int] = []
    for key in (
        "upstream_status", "upstreamStatus", "causeStatus", "cause_status",
        "causeUpstreamStatus", "cause_upstream_status", "upstream_status_code",
        "upstreamStatusCode", "cause_status_code", "status", "status_code", "statusCode",
    ):
        candidate = value.get(key)
        try:
            number = int(candidate)
        except (TypeError, ValueError):
            continue
        if 100 <= number <= 599:
            statuses.append(number)
    for key in ("details", "cause", "causeError", "cause_error", "upstream", "problem", "error_detail", "errorDetail", "data"):
        statuses.extend(_problem_diagnostic_statuses(value.get(key), depth + 1))
    return statuses


def _normalize_explicit_problem_code(value: object) -> str:
    code = re.sub(r"[^A-Z0-9_]", "_", str(value or "").strip().upper())
    return code if code and code not in GENERIC_ERROR_CODES else ""


def exception_problem(exc: Exception, *, phase: str = "backend", instance: str = "") -> dict:
    try:
        status = int(getattr(exc, "status_code", 500) or 500)
    except (TypeError, ValueError):
        status = 500
    if status < 100 or status > 599:
        status = 500
    raw_detail = getattr(exc, "detail", None)
    if isinstance(raw_detail, dict):
        normalized_candidates = [
            _normalize_explicit_problem_code(candidate)
            for candidate in _problem_code_values(raw_detail)
        ]
        normalized_candidates = [candidate for candidate in normalized_candidates if candidate]
        specific_code = next(
            (candidate for candidate in normalized_candidates if candidate not in BOUNDARY_WRAPPER_CODES),
            "",
        )
        code = specific_code or (normalized_candidates[0] if normalized_candidates else "")
        nested_detail = raw_detail.get("error_detail") if isinstance(raw_detail.get("error_detail"), dict) else {}
        detail_value = (
            raw_detail.get("detail") or raw_detail.get("message") or
            nested_detail.get("detail") or nested_detail.get("message") or "请求失败"
        )
        if isinstance(detail_value, dict):
            detail_value = detail_value.get("detail") or detail_value.get("message") or detail_value.get("error") or "请求失败"
        detail = str(detail_value)
        if not code:
            code = canonical_error_code("", status, detail)
        upstream_statuses = _problem_diagnostic_statuses(raw_detail)
        if re.fullmatch(r"HTTP_\d{3}", code):
            code_status = int(code[-3:])
            if code_status != status:
                upstream_statuses.insert(0, code_status)
        raw_status = raw_detail.get("status")
        try:
            raw_status_int = int(raw_status)
        except (TypeError, ValueError):
            raw_status_int = None
        if raw_status_int and raw_status_int != status:
            upstream_statuses.insert(0, raw_status_int)
        extensions = {
            key: raw_detail.get(key)
            for key in (
                "metrics", "failure_codes", "failed_items", "warnings", "retryable",
                "details", "provider", "target", "sourceMeta", "sourceDiagnostics",
                "boundary_code",
            )
        }
        if upstream_statuses:
            extensions["upstream_status"] = upstream_statuses[0]
        return problem_payload(
            status,
            code,
            detail,
            title=raw_detail.get("title"),
            phase=raw_detail.get("phase") or phase,
            instance=raw_detail.get("instance") or instance,
            **extensions,
        )
    if raw_detail:
        detail = str(raw_detail)
    elif status >= 500:
        detail = "后端处理请求时发生内部错误"
    else:
        detail = str(exc) or "请求失败"
    code = canonical_error_code(f"HTTP_{status}" if status < 500 else "INTERNAL_ERROR", status, detail)
    return problem_payload(status, code, detail, phase=phase, instance=instance)


@app.exception_handler(HTTPException)
async def http_problem_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content=exception_problem(exc, instance=request.url.path),
        media_type="application/problem+json",
    )


@app.exception_handler(RequestValidationError)
async def validation_problem_handler(request: Request, exc: RequestValidationError):
    fields = []
    for item in exc.errors():
        location = ".".join(str(part) for part in item.get("loc", []) if part != "body") or "request"
        fields.append(f"{location}: {item.get('msg', '值无效')}")
    return JSONResponse(
        status_code=422,
        content=problem_payload(422, "INVALID_REQUEST", "; ".join(fields)[:2000], phase="backend", instance=request.url.path),
        media_type="application/problem+json",
    )


@app.exception_handler(Exception)
async def unhandled_problem_handler(request: Request, exc: Exception):
    logger.exception("unhandled backend error path=%s", request.url.path)
    return JSONResponse(
        status_code=500,
        content=problem_payload(500, "INTERNAL_ERROR", "后端处理请求时发生内部错误", phase="backend", instance=request.url.path),
        media_type="application/problem+json",
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=CORS_ORIGIN_PATTERN,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def is_allowed_browser_origin(origin: object) -> bool:
    """Allow only extension, supported-player, and local development origins."""
    return bool(re.fullmatch(CORS_ORIGIN_PATTERN, str(origin or "").strip(), re.IGNORECASE))


@app.middleware("http")
async def private_network_access_middleware(request, call_next):
    if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network") == "true":
        origin = request.headers.get("origin", "")
        if not is_allowed_browser_origin(origin):
            return JSONResponse(
                status_code=403,
                content=problem_payload(
                    403,
                    "HTTP_403",
                    "该网页来源无权访问本地翻译后端",
                    phase="backend",
                    instance=request.url.path,
                ),
                media_type="application/problem+json",
            )
        resp = Response(status_code=204)
        req_headers = request.headers.get("access-control-request-headers", "*")
        req_method = request.headers.get("access-control-request-method", "POST")
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = req_method
        resp.headers["Access-Control-Allow-Headers"] = req_headers
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp

    response = await call_next(request)
    if is_allowed_browser_origin(request.headers.get("origin")):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def allowed_reasoning_for_model(model: str) -> set[str]:
    m = (model or "").lower()
    if m.startswith("gpt-5.4"):
        return {"none", "low", "medium", "high", "xhigh"}
    if m.startswith("gpt-5"):
        return {"minimal", "low", "medium", "high"}
    if m.startswith("gpt-4.1") or m.startswith("gpt-4o-mini"):
        return {"low"}
    return {"low"}


@lru_cache(maxsize=1)
def get_supported_args() -> set[str]:
    if not translator_runtime_available():
        return set()
    try:
        proc = subprocess.run(
            [*get_translator_command(), "--help"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return set()
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    supported = set()
    for flag in (
        "--request-timeout",
        "--openai-reasoning-effort",
        "--no-thinking",
        "--with-thinking",
        "--deepl-formality",
        "--fallback-mode",
        "--repair-concurrency",
        "--slow-split-threshold",
        "--progress-file",
    ):
        if flag in text:
            supported.add(flag)
    return supported


def get_translator_python() -> str:
    configured = os.getenv("TRANSLATOR_PYTHON_BIN", "").strip()
    if configured:
        return configured
    return sys.executable or "python3"


def get_translator_command() -> list[str]:
    """Return the source or frozen command used for the translator subprocess."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--translator"]
    return [get_translator_python(), str(TRANSLATOR_SCRIPT)]


def translator_runtime_available() -> bool:
    return bool(getattr(sys, "frozen", False)) or TRANSLATOR_SCRIPT.exists()


def redact_args(args: list[str]) -> list[str]:
    redacted = []
    hide_next = False
    for arg in args:
        if hide_next:
            redacted.append("***")
            hide_next = False
            continue
        redacted.append(redact_sensitive_detail(arg, 500))
        if arg == "--key":
            hide_next = True
    return redacted


def web_provider_limit_key(provider_name: str) -> str | None:
    if provider_name in WEB_PROVIDER_LIMITS:
        return provider_name
    return None


def build_translator_args(
    input_path: Path,
    out_vtt: Path,
    req: TranslateRequest,
    supported_args: set[str],
    warnings: list[str],
    progress_file: Path | None = None,
) -> list[str]:
    provider_name = (req.provider or "").strip().lower()
    concurrency = int(req.concurrency)
    max_chars = int(req.max_chars)
    max_paragraphs = int(req.max_paragraphs)
    rps = max(0.0, float(req.rps))
    retries = max(0, int(req.retries))
    limit_key = web_provider_limit_key(provider_name)
    if limit_key:
        limits = WEB_PROVIDER_LIMITS[limit_key]
        concurrency = max(1, min(concurrency, int(limits["concurrency"])))
        max_chars = max(100, min(max_chars, int(limits["max_chars"])))
        max_paragraphs = int(limits["max_paragraphs"])
        limit_rps = float(limits["rps"])
        rps = (
            max(0.1, min(rps or limit_rps, limit_rps))
            if limit_rps > 0
            else max(0.0, rps)
        )
        retries = min(2, retries)
        logger.info(
            f"{limit_key} effective settings: concurrency={concurrency}, rps={rps:g}, "
            f"max_paragraphs={max_paragraphs}, retries={retries}"
        )

    args = [
        *get_translator_command(),
        str(input_path),
        "--out",
        str(out_vtt),
        "--provider",
        provider_name,
        "--model",
        req.model,
        "--target",
        req.target,
        "--max-paragraphs",
        str(max_paragraphs),
        "--max-chars",
        str(max_chars),
        "--concurrency",
        str(concurrency),
        "--rps",
        str(rps),
        "--max-retries",
        str(retries),
    ]
    if "--request-timeout" in supported_args:
        timeout = float(req.timeout) if req.timeout is not None else 10.0
        if limit_key:
            timeout = min(timeout, float(WEB_PROVIDER_LIMITS[limit_key]["timeout"]))
        args.extend(["--request-timeout", str(timeout)])
    elif req.timeout is not None:
        warnings.append("translator script does not support --request-timeout, skipped")
    if req.bilingual:
        args.append("--bilingual")
    if req.endpoint:
        args.extend(["--endpoint", req.endpoint])
    if req.reasoning_effort and provider_name == "openai":
        if "--openai-reasoning-effort" in supported_args:
            args.extend(["--openai-reasoning-effort", req.reasoning_effort])
        else:
            warnings.append("translator script does not support --openai-reasoning-effort yet, skipped")
    if provider_name == "deepseek":
        thinking_mode = (req.deepseek_thinking_mode or "disabled").strip().lower()
        if thinking_mode == "disabled" and "--no-thinking" in supported_args:
            args.append("--no-thinking")
        elif thinking_mode in {"enabled", "with-thinking"} and "--with-thinking" in supported_args:
            args.append("--with-thinking")
    if provider_name == "deepl" and req.deepl_formality:
        if "--deepl-formality" in supported_args:
            args.extend(["--deepl-formality", req.deepl_formality])
        else:
            warnings.append("translator script does not support --deepl-formality yet, skipped")
    if req.fallback_mode and "--fallback-mode" in supported_args:
        args.extend(["--fallback-mode", req.fallback_mode])
    if "--repair-concurrency" in supported_args:
        args.extend(["--repair-concurrency", str(max(1, int(req.repair_concurrency)))])
    if "--slow-split-threshold" in supported_args:
        args.extend(["--slow-split-threshold", str(max(0.0, float(req.slow_split_threshold)))])
    if progress_file and "--progress-file" in supported_args:
        # Emit one progress snapshot per completed batch so the content
        # script can refresh already-translated cues while the job is running.
        args.extend(["--progress-file", str(progress_file), "--every", "1"])
    return args


def build_cache_key(vtt_text: str, req: TranslateRequest) -> str:
    provider = str(req.provider or "").strip().lower()
    target = str(req.target or "ZH").strip().upper()
    model = str(req.model or "").strip()
    endpoint = str(req.endpoint or "").strip()
    reasoning_effort = str(req.reasoning_effort or "").strip().lower() or None
    thinking_mode = str(req.deepseek_thinking_mode or "disabled").strip().lower()
    deepl_formality = str(req.deepl_formality or "").strip().lower()
    fallback_mode = str(req.fallback_mode or "immediate").strip().lower()
    digest_input = {
        "cache_schema": CACHE_SCHEMA_VERSION,
        "vtt_text": vtt_text,
        "provider": provider,
        "model": model,
        "endpoint": endpoint,
        "target": target,
        "max_paragraphs": req.max_paragraphs,
        "max_chars": req.max_chars,
        "bilingual": req.bilingual,
        "reasoning_effort": reasoning_effort,
        "deepseek_thinking_mode": thinking_mode,
        "deepl_formality": deepl_formality,
        "fallback_mode": fallback_mode,
        "repair_concurrency": max(1, int(req.repair_concurrency)),
        "slow_split_threshold": max(0.0, float(req.slow_split_threshold)),
    }
    raw = json.dumps(digest_input, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


TIMING_LINE_RE = re.compile(
    r"^\s*((?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3})\s*-->\s*"
    r"((?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$"
)


def parse_vtt_timestamp(value: str) -> int | None:
    parts = str(value or "").split(":")
    if len(parts) not in {2, 3}:
        return None
    try:
        seconds = float(parts[-1])
        minutes = int(parts[-2])
        hours = int(parts[0]) if len(parts) == 3 else 0
    except (TypeError, ValueError):
        return None
    if hours < 0 or minutes < 0 or minutes >= 60 or seconds < 0 or seconds >= 60:
        return None
    return round((hours * 3600 + minutes * 60 + seconds) * 1000)


def parse_vtt_timing_line(line: str) -> tuple[int, int] | None:
    match = TIMING_LINE_RE.match(str(line or ""))
    if not match:
        return None
    start = parse_vtt_timestamp(match.group(1))
    end = parse_vtt_timestamp(match.group(2))
    if start is None or end is None or end < start:
        return None
    return start, end


def timed_cue_count(text: str) -> int:
    return sum(
        1
        for line in str(text or "").replace("\r", "").split("\n")
        if parse_vtt_timing_line(line) is not None
    )


def timed_cue_ranges(text: str) -> list[tuple[int, int]]:
    return [
        timing
        for line in str(text or "").replace("\r", "").split("\n")
        for timing in [parse_vtt_timing_line(line)]
        if timing is not None
    ]


def is_valid_timed_vtt(text: str) -> bool:
    value = str(text or "").strip()
    return bool(
        re.search(r"^WEBVTT(?:\s|$)", value, re.IGNORECASE) and
        any(parse_vtt_timing_line(line) for line in value.replace("\r", "").split("\n"))
    )


def translatable_line_count(text: str) -> int:
    # Only text inside a timed cue is translatable. Counting every non-empty
    # line would include cue identifiers and header metadata, which makes the
    # subprocess, backend and extension disagree about `total` and can create
    # a false INCOMPLETE_TRANSLATED_VTT error.
    return len(timed_cue_text_entries(text))


def is_translatable_vtt_line(raw_line: str) -> bool:
    line = str(raw_line or "").strip()
    if not line or re.match(r"^WEBVTT\b", line, re.IGNORECASE):
        return False
    if parse_vtt_timing_line(line) is not None:
        return False
    if re.match(r"^(NOTE|STYLE|REGION)\b", line, re.IGNORECASE):
        return False
    return True


def timed_cue_text_entries(text: str) -> list[dict]:
    """Return each caption text line with its 1-based cue and VTT line.

    Translation counters are line-based. Keeping the physical line mapping
    here lets result validation prove which line failed instead of excluding
    an entire multi-line cue and accidentally accepting an untranslated
    sibling line.
    """
    lines = str(text or "").replace("\r", "").split("\n")
    entries: list[dict] = []
    cue = 0
    for index, raw_line in enumerate(lines):
        if parse_vtt_timing_line(raw_line) is None:
            continue
        cue += 1
        for next_index in range(index + 1, len(lines)):
            cue_line = lines[next_index]
            if not cue_line.strip() or parse_vtt_timing_line(cue_line) is not None:
                break
            if is_translatable_vtt_line(cue_line):
                entries.append({"cue": cue, "line": next_index + 1, "text": cue_line})
    return entries


def inspect_probable_bilingual_source(text: str, minimum_cues: int = 3, minimum_ratio: float = 0.6) -> dict:
    """Detect a rendered bilingual track accidentally fed back as the source.

    This is a defensive source-boundary check, not a language detector. It only
    fires when most cues contain at least two physical text lines and one line
    contains CJK while another does not—the shape produced by the extension's
    own bilingual renderer. Ordinary single-language cues and isolated
    multilingual phrases remain valid.
    """
    entries = timed_cue_text_entries(text)
    by_cue: dict[int, list[str]] = {}
    for entry in entries:
        by_cue.setdefault(entry["cue"], []).append(str(entry.get("text") or ""))
    mixed_cues = 0
    for lines in by_cue.values():
        non_empty = [line.strip() for line in lines if line.strip()]
        has_cjk_line = any(has_cjk_text(line) for line in non_empty)
        has_non_cjk_line = any(not has_cjk_text(line) for line in non_empty)
        if len(non_empty) >= 2 and has_cjk_line and has_non_cjk_line:
            mixed_cues += 1
    cue_count = timed_cue_count(text)
    multiline_cues = sum(
        1 for lines in by_cue.values()
        if len([line for line in lines if line.strip()]) > 1
    )
    ratio = mixed_cues / cue_count if cue_count else 0.0
    return {
        "probable": cue_count >= minimum_cues and mixed_cues >= minimum_cues and ratio >= minimum_ratio,
        "cueCount": cue_count,
        "mixedCueCount": mixed_cues,
        "multilineCueCount": multiline_cues,
        "textLineCount": len(entries),
        "ratio": ratio,
    }


def has_timed_cue_text(text: str) -> bool:
    """Return whether every timed cue contains actual caption text."""
    lines = str(text or "").replace("\r", "").split("\n")
    cue_count = 0
    cue_with_text = 0
    for index, raw_line in enumerate(lines):
        if not parse_vtt_timing_line(raw_line):
            continue
        cue_count += 1
        has_text = False
        for cue_line in lines[index + 1 :]:
            if not cue_line.strip():
                break
            if parse_vtt_timing_line(cue_line):
                break
            if not re.match(r"^(NOTE|STYLE|REGION)\b", cue_line.strip(), re.IGNORECASE):
                has_text = True
                break
        if has_text:
            cue_with_text += 1
    return cue_count > 0 and cue_with_text == cue_count


def has_cjk_text(text: str) -> bool:
    """Check actual cue text, not only a provider-supplied counter."""
    return bool(re.search(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", str(text or "")))


TARGET_NEUTRAL_CODE_STOPWORDS = {
    "A", "AN", "THE", "AND", "OR", "BUT", "IF", "IS", "ARE", "WAS", "WERE",
    "TO", "OF", "IN", "ON", "FOR", "WITH", "THIS", "THAT", "THESE", "THOSE",
    "I", "IT", "WE", "YOU", "HE", "SHE", "THEY", "YES", "NO", "OK", "OKAY",
}


def _caption_plain_text(value: object) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", str(value or ""))).strip()


def _comparable_caption(value: object) -> str:
    return unicodedata.normalize("NFKC", _caption_plain_text(value)).casefold()


def is_target_neutral_text(source_value: object, translated_value: object, target: str = "ZH") -> bool:
    """Return whether unchanged text is a valid Chinese-target neutral item.

    Target-language coverage must remain strict for ordinary English. The
    exception is limited to content that has no translatable language (for
    example ``2026``), a URL/email, or a clearly code-like/label-like token
    such as ``ITLS6111`` or ``F.``. The source and output must be equivalent;
    this helper never accepts an arbitrary non-Chinese translation.
    """
    target_code = str(target or "ZH").strip().upper()
    if target_code not in CJK_TARGET_CODES:
        return False
    source = _caption_plain_text(source_value)
    translated = _caption_plain_text(translated_value)
    if not source or not translated or _comparable_caption(source) != _comparable_caption(translated):
        return False
    if has_cjk_text(source):
        return True
    # Numbers, punctuation and symbols do not have a linguistic target.
    if not re.search(r"[^\W\d_]", source, re.UNICODE):
        return True
    if (
        re.fullmatch(r"(?:(?:https?|ftp)://|www\.)\S+", source, re.IGNORECASE)
        or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", source)
    ):
        return True
    # Uppercase abbreviations, course codes, file names and software tokens
    # are commonly preserved by subtitle translation. Exclude common English
    # words so an unchanged "NO" or "OK" is not silently accepted.
    if re.fullmatch(r"[A-Z0-9][A-Z0-9._:/+#&()'’\-]*", source):
        upper = source.upper()
        has_digit = bool(re.search(r"\d", source))
        all_upper = source == upper
        code_word = re.sub(r"[.)]+$", "", upper)
        if (has_digit or (all_upper and len(source) <= 32)) and code_word not in TARGET_NEUTRAL_CODE_STOPWORDS:
            return True
    return False


def _target_compatible_text(output_text: object, source_text: object | None, target: str) -> bool:
    return has_cjk_text(output_text) or (
        source_text is not None and is_target_neutral_text(source_text, output_text, target)
    )


def _target_compatible_bilingual_block(output_block: object, source_block: object | None, target: str) -> bool:
    if has_cjk_text(output_block):
        return True
    if source_block is None:
        return False
    source_lines = [line.strip() for line in str(source_block or "").split("\n") if line.strip()]
    output_lines = [line.strip() for line in str(output_block or "").split("\n") if line.strip()]
    return bool(source_lines and output_lines) and all(
        any(is_target_neutral_text(source_line, output_line, target) for source_line in source_lines)
        for output_line in output_lines
    )


def has_cjk_in_every_timed_cue(
    text: str,
    bilingual: bool = False,
    source_text: str | None = None,
    target: str = "ZH",
) -> bool:
    """Require target-language or explicitly neutral text in every cue.

    A whole-document CJK check is insufficient: one translated cue can make
    an otherwise English/original document look successful. Partial results
    are handled separately by the failure counters; this helper is used for
    cache hits and zero-failure results. Non-bilingual output is checked at
    the same text-line granularity as the translator counters; bilingual
    output intentionally contains an English source line beside its CJK
    translation and is therefore checked per cue.
    """
    entries = timed_cue_text_entries(text)
    if not entries:
        return False
    source_entries = timed_cue_text_entries(source_text) if source_text is not None else []
    if not bilingual:
        return all(
            _target_compatible_text(entry["text"], source_entries[index].get("text") if index < len(source_entries) else None, target)
            for index, entry in enumerate(entries)
        )
    cue_blocks: dict[int, list[str]] = {}
    for entry in entries:
        cue_blocks.setdefault(entry["cue"], []).append(entry["text"])
    source_blocks = timed_cue_text_blocks(source_text) if source_text is not None else []
    return bool(cue_blocks) and all(
        _target_compatible_bilingual_block("\n".join(lines), source_blocks[index] if index < len(source_blocks) else None, target)
        for index, lines in enumerate(cue_blocks.values())
    )


def has_cjk_in_successful_timed_cues(
    text: str,
    failed_items: list[dict] | None = None,
    expected_failed_count: int | None = None,
    bilingual: bool = False,
    source_text: str | None = None,
    target: str = "ZH",
) -> bool | None:
    """Check target text on text lines known to have succeeded.

    The translator intentionally caps item-level failure details at 50.  When
    the aggregate failure count is larger than that sample, the server cannot
    prove per-line coverage from the response alone, so it returns ``None``
    instead of falsely claiming either complete coverage or a bad result.
    """
    entries = timed_cue_text_entries(text)
    if not entries:
        return False
    failures = failed_items if isinstance(failed_items, list) else []
    expected = parse_nonnegative_metric(expected_failed_count)
    if expected is not None and expected > len(failures):
        return None
    if not failures:
        return has_cjk_in_every_timed_cue(
            text,
            bilingual=bilingual,
            source_text=source_text,
            target=target,
        )

    if bilingual:
        failed_cues: set[int] = set()
        for item in failures:
            cue = parse_nonnegative_metric(item.get("cue") if isinstance(item, dict) else None)
            if cue is None or cue < 1:
                return None
            failed_cues.add(cue)
        cue_blocks: dict[int, list[str]] = {}
        for entry in entries:
            cue_blocks.setdefault(entry["cue"], []).append(entry["text"])
        source_blocks = timed_cue_text_blocks(source_text) if source_text is not None else []
        return all(
            cue in failed_cues or _target_compatible_bilingual_block(
                "\n".join(lines),
                source_blocks[index] if index < len(source_blocks) else None,
                target,
            )
            for index, (cue, lines) in enumerate(cue_blocks.items())
        )

    entries_by_line = {entry["line"]: entry for entry in entries}
    failed_lines: set[int] = set()
    for item in failures:
        item = item if isinstance(item, dict) else {}
        cue = parse_nonnegative_metric(item.get("cue"))
        line = parse_nonnegative_metric(item.get("line"))
        if line is not None:
            entry = entries_by_line.get(line)
            if entry is None or (cue is not None and (cue < 1 or entry["cue"] != cue)):
                return None
            failed_lines.add(line)
            continue
        if cue is None or cue < 1:
            return None
        cue_entries = [entry for entry in entries if entry["cue"] == cue]
        # A cue-only diagnostic is safe only when that cue has one text line.
        # Excluding a multi-line cue wholesale would make an untranslated
        # sibling line indistinguishable from a failed line.
        if len(cue_entries) != 1:
            return None
        failed_lines.add(cue_entries[0]["line"])
    source_entries = timed_cue_text_entries(source_text) if source_text is not None else []
    return all(
        entry["line"] in failed_lines or _target_compatible_text(
            entry["text"],
            source_entries[index].get("text") if index < len(source_entries) else None,
            target,
        )
        for index, entry in enumerate(entries)
    )


def validate_failure_item_locations(
    text: str,
    failed_items: list[dict],
    bilingual: bool = False,
) -> tuple[bool, dict]:
    """Validate the coordinates used to identify failed caption text.

    ``failed_items`` is consumed by the browser renderer, so a failure is not
    sufficiently described by an error code alone. A cue-only coordinate is
    safe for one-line cues (or explicit bilingual output); for a multi-line
    cue it is ambiguous and must be rejected rather than causing the UI to
    mark the wrong line as translated/failed.
    """
    entries = timed_cue_text_entries(text)
    by_line = {entry["line"]: entry for entry in entries}
    by_cue: dict[int, list[dict]] = {}
    for entry in entries:
        by_cue.setdefault(entry["cue"], []).append(entry)
    if not isinstance(failed_items, list):
        return False, {"reason": "failed_items_not_array", "index": None}

    seen: set[str] = set()
    for index, item in enumerate(failed_items):
        if not isinstance(item, dict):
            return False, {"reason": "failed_item_not_object", "index": index}
        has_cue = "cue" in item and item.get("cue") is not None
        has_line = "line" in item and item.get("line") is not None
        cue = parse_nonnegative_metric(item.get("cue"))
        line = parse_nonnegative_metric(item.get("line"))
        if has_cue and (cue is None or cue < 1):
            return False, {"reason": "invalid_cue", "index": index, "cue": item.get("cue")}
        if has_line and (line is None or line < 1):
            return False, {"reason": "invalid_line", "index": index, "line": item.get("line")}

        if line is not None:
            entry = by_line.get(line)
            if entry is None:
                return False, {"reason": "line_out_of_range", "index": index, "line": line}
            if cue is not None and cue != entry["cue"]:
                return False, {"reason": "cue_line_mismatch", "index": index, "cue": cue, "line": line}
            location = f"line:{line}"
        elif cue is not None:
            cue_entries = by_cue.get(cue, [])
            if not cue_entries:
                return False, {"reason": "cue_out_of_range", "index": index, "cue": cue}
            if not bilingual and len(cue_entries) != 1:
                return False, {"reason": "cue_mapping_ambiguous", "index": index, "cue": cue}
            location = f"cue:{cue}"
        else:
            return False, {"reason": "location_missing", "index": index}
        if location in seen:
            return False, {"reason": "duplicate_location", "index": index, "location": location}
        seen.add(location)
    return True, {"mapped": len(seen), "cueCount": len(by_cue), "textLineCount": len(entries)}


def parse_http_status(value: object) -> int | None:
    """Parse an HTTP status only when it is an integer in the HTTP range."""
    status = parse_nonnegative_metric(value)
    return status if status is not None and 100 <= status <= 599 else None


def validate_failure_item_diagnostics(failed_items: list[dict]) -> tuple[bool, dict]:
    """Reject contradictory item-level HTTP diagnostics.

    A result may legitimately carry an adapter status (for example HTTP 500)
    and an upstream rate-limit code (HTTP_429), but that distinction must be
    explicit in ``upstream_status``. Without it, displaying both values would
    be misleading and could make a retry decision based on the wrong status.
    """
    if not isinstance(failed_items, list):
        return False, {"reason": "failed_items_not_array", "index": None}
    for index, item in enumerate(failed_items):
        if not isinstance(item, dict):
            return False, {"reason": "failed_item_not_object", "index": index}
        raw_code = item.get("code") or item.get("error_code") or item.get("errorCode")
        code = normalize_report_code(raw_code)
        status = parse_http_status(item.get("status") or item.get("status_code") or item.get("http_status"))
        upstream_status = parse_http_status(item.get("upstream_status") or item.get("upstreamStatus"))
        if not code or not re.fullmatch(r"HTTP_\d{3}", code) or status is None:
            continue
        code_status = int(code[-3:])
        comparable_status = upstream_status if upstream_status is not None else status
        if code_status != comparable_status:
            return False, {
                "reason": "code_status_mismatch",
                "index": index,
                "code": code,
                "status": status,
                "upstreamStatus": upstream_status,
            }
    return True, {}


def normalize_report_code(value: object) -> str | None:
    """Normalize a translator failure code without inventing a diagnosis."""
    code = re.sub(r"[^A-Z0-9_]", "_", str(value or "").strip().upper())
    if re.fullmatch(r"HTTP_\d{3}", code):
        status = int(code[-3:])
        return code if 100 <= status <= 599 else None
    if not code or code in GENERIC_ERROR_CODES:
        return None
    return code


def normalize_report_failure_codes(value: object) -> tuple[dict[str, int] | None, list[str]]:
    if not isinstance(value, dict):
        return None, []
    normalized: dict[str, int] = {}
    invalid_codes: list[str] = []
    for raw_code, raw_count in value.items():
        code = normalize_report_code(raw_code)
        if not isinstance(raw_count, int) or isinstance(raw_count, bool) or raw_count < 0:
            return None, []
        if code is None:
            invalid_codes.append(str(raw_code or ""))
            continue
        if raw_count > 0:
            normalized[code] = normalized.get(code, 0) + raw_count
    return normalized, invalid_codes


def failure_code_maps_equal(left: dict[str, int], right: dict[str, int]) -> bool:
    return {str(key): int(value) for key, value in left.items()} == {
        str(key): int(value) for key, value in right.items()
    }


def no_result_failure_code(
    provider: str,
    target: str,
    failure_codes: dict[str, int],
    failed: int,
    provider_results: int,
    target_results: int | None,
) -> str:
    # A Google job may have switched its unresolved cues to Argos after the
    # 429 circuit opened. If that local fallback is the sole remaining cause,
    # expose the actionable Argos diagnosis even though the requested provider
    # recorded in the job remains google-web.
    for code in ("ARGOS_DEPENDENCY_MISSING", "ARGOS_MODEL_MISSING"):
        if failure_codes.get(code, 0) == failed and failed > 0:
            return code
    if provider != "google-web":
        return "NO_TRANSLATIONS"
    invalid_response_count = sum(
        count for code, count in failure_codes.items()
        if code in {"INVALID_PROVIDER_RESPONSE", "INVALID_PROVIDER_OUTPUT"}
    )
    if invalid_response_count > 0 and invalid_response_count == failed:
        return "GOOGLE_WEB_INVALID_RESPONSES"
    no_target_count = failure_codes.get("NO_TARGET_TRANSLATION", 0)
    other_failure_count = sum(
        count for code, count in failure_codes.items()
        if code != "NO_TARGET_TRANSLATION"
    )
    if target in CJK_TARGET_CODES and (
        (target_results == 0 and provider_results > 0) or
        (no_target_count > 0 and other_failure_count == 0)
    ):
        return "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
    return "GOOGLE_WEB_ALL_REQUESTS_FAILED"


def parse_nonnegative_metric(value: object) -> int | None:
    """Parse translator counters strictly; bools/floats are not counters."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str) and re.fullmatch(r"\d+", value.strip()):
        return int(value.strip())
    return None


def parse_result_summary(output_lines: list[str]) -> tuple[dict, str]:
    """Parse the translator's machine-readable summary without conflating states.

    ``missing`` means the process never emitted the marker. ``invalid`` means
    it emitted the marker but the payload was malformed or not an object.
    Those are different integration failures and must not be reported with the
    same user-facing diagnosis.
    """
    for line in reversed(output_lines):
        if not line.startswith("RESULT_SUMMARY:"):
            continue
        try:
            value = json.loads(line.split(":", 1)[1].strip())
            if not isinstance(value, dict):
                logger.warning("translator emitted non-object RESULT_SUMMARY")
                return {}, "invalid"
            return value, "ok"
        except (TypeError, ValueError, json.JSONDecodeError):
            logger.warning("translator emitted malformed RESULT_SUMMARY")
            return {}, "invalid"
    return {}, "missing"


def normalize_translator_process_code(value: object) -> str | None:
    """Normalize a code emitted by the translator CLI error marker."""
    code = re.sub(r"[^A-Z0-9_]+", "_", str(value or "").strip().upper()).strip("_")
    if re.fullmatch(r"HTTP_\d{3}", code):
        status = int(code[-3:])
        return code if 100 <= status <= 599 else None
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,}", code):
        return None
    if code in GENERIC_ERROR_CODES or code == "ERROR_CODE":
        return None
    return code


def extract_translator_error_code(output_lines: list[str]) -> str | None:
    """Read the stable CLI error marker without guessing from arbitrary logs."""
    for line in reversed(output_lines):
        match = re.match(r"^\s*ERROR_CODE:\s*([A-Z][A-Z0-9_]*)\s*$", line or "", re.IGNORECASE)
        if match:
            code = normalize_translator_process_code(match.group(1))
            if code:
                return code
        if str(line or "").startswith("ERROR_SUMMARY:"):
            try:
                summary = json.loads(str(line).split(":", 1)[1].strip())
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(summary, dict):
                code = normalize_translator_process_code(summary.get("code"))
                if code:
                    return code
    return None


def extract_translator_error_detail(output_lines: list[str]) -> str:
    """Prefer the CLI's concise safe message over marker/traceback noise."""
    for line in reversed(output_lines):
        if str(line or "").startswith("ERROR_SUMMARY:"):
            try:
                summary = json.loads(str(line).split(":", 1)[1].strip())
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(summary, dict) and str(summary.get("message") or "").strip():
                return redact_sensitive_detail(summary["message"])
    useful = [
        line for line in output_lines[-30:]
        if not re.match(r"^\s*ERROR_CODE:\s*", line or "", re.IGNORECASE) and
        not str(line or "").startswith("ERROR_SUMMARY:")
    ]
    return redact_sensitive_detail("\n".join(useful).strip() or "translator command failed")


def translator_error_status(code: str | None) -> int:
    """Map a typed subprocess diagnosis to an appropriate API response status."""
    normalized = normalize_translator_process_code(code) or "TRANSLATOR_PROCESS_FAILED"
    if re.fullmatch(r"HTTP_\d{3}", normalized):
        return int(normalized[-3:])
    if normalized in {"INVALID_REQUEST", "INVALID_SOURCE_VTT", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_TARGET_LANGUAGE", "PROVIDER_API_KEY_MISSING", "INVALID_REASONING_EFFORT"}:
        return 400
    if normalized == "SOURCE_ALREADY_TRANSLATED":
        return 422
    if normalized in {"REQUEST_TIMEOUT", "TRANSLATION_TIMEOUT"}:
        return 504
    if normalized in {"NETWORK_ERROR", "PROVIDER_REQUEST_FAILED", "INVALID_PROVIDER_RESPONSE", "INVALID_PROVIDER_OUTPUT"}:
        return 502
    if normalized in {"ARGOS_DEPENDENCY_MISSING", "ARGOS_MODEL_MISSING"}:
        return 503
    return 500


def run_translation(
    vtt_text: str,
    req: TranslateRequest,
    force_refresh: bool = False,
    progress_callback=None,
) -> tuple[str, list[str], bool, dict]:
    warnings: list[str] = []
    provider_name = (req.provider or "").strip().lower()
    if provider_name not in {"deepl", "openai", "deepseek", "gemini", "google-web", "argos"}:
        raise_problem(400, "UNSUPPORTED_PROVIDER", f"不支持的 Provider：{req.provider}", phase="config")
    target_code = str(req.target or "ZH").strip().upper()
    if target_code not in SUPPORTED_TARGET_CODES:
        raise_problem(
            400,
            "UNSUPPORTED_TARGET_LANGUAGE",
            f"不支持的目标语言代码：{req.target!r}；允许值为 {', '.join(sorted(SUPPORTED_TARGET_CODES))}",
            phase="config",
            details={"field": "target", "value": target_code, "allowed": sorted(SUPPORTED_TARGET_CODES)},
        )
    if provider_name == "deepl" and target_code in DEEPL_UNSUPPORTED_TARGET_CODES:
        raise_problem(
            400,
            "UNSUPPORTED_TARGET_LANGUAGE",
            f"DeepL 不支持目标语言 {target_code}；请改用 OpenAI、DeepSeek 或 Gemini",
            phase="config",
            provider=provider_name,
            target=target_code,
            details={"provider": provider_name, "target": target_code},
        )
    if provider_name == "argos" and target_code in ARGOS_UNSUPPORTED_TARGET_CODES:
        reason = "Argos 当前没有粤语模型" if target_code in {"YUE", "CANTONESE"} else "Argos provider 的源语言固定为英语"
        raise_problem(
            400,
            "UNSUPPORTED_TARGET_LANGUAGE",
            f"{reason}，不支持目标语言 {target_code}",
            phase="config",
            provider=provider_name,
            target=target_code,
            details={"provider": provider_name, "target": target_code, "source": "EN"},
        )
    fallback_mode = str(req.fallback_mode or "immediate").strip().lower()
    if fallback_mode not in FALLBACK_MODES:
        raise_problem(
            400,
            "INVALID_REQUEST",
            f"fallback_mode 参数无效：{req.fallback_mode!r}；允许值为 {', '.join(sorted(FALLBACK_MODES))}",
            phase="config",
            details={"field": "fallback_mode", "value": fallback_mode, "allowed": sorted(FALLBACK_MODES)},
        )
    if not is_valid_timed_vtt(vtt_text) or not has_timed_cue_text(vtt_text):
        raise_problem(
            422,
            "INVALID_SOURCE_VTT",
            "原始字幕不是有效的带时间轴 WebVTT，或包含没有文字的时间轴条目；翻译尚未开始",
            phase="source",
        )
    if translatable_line_count(vtt_text) <= 0:
        raise_problem(
            422,
            "EMPTY_TRANSLATABLE_VTT",
            "原始 WebVTT 没有可翻译的字幕文字；翻译尚未开始",
            phase="source",
        )
    source_structure = inspect_probable_bilingual_source(vtt_text)
    if target_code in CJK_TARGET_CODES and source_structure["probable"]:
        raise_problem(
            422,
            "SOURCE_ALREADY_TRANSLATED",
            (
                "检测到原始 VTT 多数 cue 同时包含 CJK 和非 CJK 字幕行；"
                f"这通常表示已生成的双语译文被再次当作原文（{source_structure['mixedCueCount']}/"
                f"{source_structure['cueCount']} 个 cue）。翻译尚未开始"
            ),
            phase="source",
            provider=provider_name,
            target=target_code,
            details={
                "sourceStructure": source_structure,
                "action": "remove-translated-track-and-resolve-original-source",
            },
        )
    limit_key = web_provider_limit_key(provider_name)
    if provider_name not in KEYLESS_PROVIDERS and not (req.api_key or "").strip():
        raise_problem(400, "PROVIDER_API_KEY_MISSING", f"Provider '{req.provider}' 需要 API Key", phase="config")
    if not translator_runtime_available():
        raise_problem(500, "TRANSLATOR_SCRIPT_MISSING", "本地翻译脚本不存在", phase="backend")
    if provider_name == "google-web":
        limits = WEB_PROVIDER_LIMITS[limit_key]
        rps_note = f"rps<={limits['rps']}" if float(limits["rps"]) > 0 else "rps=0 (unlimited default)"
        logger.info(
            f"{limit_key} uses an unofficial web endpoint; stability is not guaranteed; "
            f"speed settings: concurrency<={limits['concurrency']}, "
            f"max_chars<={limits['max_chars']}, max_paragraphs={limits['max_paragraphs']}, {rps_note}"
        )
    elif provider_name == "argos":
        limits = WEB_PROVIDER_LIMITS[provider_name]
        logger.info(
            f"argos runs locally with English source: concurrency<={limits['concurrency']}, "
            f"max_chars<={limits['max_chars']}, max_paragraphs={limits['max_paragraphs']}"
        )
    if req.reasoning_effort and provider_name == "openai":
        allowed = allowed_reasoning_for_model(req.model)
        requested_effort = str(req.reasoning_effort).strip().lower()
        if requested_effort not in allowed:
            raise_problem(
                400,
                "INVALID_REASONING_EFFORT",
                f"reasoning_effort '{req.reasoning_effort}' is not allowed for model '{req.model}'. allowed={sorted(allowed)}",
                phase="config",
                details={"field": "reasoning_effort", "value": requested_effort, "model": req.model, "allowed": sorted(allowed)},
            )
    cache_key = build_cache_key(vtt_text, req)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.exception("could not create translation cache directory=%s", CACHE_DIR)
        raise_problem(500, "CACHE_WRITE_FAILED", "无法创建翻译缓存目录；翻译尚未开始", phase="cache")
    cache_file = CACHE_DIR / f"{cache_key}.vtt"
    if cache_file.exists() and not force_refresh:
        try:
            cached_text = cache_file.read_text(encoding="utf-8")
            source_line_count = translatable_line_count(vtt_text)
            cached_line_count = translatable_line_count(cached_text)
            if (
                is_valid_timed_vtt(cached_text) and
                has_timed_cue_text(cached_text) and
                timed_cue_ranges(cached_text) == timed_cue_ranges(vtt_text) and
                (req.bilingual or cached_line_count == source_line_count) and
                (
                    target_code not in CJK_TARGET_CODES or
                    has_cjk_in_every_timed_cue(
                        cached_text,
                        bilingual=req.bilingual,
                        source_text=vtt_text,
                        target=target_code,
                    )
                )
            ):
                total_lines = source_line_count
                metrics = {
                    "cacheHit": True,
                    "cache_hit": True,
                    "total": total_lines,
                    "processed": total_lines,
                    "translated": total_lines,
                    "failed": 0,
                    "provider_results": total_lines,
                    "providerResults": total_lines,
                    "target_results": total_lines if target_code in CJK_TARGET_CODES else None,
                    "targetResults": total_lines if target_code in CJK_TARGET_CODES else None,
                    "provider": provider_name,
                }
                return cached_text, warnings, True, metrics
            warnings.append("CACHE_INVALID_IGNORED: 本地缓存与当前字幕/目标语言不匹配，或不是有效的带时间轴 WebVTT，已忽略并重新翻译")
            logger.warning("ignoring invalid translation cache file=%s", cache_file)
        except OSError as exc:
            warnings.append("CACHE_READ_FAILED: 无法读取本地缓存，已忽略并重新翻译")
            logger.warning("ignoring unreadable translation cache file=%s: %s", cache_file, exc)

    supported_args = get_supported_args()
    with tempfile.TemporaryDirectory(prefix="echo360-vtt-") as tmpdir:
        tmp = Path(tmpdir)
        input_path = tmp / "input.vtt"
        out_vtt = tmp / "translated.vtt"
        progress_vtt = tmp / "progress.vtt" if progress_callback else None
        try:
            input_path.write_text(vtt_text, encoding="utf-8")
        except OSError as exc:
            logger.exception("could not write translator input file")
            raise_problem(500, "TRANSLATOR_INPUT_WRITE_FAILED", "无法写入翻译输入文件；翻译尚未开始", phase="backend")

        args = build_translator_args(
            input_path,
            out_vtt,
            req,
            supported_args,
            warnings,
            progress_file=progress_vtt,
        )
        logger.info("translator command: %s", " ".join(redact_args(args)))
        try:
            proc_env = {**os.environ, "TRANSLATOR_API_KEY": req.api_key}
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=proc_env,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
            output_lines: list[str] = []
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.rstrip("\n")
                output_lines.append(line)
                logger.info("[translator] %s", redact_sensitive_detail(line, 2000))
                match = PROGRESS_RE.search(line)
                if match and progress_callback:
                    partial_vtt = ""
                    if progress_vtt and progress_vtt.exists():
                        try:
                            partial_vtt = progress_vtt.read_text(encoding="utf-8")
                        except OSError as exc:
                            logger.warning("could not read partial VTT: %s", exc)
                    progress_callback(
                        int(match.group(1)),
                        int(match.group(2)),
                        line,
                        partial_vtt,
                    )
            return_code = proc.wait()
            if return_code != 0:
                logger.error("translator failed, returncode=%s", return_code)
                code = extract_translator_error_code(output_lines) or "TRANSLATOR_PROCESS_FAILED"
                detail = extract_translator_error_detail(output_lines)
                raise_problem(
                    translator_error_status(code),
                    code,
                    detail,
                    phase="translation",
                    details={"returnCode": return_code},
                )
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("translator execution error")
            raise_problem(500, "TRANSLATOR_PROCESS_FAILED", "无法启动或读取本地翻译进程；请查看本地后端日志", phase="translation")

        try:
            output_exists = out_vtt.exists()
        except OSError:
            logger.exception("could not inspect translator output file")
            raise_problem(500, "TRANSLATOR_OUTPUT_READ_FAILED", "无法检查翻译结果文件；请查看本地后端日志", phase="translation")
        if not output_exists:
            raise_problem(500, "TRANSLATOR_OUTPUT_MISSING", "翻译进程结束了，但没有生成 translated VTT 文件", phase="translation")
        try:
            translated_vtt = out_vtt.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            logger.exception("could not read translator output file")
            raise_problem(500, "TRANSLATOR_OUTPUT_READ_FAILED", "无法读取翻译结果文件；请查看本地后端日志", phase="translation")
        source_cues = timed_cue_count(vtt_text)
        translated_cues = timed_cue_count(translated_vtt)
        if not is_valid_timed_vtt(translated_vtt) or not has_timed_cue_text(translated_vtt):
            raise_problem(500, "INVALID_TRANSLATED_VTT", "翻译进程生成的文件没有有效的 WebVTT 头或时间轴", phase="translation")
        if translated_cues != source_cues:
            raise_problem(
                500,
                "INCOMPLETE_TRANSLATED_VTT",
                f"翻译结果包含 {translated_cues} 个 cue，原始字幕包含 {source_cues} 个 cue；结果没有写入缓存",
                phase="translation",
                details={"sourceCues": source_cues, "translatedCues": translated_cues},
            )
        source_line_count = translatable_line_count(vtt_text)
        translated_line_count = translatable_line_count(translated_vtt)
        if (
            (not req.bilingual and translated_line_count != source_line_count) or
            (req.bilingual and translated_line_count < source_line_count)
        ):
            raise_problem(
                500,
                "INCOMPLETE_TRANSLATED_VTT",
                f"翻译结果包含 {translated_line_count} 行字幕文字，原始字幕包含 {source_line_count} 行；结果没有写入缓存",
                phase="translation",
                details={
                    "sourceTextLines": source_line_count,
                    "translatedTextLines": translated_line_count,
                    "bilingual": bool(req.bilingual),
                },
            )
        source_ranges = timed_cue_ranges(vtt_text)
        translated_ranges = timed_cue_ranges(translated_vtt)
        if translated_ranges != source_ranges:
            raise_problem(
                500,
                "TRANSLATION_TIMELINE_MISMATCH",
                "翻译结果的 cue 时间轴与原始字幕不一致；结果没有写入缓存",
                phase="translation",
                details={
                    "sourceCues": source_cues,
                    "translatedCues": translated_cues,
                    "firstMismatch": next(
                        (
                            {"index": index + 1, "source": source_ranges[index], "translated": translated_ranges[index]}
                            for index in range(min(len(source_ranges), len(translated_ranges)))
                            if source_ranges[index] != translated_ranges[index]
                        ),
                        {"index": min(len(source_ranges), len(translated_ranges)) + 1},
                    ),
                },
            )
        metrics, summary_state = parse_result_summary(output_lines)
        if summary_state == "missing":
            raise_problem(
                500,
                "TRANSLATOR_SUMMARY_MISSING",
                "翻译进程生成了 VTT，但没有输出可验证的 RESULT_SUMMARY；结果没有写入缓存",
                phase="translation",
            )
        if summary_state == "invalid":
            raise_problem(
                500,
                "TRANSLATOR_SUMMARY_INVALID",
                "翻译进程输出了 RESULT_SUMMARY，但内容不是可解析的 JSON 对象；结果没有写入缓存",
                phase="translation",
                details={"summaryState": summary_state},
            )
        summary_warnings = metrics.get("warnings")
        if isinstance(summary_warnings, list):
            for warning in summary_warnings[:30]:
                text = redact_sensitive_detail(warning, 500)
                if text and text not in warnings:
                    warnings.append(text)
        target_requires_cjk = target_code in CJK_TARGET_CODES
        provider_metric_key = "provider_results" if metrics.get("provider_results") is not None else "providerResults"
        target_metric_key = "target_results" if metrics.get("target_results") is not None else "targetResults"
        required_metric_keys = ["total", "processed", "translated", "failed", provider_metric_key]
        if target_requires_cjk:
            required_metric_keys.append(target_metric_key)
        missing_metrics = [key for key in required_metric_keys if metrics.get(key) is None]
        if missing_metrics:
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                f"翻译进程缺少可验证的结果统计：{', '.join(missing_metrics)}；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
                details={"missingMetrics": missing_metrics},
            )
        total = parse_nonnegative_metric(metrics.get("total"))
        processed = parse_nonnegative_metric(metrics.get("processed"))
        failed = parse_nonnegative_metric(metrics.get("failed"))
        translated = parse_nonnegative_metric(metrics.get("translated"))
        provider_results = parse_nonnegative_metric(metrics.get(provider_metric_key))
        target_results = parse_nonnegative_metric(metrics.get(target_metric_key)) if target_requires_cjk else None
        if any(value is None for value in (total, processed, failed, translated, provider_results)) or (
            target_requires_cjk and target_results is None
        ):
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                "翻译进程返回了无法解析或不是整数的结果统计；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
            )
        failure_codes = metrics.get("failure_codes")
        if not failure_codes:
            failure_codes = metrics.get("failureCodes")
        if failure_codes is None:
            failure_codes = {}
        normalized_failure_codes, invalid_failure_codes = normalize_report_failure_codes(failure_codes)
        if normalized_failure_codes is None:
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                "翻译进程返回的 failure_codes 不是对象；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
            )
        if invalid_failure_codes:
            raise_problem(
                500,
                "TRANSLATION_FAILURE_DETAILS_MISSING",
                "翻译进程返回的 failure_codes 含有泛化或无效错误码；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
                failure_codes=failure_codes,
                details={"invalidCodes": invalid_failure_codes[:20]},
            )
        failure_codes = normalized_failure_codes
        failed_items = metrics.get("failed_items")
        if failed_items is None:
            failed_items = []
        if not isinstance(failed_items, list):
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                "翻译进程返回的 failed_items 不是数组；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
            )
        if any(
            not isinstance(key, str) or not key.strip() or
            not isinstance(count, int) or isinstance(count, bool) or count < 0
            for key, count in failure_codes.items()
        ):
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                "翻译进程返回的 failure_codes 包含无效计数；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
            )
        if any(not isinstance(item, dict) for item in failed_items):
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                "翻译进程返回的 failed_items 含有无效条目；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
            )
        for item in failed_items:
            raw_item_code = item.get("code") or item.get("error_code") or item.get("errorCode")
            item_code = normalize_report_code(raw_item_code)
            if not item_code or not str(item.get("message") or item.get("error") or "").strip():
                raise_problem(
                    500,
                    "TRANSLATION_FAILURE_DETAILS_MISSING",
                    "翻译进程的失败条目缺少错误码或错误消息；结果没有写入缓存",
                    phase="translation",
                    metrics=metrics,
                    failed_items=failed_items,
                )
            item["code"] = item_code
        if failed > 0:
            diagnostics_valid, diagnostic_details = validate_failure_item_diagnostics(failed_items)
            if not diagnostics_valid:
                raise_problem(
                    500,
                    "INCONSISTENT_TRANSLATION_RESULT",
                    "翻译进程返回的失败条目中错误码与 HTTP 状态不一致；结果没有写入缓存",
                    phase="translation",
                    metrics=metrics,
                    failure_codes=failure_codes,
                    failed_items=failed_items,
                    details=diagnostic_details,
                )
        if not failure_codes:
            for item in failed_items:
                item_code = str(item.get("code") or "").strip()
                failure_codes[item_code] = failure_codes.get(item_code, 0) + 1
        expected_failed_items = min(max(failed, 0), 50)
        if failed == 0 and (failed_items or any(count > 0 for count in failure_codes.values())):
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                "翻译进程报告失败数为 0，但返回了失败详情；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
                failed_items=failed_items,
            )
        if failed > 0 and len(failed_items) != expected_failed_items:
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                f"翻译进程报告失败 {failed} 条，但只提供了 {len(failed_items)} 条失败详情；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
                failed_items=failed_items,
                details={"expectedFailedItems": expected_failed_items, "actualFailedItems": len(failed_items)},
            )
        if failed > 0:
            locations_valid, location_details = validate_failure_item_locations(
                vtt_text,
                failed_items,
                bilingual=bool(req.bilingual),
            )
            if not locations_valid:
                raise_problem(
                    500,
                    "TRANSLATION_FAILURE_DETAILS_MISSING",
                    "翻译进程的失败条目没有提供可唯一定位的字幕文字行；结果没有写入缓存",
                    phase="translation",
                    metrics=metrics,
                    failure_codes=failure_codes,
                    failed_items=failed_items,
                    details=location_details,
                )
        if failed > 0 and not failure_codes:
            raise_problem(
                500,
                "TRANSLATION_FAILURE_DETAILS_MISSING",
                "翻译进程报告了失败字幕，但没有返回 failure_codes 或失败条目错误码；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
                failed_items=failed_items,
            )
        if failed > 0 and sum(failure_codes.values()) != failed:
            raise_problem(
                500,
                "INCONSISTENT_TRANSLATION_RESULT",
                f"翻译进程报告失败 {failed} 条，但 failure_codes 合计为 {sum(failure_codes.values())}；结果没有写入缓存",
                phase="translation",
                metrics=metrics,
                failure_codes=failure_codes,
                failed_items=failed_items,
            )
        if failed > 0:
            item_failure_codes = {}
            for item in failed_items:
                item_code = str(item.get("code") or "")
                item_failure_codes[item_code] = item_failure_codes.get(item_code, 0) + 1
            sampled_codes_fit = all(
                failure_codes.get(code, 0) >= count
                for code, count in item_failure_codes.items()
            )
            if failed <= 50:
                code_distribution_matches = failure_code_maps_equal(item_failure_codes, failure_codes)
            else:
                code_distribution_matches = sampled_codes_fit
            if not code_distribution_matches:
                raise_problem(
                    500,
                    "INCONSISTENT_TRANSLATION_RESULT",
                    "翻译进程的 failure_codes 与失败条目错误码分布不一致；结果没有写入缓存",
                    phase="translation",
                    metrics=metrics,
                    failure_codes=failure_codes,
                    failed_items=failed_items,
                )
        metrics.update({
            "provider": provider_name,
            "total": total,
            "processed": processed,
            "failed": failed,
            "translated": translated,
            "provider_results": provider_results,
            "providerResults": provider_results,
            "target_results": target_results,
            "targetResults": target_results,
            "failed_items": failed_items,
            "failure_codes": failure_codes,
            "failureCodes": failure_codes,
        })
        target_count_mismatch = target_requires_cjk and target_results != provider_results
        if (
            total <= 0 or total != translatable_line_count(vtt_text) or
            processed < 0 or processed > total or processed != total or failed < 0 or failed > total or
            translated < 0 or translated > total or
            provider_results is None or (target_requires_cjk and target_results is None) or
            (provider_results is not None and (translated != provider_results or failed + provider_results != total)) or
            (provider_results is not None and (provider_results < 0 or provider_results > total)) or
            (target_results is not None and (target_results < 0 or target_results > total)) or
            (target_results is not None and target_results > provider_results) or
            target_count_mismatch
        ):
            mismatch_code = (
                "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
                if provider_name == "google-web" and target_count_mismatch and target_results < provider_results
                else "INCONSISTENT_TRANSLATION_RESULT"
            )
            mismatch_detail = (
                "Google Web 返回的中文条目少于 Provider 成功条目；部分响应没有目标语言，结果没有写入缓存"
                if mismatch_code == "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
                else (
                    "翻译进程返回的中文结果数量与 Provider 成功结果数量不一致；结果没有写入缓存"
                    if target_count_mismatch
                    else "翻译进程返回的 total/processed/translated/failed 统计不一致；结果没有写入缓存"
                )
            )
            raise_problem(
                500,
                mismatch_code,
                mismatch_detail,
                phase="translation",
                metrics=metrics,
                failure_codes=failure_codes,
                failed_items=failed_items,
            )
        if target_requires_cjk:
            cjk_coverage = has_cjk_in_successful_timed_cues(
                translated_vtt,
                failed_items,
                failed,
                bilingual=bool(req.bilingual),
                source_text=vtt_text,
                target=target_code,
            )
            if cjk_coverage is False or (failed > 0 and failed <= 50 and cjk_coverage is None):
                if cjk_coverage is None:
                    raise_problem(
                        500,
                        "TRANSLATION_FAILURE_DETAILS_MISSING",
                        "翻译报告了失败字幕，但失败明细没有可用于标记对应字幕文字行的位置；结果没有写入缓存",
                        phase="translation",
                        metrics=metrics,
                        failure_codes=failure_codes,
                        failed_items=failed_items,
                        details={"reason": "failed_items_missing_text_line_mapping"},
                    )
                raise_problem(
                    500,
                    "INCONSISTENT_TRANSLATION_RESULT",
                    "翻译统计报告了中文译文，但成功字幕文字行实际不包含可识别的中文或合法中性文字；结果没有写入缓存",
                    phase="translation",
                    metrics=metrics,
                    failure_codes=failure_codes,
                    failed_items=failed_items,
                    details={"targetResults": target_results},
                )
        no_provider_result = provider_results is not None and provider_results <= 0
        no_target_result = target_requires_cjk and target_results is not None and target_results <= 0
        if failed >= total or no_provider_result or no_target_result:
            if not failure_codes:
                failure_codes = {}
            metrics["failure_codes"] = failure_codes
            metrics["failureCodes"] = failure_codes
            result_error_code = no_result_failure_code(
                provider_name,
                str(req.target or "ZH").upper(),
                failure_codes,
                failed,
                provider_results,
                target_results,
            )
            result_status = 503 if result_error_code in {"ARGOS_DEPENDENCY_MISSING", "ARGOS_MODEL_MISSING"} else 422
            raise_problem(
                result_status,
                result_error_code,
                "翻译进程生成了 VTT，但没有检测到可用的目标语言译文；原文没有被写入缓存",
                phase="translation",
                metrics=metrics,
                failure_codes=failure_codes,
                failed_items=metrics.get("failed_items") or [],
                warnings=warnings,
            )
        if failed > 0:
            warnings.append(f"PARTIAL_TRANSLATION: {failed}/{total} 条字幕保留原文，结果不会写入缓存")
        if failed == 0:
            try:
                cache_file.write_text(translated_vtt, encoding="utf-8")
            except OSError as exc:
                warnings.append("CACHE_WRITE_FAILED: 翻译结果有效，但本地缓存保存失败")
                logger.warning("translation succeeded but cache write failed file=%s: %s", cache_file, exc)
        else:
            logger.warning("partial translation not cached failed=%s total=%s", failed, total)
        return translated_vtt, warnings, False, metrics


def cleanup_jobs_locked(now: int | None = None) -> None:
    now = now or int(time.time())
    removable_statuses = {"completed", "failed"}
    for job_id, job in list(_jobs.items()):
        if job.get("status") in removable_statuses and now - int(job.get("updated_at", now)) > JOB_TTL_SECONDS:
            del _jobs[job_id]
    overflow = len(_jobs) - JOB_MAX_COUNT
    if overflow <= 0:
        return
    completed = sorted(
        (
            (int(job.get("updated_at", now)), job_id)
            for job_id, job in _jobs.items()
            if job.get("status") in removable_statuses
        )
    )
    for _, job_id in completed[:overflow]:
        _jobs.pop(job_id, None)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/translate")
def translate(req: TranslateRequest) -> dict:
    translated_vtt, warnings, cache_hit, metrics = run_translation(req.vtt_text, req)
    return {"translated_vtt": translated_vtt, "warnings": warnings, "metrics": metrics, "cache_hit": cache_hit}


def _run_job(job_id: str, req: TranslateAsyncRequest) -> None:
    logger.info(
        "[job %s] started provider=%s target=%s requested_concurrency=%s requested_rps=%s retries=%s",
        job_id,
        req.provider,
        req.target,
        req.concurrency,
        req.rps,
        req.retries,
    )
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            job["status"] = "running"
            job["updated_at"] = int(time.time())

    def on_progress(current: int, total: int, line: str, partial_vtt: str = "") -> None:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "running"
            job["progress"] = {"current": current, "total": total, "line": line}
            if partial_vtt:
                job["partial_vtt"] = partial_vtt
            job["updated_at"] = int(time.time())
        logger.info("[job %s] progress current=%s total=%s", job_id, current, total)

    try:
        translated_vtt, warnings, cache_hit, metrics = run_translation(
            req.vtt_text,
            req,
            force_refresh=req.force_refresh,
            progress_callback=on_progress,
        )
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "completed"
            job["result"] = {
                "translated_vtt": translated_vtt,
                "warnings": warnings,
                "metrics": metrics,
                "cache_hit": cache_hit,
            }
            job["metrics"] = metrics
            job["warnings"] = warnings
            job["failed_items"] = metrics.get("failed_items") or []
            job["failure_codes"] = metrics.get("failureCodes") or {}
            job["updated_at"] = int(time.time())
        logger.info(
            "[job %s] completed cache_hit=%s warnings=%s",
            job_id,
            cache_hit,
            len(warnings),
        )
    except Exception as exc:
        problem = exception_problem(exc, phase="translation", instance=f"/translate-async/{job_id}")
        # Use the already-normalized problem status.  A malformed custom
        # exception must not make this error handler throw a second
        # ValueError, otherwise the job could remain stuck in `running` and
        # the client would eventually report a misleading timeout.
        status_code = int(problem.get("status") or 500)
        error_text = problem["detail"]
        error_code = problem["error_code"]
        with _jobs_lock:
            job = _jobs.get(job_id)
            if not job:
                return
            job["status"] = "failed"
            job["error"] = error_text
            job["error_code"] = error_code
            job["status_code"] = status_code
            job["error_detail"] = problem
            job["metrics"] = problem.get("metrics") or job.get("metrics")
            job["failure_codes"] = problem.get("failure_codes") or job.get("failure_codes")
            job["failed_items"] = problem.get("failed_items") or job.get("failed_items", [])
            job["warnings"] = problem.get("warnings") or job.get("warnings", [])
            job["updated_at"] = int(time.time())
        logger.error(
            "[job %s] failed code=%s status=%s message=%s",
            job_id,
            error_code,
            status_code,
            str(error_text).replace("\n", " ")[:320],
        )


@app.post("/translate-async")
def translate_async(req: TranslateAsyncRequest) -> dict:
    job_id = uuid.uuid4().hex
    # Publish the known work size before the worker imports/loads the
    # translator (Argos model startup can take noticeably longer on Windows).
    # Clients can therefore show 0/N + a preparing stage instead of appearing
    # stuck at the meaningless 0/0 state.
    initial_total = translatable_line_count(req.vtt_text)
    with _jobs_lock:
        cleanup_jobs_locked()
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": {
                "current": 0,
                "total": initial_total,
                "line": "正在准备本地翻译…" if initial_total > 0 else "",
                "stage": "preparing",
            },
            "partial_vtt": "",
            "result": None,
            "error": "",
            "error_code": "",
            "status_code": None,
            "metrics": None,
            "failure_codes": {},
            "failed_items": [],
            "warnings": [],
            "error_detail": None,
            "created_at": int(time.time()),
            "updated_at": int(time.time()),
        }
    worker = threading.Thread(target=_run_job, args=(job_id, req), daemon=True)
    worker.start()
    return {"job_id": job_id}


@app.get("/translate-async/{job_id}")
def translate_async_status(job_id: str) -> dict:
    with _jobs_lock:
        cleanup_jobs_locked()
        job = _jobs.get(job_id)
        if not job:
            raise_problem(404, "JOB_NOT_FOUND", "后台翻译任务不存在或已被清理", phase="backend", retryable=False)
        return job
