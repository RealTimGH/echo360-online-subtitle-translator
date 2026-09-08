(() => {
  // One error vocabulary for the content page, popup, options page and the
  // service-worker job boundary.  The UI must not have to reverse-engineer a
  // useful diagnosis from a flattened Error.message string.
  const root = globalThis;
  const ns = root.Echo360Translator = root.Echo360Translator || {};

  const PROVIDER_LABELS = {
    "google-web": "Google Translate 网页端点",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    openai: "OpenAI",
    deepl: "DeepL",
    argos: "Argos Translate（本地）",
  };

  const TARGET_LABELS = {
    ZH: "简体中文",
    "ZH-HK": "繁体中文（香港）",
    YUE: "粤语（繁体）",
    CANTONESE: "粤语（繁体，兼容别名）",
    EN: "英语",
    JA: "日语",
    KO: "韩语",
    FR: "法语",
    DE: "德语",
    ES: "西班牙语",
    IT: "意大利语",
    PT: "葡萄牙语",
    RU: "俄语",
    AR: "阿拉伯语",
    HI: "印地语",
  };

  // This is the public target-language contract shared by every request
  // boundary.  A label-only map is not enough: an unknown target could
  // otherwise fall through to a successful-looking non-CJK result.
  const SUPPORTED_TARGET_CODES = new Set(Object.keys(TARGET_LABELS));

  const PHASE_LABELS = {
    prepare: "准备翻译",
    video: "查找播放器",
    source: "获取字幕源",
    config: "读取翻译配置",
    cache: "读取翻译缓存",
    translation: "请求翻译服务",
    recovery: "翻译失败后的恢复尝试",
    render: "显示翻译字幕",
    preferences: "保存字幕设置",
    initialization: "初始化扩展",
    backend: "连接本地后端",
    unknown: "未知阶段",
  };

  const GENERIC_ERROR_CODES = new Set([
    "",
    "ERROR",
    "UNKNOWN",
    "UNKNOWN_ERROR",
    "TRANSLATION_ERROR",
    // Internal failure-item sentinel. It is useful when deriving a
    // diagnostic map, but it is never a sufficient provider diagnosis when
    // received from a boundary.
    "FAILURE_DETAIL_MISSING",
  ]);

  // These codes describe the adapter/process boundary, not the underlying
  // failure. They are useful as a last-resort envelope, but must not hide a
  // more actionable nested diagnosis such as HTTP_429, REQUEST_TIMEOUT or
  // UNSUPPORTED_TARGET_LANGUAGE. Keep this list deliberately small: a code
  // is a wrapper only when the caller cannot act on it without inspecting
  // another error field.
  const BOUNDARY_WRAPPER_CODES = new Set([
    "BACKEND_REQUEST_ERROR",
    "BACKEND_NETWORK_ERROR",
    "RUNTIME_MESSAGE_ERROR",
    "DIRECT_JOB_CREATE_FAILED",
    "DIRECT_JOB_READ_FAILED",
    "JOB_FAILED_UNCLASSIFIED",
    "TRANSLATOR_PROCESS_FAILED",
    // These are intentionally broad fallbacks emitted by an adapter or
    // server boundary. They must not hide a concrete nested diagnosis such
    // as HTTP_429, INVALID_PROVIDER_OUTPUT, or NO_TRANSLATIONS.
    "INTERNAL_ERROR",
    "PROVIDER_REQUEST_FAILED",
    "INVALID_BACKEND_RESPONSE",
  ]);

  // The translator's `total` counter is the number of text lines sent to a
  // provider, not the number of WebVTT cues.  Keep this rule in one place so
  // the content script, service worker and backend boundary cannot disagree
  // on whether a result is complete (especially for multi-line cues).
  const VTT_TIMING_LINE_RE = /^\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}(?:\s+.*)?$/;

  function normalizeCodeValue(value) {
    const normalized = String(value ?? "")
      .replace(/^\[|\]$/g, "")
      .trim()
      .toUpperCase()
      // Error codes are a transport contract. Normalize separators at this
      // boundary so HTTP 429, HTTP-429, and HTTP_429 cannot become different
      // diagnoses in different callers.
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized.replace(/^HTTP_+(\d{3})$/, "HTTP_$1");
  }

  function normalizeFailureCode(value) {
    const code = normalizeCodeValue(value);
    return code && !isGenericCode(code) ? code : "FAILURE_DETAIL_MISSING";
  }

  function isGenericCode(value) {
    return GENERIC_ERROR_CODES.has(normalizeCodeValue(value));
  }

  function isWrapperCode(value) {
    return BOUNDARY_WRAPPER_CODES.has(normalizeCodeValue(value));
  }

  function normalizeHttpStatus(value) {
    const status = finiteNumber(value);
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  }

  function alignHttpCode(code, status) {
    const normalized = normalizeCodeValue(code);
    const normalizedStatus = normalizeHttpStatus(status);
    return normalizedStatus && /^HTTP_\d{3}$/.test(normalized) && normalized !== `HTTP_${normalizedStatus}`
      ? `HTTP_${normalizedStatus}`
      : normalized;
  }

  function validateFailureItemDiagnostics(failedItems = []) {
    if (!Array.isArray(failedItems)) {
      return { ok: false, reason: "failed_items_not_array", index: null };
    }
    for (let index = 0; index < failedItems.length; index += 1) {
      const item = failedItems[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, reason: "failed_item_not_object", index };
      }
      const code = normalizeCodeValue(item.code ?? item.error_code ?? item.errorCode);
      const status = normalizeHttpStatus(item.status ?? item.status_code ?? item.http_status);
      const upstreamStatus = normalizeHttpStatus(item.upstream_status ?? item.upstreamStatus);
      if (!status || !/^HTTP_\d{3}$/.test(code)) continue;
      const codeStatus = Number(code.slice(5));
      const comparableStatus = upstreamStatus || status;
      if (codeStatus !== comparableStatus) {
        return {
          ok: false,
          reason: "code_status_mismatch",
          index,
          code,
          status,
          upstreamStatus,
        };
      }
    }
    return { ok: true };
  }

  function isTranslatableVttLine(value) {
    const line = String(value ?? "").trim();
    // Numeric caption text is valid (for example, a lecturer saying “123”)
    // and is now kept because callers only invoke this helper inside a timed
    // cue. Cue identifiers are excluded by timedCueTextEntries(), where the
    // parser knows whether it is currently inside a cue body.
    if (!line || /^WEBVTT\b/i.test(line) || VTT_TIMING_LINE_RE.test(line)) return false;
    if (/^(?:NOTE|STYLE|REGION)\b/i.test(line)) return false;
    return true;
  }

  function countTranslatableLines(vtt) {
    // Count only text physically inside a timed cue. Counting every
    // non-empty VTT line treats cue identifiers, WEBVTT metadata and NOTE /
    // STYLE blocks as provider input. That creates false total/processed
    // mismatches and, more seriously, can make a syntactically valid result
    // look incomplete at one boundary but complete at another.
    return timedCueTextEntries(vtt).length;
  }

  function timedCueTextBlocks(vtt) {
    const lines = String(vtt || "").replace(/\r/g, "").split("\n");
    const blocks = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!VTT_TIMING_LINE_RE.test(lines[index])) continue;
      const text = [];
      for (let next = index + 1; next < lines.length && lines[next].trim() !== ""; next += 1) {
        if (VTT_TIMING_LINE_RE.test(lines[next])) break;
        text.push(lines[next]);
      }
      blocks.push(text.join("\n"));
    }
    return blocks;
  }

  // Return the physical VTT line for every translatable caption line.  The
  // provider counters and failed_items use this unit (not the cue unit), so
  // validation must be able to prove coverage at the same granularity.
  function timedCueTextEntries(vtt) {
    const lines = String(vtt || "").replace(/\r/g, "").split("\n");
    const entries = [];
    let cue = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!VTT_TIMING_LINE_RE.test(lines[index])) continue;
      cue += 1;
      for (let next = index + 1; next < lines.length && lines[next].trim() !== ""; next += 1) {
        if (VTT_TIMING_LINE_RE.test(lines[next])) break;
        if (!isTranslatableVttLine(lines[next])) continue;
        entries.push({ cue, line: next + 1, text: lines[next] });
      }
    }
    return entries;
  }

  function hasCjkInEveryTimedCue(vtt, options = {}) {
    const entries = timedCueTextEntries(vtt);
    if (entries.length === 0) return false;
    if (options?.bilingual === true) {
      const blocks = timedCueTextBlocks(vtt);
      return blocks.length > 0 && blocks.every((block) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(block));
    }
    return entries.every((entry) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(entry.text));
  }

  function hasCjkInSuccessfulTimedCues(vtt, failedItems = [], expectedFailedCount = null, options = {}) {
    const entries = timedCueTextEntries(vtt);
    if (entries.length === 0) return false;
    const failures = Array.isArray(failedItems) ? failedItems : [];
    if (failures.length === 0) return hasCjkInEveryTimedCue(vtt, options);
    const expected = positiveInteger(expectedFailedCount, null);
    // Result contracts cap item-level diagnostics at 50. If the aggregate
    // failure count is larger than the supplied sample, an uncaptured failed
    // cue may still contain original text. Returning null tells validators
    // that per-cue coverage cannot be proven from this sample; the result is
    // still visibly partial because the aggregate `failed` counter is > 0.
    if (expected != null && expected > failures.length) return null;

    // Bilingual output intentionally contains the original and translated
    // lines in one cue.  Its source/translation line offsets cannot be
    // inferred from a physical line number, so use the cue-level proof for
    // that explicit format.
    if (options?.bilingual === true) {
      const blocks = timedCueTextBlocks(vtt);
      const failedCues = new Set();
      for (const item of failures) {
        const cue = positiveInteger(item?.cue, null);
        if (cue == null || cue < 1 || cue > blocks.length) return null;
        failedCues.add(cue);
      }
      return blocks.every((block, index) => failedCues.has(index + 1) ||
        /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(block));
    }

    const failedLines = new Set();
    const entriesByLine = new Map(entries.map((entry) => [entry.line, entry]));
    for (const item of failures) {
      const cue = positiveInteger(item?.cue, null);
      const line = positiveInteger(item?.line, null);
      if (line != null) {
        const entry = entriesByLine.get(line);
        // A line number from a different cue is not a valid mapping. Refuse
        // to make a success decision from contradictory diagnostics.
        if (!entry || (cue != null && (cue < 1 || cue !== entry.cue))) return null;
        failedLines.add(line);
        continue;
      }
      // Legacy diagnostics may contain only a cue. This is provable only for
      // a single-line cue; excluding a multi-line cue wholesale would permit
      // an untranslated sibling line to masquerade as a successful result.
      if (cue == null || cue < 1) return null;
      const cueEntries = entries.filter((entry) => entry.cue === cue);
      if (cueEntries.length !== 1) return null;
      failedLines.add(cueEntries[0].line);
    }
    return entries.every((entry) => failedLines.has(entry.line) ||
      /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(entry.text));
  }

  // A failed_items entry is also a rendering contract: the UI must be able
  // to identify exactly which source text was not translated. A cue-only
  // coordinate is accepted for a single-line cue (and for explicit
  // bilingual output); it is ambiguous for a multi-line cue and therefore
  // must be rejected instead of silently painting the wrong subtitle.
  function validateFailureItemLocations(vtt, failedItems = [], options = {}) {
    const entries = timedCueTextEntries(vtt);
    const byLine = new Map(entries.map((entry) => [entry.line, entry]));
    const byCue = new Map();
    for (const entry of entries) {
      const list = byCue.get(entry.cue) || [];
      list.push(entry);
      byCue.set(entry.cue, list);
    }
    if (!Array.isArray(failedItems)) {
      return { ok: false, reason: "failed_items_not_array", index: null };
    }
    const seen = new Set();
    for (let index = 0; index < failedItems.length; index += 1) {
      const item = failedItems[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, reason: "failed_item_not_object", index };
      }
      const hasCueField = item.cue !== undefined && item.cue !== null;
      const hasLineField = item.line !== undefined && item.line !== null;
      const cue = positiveInteger(item.cue, null);
      const line = positiveInteger(item.line, null);
      if (hasCueField && (cue == null || cue < 1)) {
        return { ok: false, reason: "invalid_cue", index, cue: item.cue };
      }
      if (hasLineField && (line == null || line < 1)) {
        return { ok: false, reason: "invalid_line", index, line: item.line };
      }

      let locationKey = "";
      if (line != null) {
        const entry = byLine.get(line);
        if (!entry) return { ok: false, reason: "line_out_of_range", index, line };
        if (cue != null && cue !== entry.cue) {
          return { ok: false, reason: "cue_line_mismatch", index, cue, line };
        }
        locationKey = `line:${line}`;
      } else if (cue != null) {
        const cueEntries = byCue.get(cue) || [];
        if (cueEntries.length === 0) {
          return { ok: false, reason: "cue_out_of_range", index, cue };
        }
        if (options?.bilingual !== true && cueEntries.length !== 1) {
          return { ok: false, reason: "cue_mapping_ambiguous", index, cue };
        }
        locationKey = `cue:${cue}`;
      } else {
        return { ok: false, reason: "location_missing", index };
      }
      if (seen.has(locationKey)) {
        return { ok: false, reason: "duplicate_location", index, location: locationKey };
      }
      seen.add(locationKey);
    }
    return {
      ok: true,
      mapped: seen.size,
      cueCount: byCue.size,
      textLineCount: entries.length,
    };
  }

  function isSensitiveKey(key) {
    return /^(?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|secret|key|signature|sig|x-amz-signature|expires|x-amz-expires)$/i.test(String(key || ""));
  }

  function clean(value, limit = 500) {
    const rawText = value && typeof value === "object"
      ? safeStructured(value, limit)
      : String(value ?? "");
    const text = rawText
      // Consume the authentication scheme together with its value. If the
      // first expression only replaces `Authorization: Bearer`, the token
      // itself remains in the message and can leak into the UI/copy payload.
      .replace(/(\b(?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|password|secret|key)\b\s*["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|DeepL-Auth-Key)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&}\]"]+)/gi, "$1[REDACTED]")
      .replace(/\b(?:Bearer|Basic|DeepL-Auth-Key)\s+[^\s,;&}\]"]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:api[_-]?key|client[_-]?key|secret[_-]?key|authorization|bearer|token|access[_-]?token|refresh[_-]?token|cookie|password|secret|key|signature|sig|x-amz-signature|expires|x-amz-expires)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
  }

  function cleanMessage(value) {
    return clean(value, 800).replace(/^Error:\s*/i, "").trim();
  }

  function redactUrl(value, limit = 500) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    try {
      const base = root.location?.href;
      const url = base ? new URL(raw, base) : new URL(raw);
      for (const key of Array.from(url.searchParams.keys())) {
        if (isSensitiveKey(key)) url.searchParams.set(key, "[REDACTED]");
      }
      return clean(url.toString(), limit);
    } catch (_) {
      return clean(raw, limit);
    }
  }

  function safeStructured(value, limit = 800) {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return clean(value, limit);
    }
    try {
      // `sanitizeDetails` uses a path-local cycle set. The previous JSON
      // replacer kept every visited object forever and falsely labelled a
      // shared sibling object as `[Circular]`.
      const sanitized = JSON.stringify(sanitizeDetails(value));
      return clean(sanitized, limit);
    } catch (_) {
      return "[结构化附加信息无法序列化]";
    }
  }

  // Console diagnostics use the same redaction and size limits as error
  // details. Keeping this formatter here prevents the in-page log panel from
  // accidentally displaying credentials or raw provider response objects when
  // a normal debug statement includes structured data.
  function formatDebugLog(values, limit = 2_400) {
    const items = Array.isArray(values) ? values : [values];
    const parts = items.map((value) => {
      if (value instanceof Error) return safeStructured(serializeError(value), 1_200);
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      if (typeof value === "symbol") return String(value);
      return safeStructured(value, 1_200);
    }).filter((value) => value !== "");
    return clean(parts.join(" "), limit);
  }

  function isUrlDetailKey(key) {
    const normalized = String(key || "")
      .replace(/([a-z\d])([A-Z])/g, "$1_$2")
      .replace(/[-\s]+/g, "_")
      .toLowerCase();
    return /(?:^|_)(?:url|uri|href|source|endpoint|instance|location|origin)(?:_?(?:id|key))?$/.test(normalized) ||
      /(?:^|_)source_(?:url|uri|href|id|key)$/.test(normalized);
  }

  function sanitizeDetails(value, depth = 0, seen = new WeakSet(), keyName = "") {
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return typeof value === "string"
        ? (isUrlDetailKey(keyName) ? redactUrl(value, 500) : clean(value, 500))
        : value;
    }
    if (depth >= 4) return "[详情已截断]";
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.slice(0, 50).map((item) => sanitizeDetails(item, depth + 1, seen, keyName));
      // `seen` is path-local. A shared object in two sibling fields is not a
      // cycle and must not be displayed as a false `[Circular]` diagnostic.
      seen.delete(value);
      return result;
    }
    const result = Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      isSensitiveKey(key)
        ? "[REDACTED]"
        : sanitizeDetails(item, depth + 1, seen, key),
    ]));
    seen.delete(value);
    return result;
  }

  function finiteNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function positiveInteger(value, fallback = null) {
    if (typeof value === "boolean") return fallback;
    const number = finiteNumber(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
  }

  function isProblemRecord(item) {
    return !!(item && typeof item === "object" && !Array.isArray(item) && (
      item.detail != null || item.message != null || item.error != null || item.error_code != null ||
      item.code != null || item.status != null || item.title != null || item.type != null ||
      item.metrics != null || item.failed_items != null || item.failure_codes != null
    ));
  }

  function problemObjects(errorLike) {
    if (!errorLike || typeof errorLike !== "object") return [];
    const candidates = [
      errorLike.problem,
      errorLike.error_detail,
      errorLike.errorDetail,
      errorLike.error,
      errorLike.data?.problem,
      errorLike.data?.error_detail,
      errorLike.data?.error,
      // Some adapters put the RFC fields directly under `data` rather than
      // wrapping them in `problem`. Only accept it when it actually looks
      // like an error object, so a successful translation result is not
      // mistaken for the problem document.
      errorLike.data,
    ];
    const records = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || seen.has(item)) return;
      seen.add(item);
      if (isProblemRecord(item)) records.push(item);
      // Adapters sometimes put a wrapper inside `error` and the actual
      // problem inside `data` (or vice versa). Preserve every record so a
      // generic outer envelope cannot hide a concrete nested diagnosis.
      for (const key of ["problem", "error_detail", "errorDetail", "error", "data"]) {
        const nested = item[key];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) add(nested);
      }
    };
    candidates.forEach(add);
    return records;
  }

  function problemObject(errorLike) {
    const problems = problemObjects(errorLike);
    if (problems.length <= 1) return problems[0] || {};
    const outerStatus = normalizeHttpStatus(
      errorLike?.status ?? errorLike?.statusCode ?? errorLike?.status_code
    );
    const score = (problem, index) => {
      const codes = [problem.code, problem.error_code, problem.errorCode]
        .map(normalizeCodeValue)
        .filter(Boolean);
      const concrete = codes.find((code) => !isGenericCode(code) && !isWrapperCode(code));
      const httpCode = codes.find((code) => /^HTTP_\d{3}$/.test(code));
      const problemStatus = normalizeHttpStatus(problem.status ?? problem.statusCode ?? problem.status_code);
      const explicitUpstream = normalizeHttpStatus(problem.upstream_status ?? problem.upstreamStatus);
      let value = 0;
      if (concrete) value += 100;
      if (httpCode && outerStatus != null && Number(httpCode.slice(5)) !== outerStatus) value += 1_000;
      if (explicitUpstream != null) value += 2_000;
      if (problemStatus != null && outerStatus != null && problemStatus !== outerStatus) value += 900;
      if (problem.detail || problem.message) value += 10;
      return value - index / 100;
    };
    return problems.reduce((best, problem, index) =>
      score(problem, index) > score(best.problem, best.index)
        ? { problem, index }
        : best,
    { problem: problems[0], index: 0 }).problem;
  }

  function readStatus(errorLike) {
    const problems = problemObjects(errorLike);
    const candidates = [
      errorLike?.status,
      errorLike?.statusCode,
      errorLike?.status_code,
      ...problems.flatMap((problem) => [problem.status, problem.statusCode, problem.status_code]),
    ];
    for (const candidate of candidates) {
      const explicit = finiteNumber(candidate);
      if (Number.isInteger(explicit) && explicit >= 100 && explicit <= 599) return explicit;
    }
    // Read through the same nested/legacy fields as the message formatter. A
    // response such as `{ error: "HTTP 429" }` must not lose its status just
    // because it has no top-level `message` field.
    const message = readMessage(errorLike);
    const match = message.match(/\bHTTP[_\s]+(\d{3})\b/i);
    const inferred = match ? Number(match[1]) : null;
    return Number.isInteger(inferred) && inferred >= 100 && inferred <= 599 ? inferred : null;
  }

  function readMessage(errorLike) {
    if (errorLike == null) return "Unknown translation error";
    if (typeof errorLike === "string") return cleanMessage(errorLike);
    if (errorLike instanceof Error) return cleanMessage(errorLike.message || String(errorLike));
    const problems = problemObjects(errorLike);
    const preferredProblem = problemObject(errorLike);
    const detailCandidates = [
      preferredProblem.detail,
      errorLike.detail,
      ...problems.filter((problem) => problem !== preferredProblem).map((problem) => problem.detail),
    ];
    for (const detail of detailCandidates) {
      if (typeof detail === "string" && detail.trim()) return cleanMessage(detail);
      if (detail && typeof detail === "object") {
        const nested = detail.message || detail.error || detail.detail;
        if (nested) return cleanMessage(nested);
      }
    }
    const objectFallback = errorLike && typeof errorLike === "object"
      ? safeStructured(errorLike, 800)
      : String(errorLike);
    const problem = preferredProblem;
    return cleanMessage(
      errorLike.message ||
      (typeof errorLike.error === "string" ? errorLike.error : "") ||
      problem.message ||
      (typeof problem.error === "string" ? problem.error : "") ||
      problem.title || errorLike.title || objectFallback
    );
  }

  // Error objects cross several boundaries in this extension: provider ->
  // Python -> service worker -> content script -> UI. A boundary often adds a
  // generic wrapper such as BACKEND_NETWORK_ERROR while preserving the useful
  // root cause under details.causeCode. Walk only the documented diagnostic
  // containers so a random string in an unrelated payload cannot become an
  // error code by accident.
  function nestedDiagnosticFields(errorLike) {
    const result = { codes: [], statuses: [] };
    const seen = new Set();
    const codeKeys = [
      "causeCode", "cause_code", "rootCode", "root_code",
      "underlyingCode", "underlying_code", "upstreamCode", "upstream_code",
      "code", "error_code", "errorCode",
    ];
    const statusKeys = [
      "causeStatus", "cause_status", "causeUpstreamStatus", "cause_upstream_status",
      "upstream_status_code", "upstreamStatusCode", "cause_status_code",
      "status", "status_code", "statusCode",
    ];
    const nestedKeys = [
      "details", "cause", "causeError", "cause_error", "upstream",
      "problem", "error_detail", "errorDetail", "data",
    ];
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4 || seen.has(value)) return;
      seen.add(value);
      for (const key of codeKeys) {
        if (value[key] != null) result.codes.push(value[key]);
      }
      for (const key of statusKeys) {
        if (value[key] != null) result.statuses.push(value[key]);
      }
      for (const key of nestedKeys) visit(value[key], depth + 1);
      seen.delete(value);
    };
    visit(errorLike);
    return result;
  }

  function readCode(errorLike, status, message) {
    const preferredProblem = problemObject(errorLike);
    const nestedDiagnostics = nestedDiagnosticFields(errorLike);
    const candidates = [
      ...nestedDiagnostics.codes,
      preferredProblem.code,
      preferredProblem.error_code,
      preferredProblem.errorCode,
      ...problemObjects(errorLike).flatMap((problem) => [problem.code, problem.error_code, problem.errorCode]),
      errorLike?.code,
      errorLike?.error_code,
      errorLike?.errorCode,
    ];
    // Generic adapter codes are placeholders, not authoritative diagnoses.
    // Look through every boundary field before falling back to inference;
    // otherwise a top-level TRANSLATION_ERROR can hide a nested HTTP_429.
    const normalizedCandidates = candidates
      .map(normalizeCodeValue)
      .filter(Boolean);
    const explicit = normalizedCandidates
      .find((candidate) => !isGenericCode(candidate) && !isWrapperCode(candidate));
    if (explicit) {
      // Prefer the nested, actionable diagnosis over a boundary envelope.
      // The outer HTTP status can describe the adapter response while the
      // nested code describes the upstream cause; replacing the latter with
      // HTTP_500 would erase the useful rate-limit/configuration diagnosis.
      return explicit;
    }
    const bracket = String(message).match(/^\[([A-Z0-9_]+)\]/i);
    if (bracket) {
      const bracketCode = normalizeCodeValue(bracket[1]);
      // A flattened adapter may leave `[TRANSLATION_ERROR]` in front of a
      // useful HTTP/network diagnosis. Treat generic bracket prefixes the
      // same way as generic structured codes and continue inferring.
      if (!isGenericCode(bracketCode)) return bracketCode;
    }
    if (status) return `HTTP_${status}`;
    if (errorLike?.name === "AbortError") return "REQUEST_TIMEOUT";
    const lower = String(message).toLowerCase();
    if (/load failed|failed to fetch|networkerror|network request failed|connection reset|connection closed|econnrefused|econnreset|ehostunreach|enotfound|offline/.test(lower)) {
      return "NETWORK_ERROR";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) return "TRANSLATION_TIMEOUT";
    if (lower.includes("job not found")) return "JOB_NOT_FOUND";
    if (lower.includes("未找到可用字幕源")) return "NO_VTT_SOURCE";
    if (lower.includes("provider") && /config|model|unsupported|setting/.test(lower)) return "PROVIDER_CONFIG_ERROR";
    if (candidates.some((candidate) => normalizeCodeValue(candidate) === "FAILURE_DETAIL_MISSING")) {
      return "ERROR_DETAILS_MISSING";
    }
    const wrapper = normalizedCandidates.find((candidate) => !isGenericCode(candidate));
    if (wrapper) return wrapper;
    if (errorLike == null || (
      typeof errorLike === "object" &&
      !Array.isArray(errorLike) &&
      Object.keys(errorLike).length === 0
    )) return "ERROR_DETAILS_MISSING";
    return "TRANSLATION_ERROR";
  }

  function readUpstreamStatus(errorLike, code, outerStatus) {
    const normalizedOuter = normalizeHttpStatus(outerStatus);
    const nestedDiagnostics = nestedDiagnosticFields(errorLike);
    const explicitUpstream = normalizeHttpStatus(errorLike?.upstream_status ?? errorLike?.upstreamStatus);
    if (explicitUpstream != null && explicitUpstream !== normalizedOuter) return explicitUpstream;
    const diagnosticStatus = nestedDiagnostics.statuses
      .map(normalizeHttpStatus)
      .find((value) => value != null && value !== normalizedOuter);
    if (diagnosticStatus != null) return diagnosticStatus;
    const nestedStatuses = problemObjects(errorLike)
      .flatMap((problem) => [problem.status, problem.statusCode, problem.status_code])
      .map(normalizeHttpStatus)
      .filter((value) => value != null);
    const nestedStatus = nestedStatuses.find((value) => value !== normalizedOuter) || null;
    if (nestedStatus != null) return nestedStatus;
    const normalizedCode = normalizeCodeValue(code);
    if (/^HTTP_\d{3}$/.test(normalizedCode)) {
      const codeStatus = Number(normalizedCode.slice(5));
      if (codeStatus !== normalizedOuter) return codeStatus;
    }
    return null;
  }

  function getMetrics(errorLike, context) {
    // Async jobs may put counters directly on `progress` while direct jobs put
    // them under `metrics`. Merge both so a failure never loses its last known
    // 304/91/0 progress snapshot at the UI boundary.
    return {
      ...(errorLike?.progress && typeof errorLike.progress === "object" ? errorLike.progress : {}),
      ...(context?.metrics && typeof context.metrics === "object" ? context.metrics : {}),
      ...(errorLike?.progress?.metrics && typeof errorLike.progress.metrics === "object" ? errorLike.progress.metrics : {}),
      ...(errorLike?.metrics && typeof errorLike.metrics === "object" ? errorLike.metrics : {}),
      ...problemObjects(errorLike).reduce((merged, problem) => ({
        ...merged,
        ...(problem.metrics && typeof problem.metrics === "object" ? problem.metrics : {}),
      }), {}),
    };
  }

  function normalizeFailureCodeMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const normalized = {};
    for (const [key, count] of Object.entries(value)) {
      const amount = positiveInteger(count, 0);
      if (amount <= 0) continue;
      const code = normalizeFailureCode(key);
      normalized[code] = (normalized[code] || 0) + amount;
    }
    return normalized;
  }

  function getFailureCodes(errorLike, metrics, context) {
    const candidates = [
      errorLike?.failure_codes,
      errorLike?.failureCodes,
      ...problemObjects(errorLike).flatMap((problem) => [problem.failure_codes, problem.failureCodes]),
      metrics?.failureCodes,
      metrics?.failure_codes,
      context?.failureCodes,
      context?.failure_codes,
    ];
    const explicitValue = candidates.find((value) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) ||
      candidates.find((value) => value && typeof value === "object" && !Array.isArray(value));
    const explicit = normalizeFailureCodeMap(explicitValue);

    const failedItems = getFailedItems(errorLike, context);
    const derived = Object.fromEntries(Object.entries(failedItems.reduce((counts, item) => {
      const code = normalizeFailureCode(item?.code);
      counts[code] = (counts[code] || 0) + 1;
      return counts;
    }, {})).filter(([, count]) => count > 0));
    const explicitHasSpecific = Object.keys(explicit).some((code) => code !== "FAILURE_DETAIL_MISSING");
    const derivedHasSpecific = Object.keys(derived).some((code) => code !== "FAILURE_DETAIL_MISSING");
    // Prefer an explicit aggregate only when it contains an actual diagnosis.
    // A generic adapter map must not hide the more useful item-level HTTP or
    // provider codes that crossed the same boundary.
    if (explicitHasSpecific || !derivedHasSpecific) {
      if (Object.keys(explicit).length > 0) return explicit;
    }
    if (Object.keys(derived).length > 0) return derived;

    // Some legacy direct-job errors only carried this diagnostic inside the
    // flattened message. Preserve it so the diagnosis can still distinguish
    // rate limiting from a generic provider failure.
    const message = readMessage(errorLike);
    const match = message.match(/failure[_\s]?codes?\s*[=:]\s*\{([^}]*)\}/i);
    if (!match) return {};
    const parsed = {};
    for (const part of match[1].split(",")) {
      const [key, count] = part.split(":").map((item) => String(item || "").trim());
      const normalizedCount = positiveInteger(count, 0);
      if (key && normalizedCount > 0) {
        const normalizedKey = normalizeFailureCode(key);
        parsed[normalizedKey] = (parsed[normalizedKey] || 0) + normalizedCount;
      }
    }
    return parsed;
  }

  function getFailedItems(errorLike, context) {
    const candidates = [
      errorLike?.failed_items,
      errorLike?.failedItems,
      ...problemObjects(errorLike).flatMap((problem) => [problem.failed_items, problem.failedItems]),
      context?.failedItems,
    ];
    const value = candidates.find((item) => Array.isArray(item) && item.length > 0) ||
      candidates.find((item) => Array.isArray(item)) || [];
    return value.slice(0, 50).map((item) => {
      const itemMessage = clean(item?.message || item?.error || "字幕请求失败", 240);
      const itemStatus = readStatus(item);
      const rawItemCode = item?.code || item?.error_code || item?.errorCode;
      const itemCode = !rawItemCode
        ? "FAILURE_DETAIL_MISSING"
        : isGenericCode(rawItemCode)
          ? (isGenericCode(readCode(item, itemStatus, itemMessage))
            ? "FAILURE_DETAIL_MISSING"
            : normalizeCodeValue(readCode(item, itemStatus, itemMessage)))
          : normalizeCodeValue(rawItemCode) || "FAILURE_DETAIL_MISSING";
      return {
      cue: positiveInteger(item?.cue, null),
      line: positiveInteger(item?.line, null),
      // An item without its own provider diagnosis is a missing diagnostic,
      // not a generic translation error. The top-level validator normally
      // rejects such a result, but old jobs can still reach this formatter.
      code: clean(itemCode, 80),
      status: itemStatus,
      message: itemMessage,
    };
    });
  }

  function normalizePhase(value) {
    const phase = String(value || "unknown").trim().toLowerCase();
    return PHASE_LABELS[phase] ? phase : "unknown";
  }

  function hasRateLimit(code, status, failureCodes, metrics) {
    return status === 429 || code === "HTTP_429" ||
      Number(metrics?.rateLimitCount || 0) > 0 || Number(failureCodes?.HTTP_429 || 0) > 0;
  }

  const NON_RETRYABLE_ERROR_CODES = new Set([
    "ERROR_DETAILS_MISSING",
    "TRANSLATION_ERROR",
    "HTTP_400",
    "HTTP_401",
    "HTTP_403",
    "HTTP_404",
    "INVALID_REQUEST",
    "UNSUPPORTED_PROVIDER",
    "UNSUPPORTED_TARGET_LANGUAGE",
    "UNSUPPORTED_PROVIDER_PROTOCOL",
    "INVALID_REASONING_EFFORT",
    "PROVIDER_CONFIG_ERROR",
    "PROVIDER_API_KEY_MISSING",
    "ARGOS_DEPENDENCY_MISSING",
    "ARGOS_MODEL_MISSING",
    "INVALID_PROVIDER_RESPONSE",
    "INVALID_PROVIDER_OUTPUT",
    "INCONSISTENT_TRANSLATION_RESULT",
    "TRANSLATION_FAILURE_DETAILS_MISSING",
    "TRANSLATOR_SUMMARY_INVALID",
    "VALIDATION_UNAVAILABLE",
  ]);

  const RETRYABLE_ERROR_CODES = new Set([
    "HTTP_408",
    "HTTP_425",
    "HTTP_429",
    "NETWORK_ERROR",
    "REQUEST_TIMEOUT",
    "TRANSLATION_TIMEOUT",
    "RESOURCE_NETWORK_ERROR",
    "RESOURCE_FETCH_FAILED",
    "SUBTITLE_NETWORK_ERROR",
    "SUBTITLE_FETCH_FAILED",
    "CACHE_READ_FAILED",
    "CACHE_WRITE_FAILED",
    "PARTIAL_TRANSLATION",
    "RENDER_FAILED",
    "RENDER_MOUNT_FAILED",
    "TRANSCRIPT_BRIDGE_TIMEOUT",
    "TRANSCRIPT_BRIDGE_FAILED",
    "TRANSCRIPT_BRIDGE_POST_FAILED",
    "TRANSCRIPT_PANEL_NOT_FOUND",
    "TRANSCRIPT_PANEL_AMBIGUOUS",
    "TRANSCRIPT_LIST_NOT_FOUND",
    "TRANSCRIPT_REACT_FIBER_NOT_FOUND",
    "TRANSCRIPT_REACT_LIST_NOT_FOUND",
    "TRANSCRIPT_REACT_GRID_NOT_FOUND",
    "TRANSCRIPT_ROW_COUNT_MISMATCH",
    "TRANSCRIPT_ROW_MANAGER_INVALID",
    "TRANSCRIPT_BRIDGE_INSTALL_FAILED",
    "TRANSCRIPT_BRIDGE_BINDING_CHANGED",
    "TRANSCRIPT_BRIDGE_BINDING_INCONSISTENT",
    "TRANSCRIPT_BRIDGE_STATE_NOT_FOUND",
    "TRANSCRIPT_LAYOUT_CONFIGURE_FAILED",
    "TRANSCRIPT_LAYOUT_RECOMPUTE_FAILED",
    "TRANSCRIPT_BRIDGE_STALE_REVISION",
    "VIDEO_NOT_FOUND",
    "STALE_JOB",
    "GOOGLE_WEB_ALL_REQUESTS_FAILED",
    "GOOGLE_WEB_INVALID_RESPONSES",
    "GOOGLE_WEB_NO_TARGET_TRANSLATIONS",
  ]);

  function describe(code, status, message, metrics, failureCodes, context) {
    const total = positiveInteger(metrics?.total, null);
    const failed = positiveInteger(metrics?.failed, null);
    const rateLimited = hasRateLimit(code, status, failureCodes, metrics);
    // When an adapter returns HTTP 500 with a structured upstream HTTP_429,
    // the stable code is the actionable value. Descriptions must use the same
    // status or the UI would display contradictory “HTTP 500” and “HTTP 429”.
    const codeHttpStatus = /^HTTP_\d{3}$/.test(String(code || ""))
      ? Number(String(code).slice(5))
      : null;
    const diagnosticHttpStatus = codeHttpStatus || status;
    const severity = context.severity === "warning" || context.error?.severity === "warning"
      ? "warning"
      : "error";
    const defaultTitle = severity === "warning" ? "翻译完成，但存在问题" : "翻译失败";
    let title = defaultTitle;
    let summary = message || "发生了未分类错误";
    let recommendation = "请展开“诊断详情”，按建议处理后重试。";

    if (code === "GOOGLE_WEB_ALL_REQUESTS_FAILED") {
      if (rateLimited) {
        title = "Google 网页翻译被限流";
        summary = `Google 网页端点拒绝了本次请求${total != null ? `（${failed ?? total}/${total} 条字幕失败）` : ""}，检测到 HTTP 429。`;
        recommendation = "请先停止连续重试，等待几分钟解除限流；之后使用 concurrency=3、RPS=3，或切换到 DeepSeek/Gemini/OpenAI/DeepL。";
      } else {
        title = "Google 网页翻译全部失败";
        summary = `Google 网页端点没有返回可用译文${total != null ? `（${failed ?? total}/${total} 条字幕失败）` : ""}。`;
        recommendation = "请检查网络和扩展站点权限；如果仍失败，切换到 API Provider。";
      }
    } else if (code === "GOOGLE_WEB_INVALID_RESPONSES") {
      title = "Google 返回格式无效";
      summary = `Google 网页端点确实返回了响应，但扩展无法按预期解析翻译内容${total != null ? `（${failed ?? total}/${total} 条未成功）` : ""}；这不是字幕源为空。`;
      recommendation = "检查 Google Web Endpoint 是否被代理/网络改写；稍后重试，仍失败时切换到 API Provider。";
    } else if (code === "GOOGLE_WEB_NO_TARGET_TRANSLATIONS") {
      title = "Google 返回了结果，但没有目标语言";
      summary = "请求完成了，但响应不是可用的中文翻译，可能是端点返回原文或目标语言参数没有生效。";
      recommendation = "请稍后重试；如果连续出现，请切换到 API Provider。";
    } else if (code === "NO_TARGET_TRANSLATION") {
      title = "单条字幕没有目标语言译文";
      summary = "Provider 返回了非空内容，但该条字幕中没有可识别的目标语言文字；该条已保留原文并计入失败。";
      recommendation = "查看失败字幕详情；如果多条字幕都出现，请降低并发/RPS、检查目标语言参数，或切换 Provider。";
    } else if (code === "NO_TRANSLATIONS") {
      if (rateLimited) {
        title = "翻译服务返回空结果，且疑似被限流";
        summary = "字幕请求没有得到目标语言译文，同时检测到 HTTP 429 或限流计数；这通常不是字幕文件本身的问题。";
        recommendation = "请停止连续重试，等待几分钟后用 concurrency=3、RPS=3 重试，或切换到 API Provider。";
      } else if (String(context.provider || "").toLowerCase() === "google-web") {
        title = "Google 网页翻译没有返回中文";
        summary = "字幕源有效，但 Google 网页端点没有返回可识别的中文译文；这不是 API Key 缺失。";
        recommendation = "检查网络和扩展站点权限，等待后降低并发/RPS重试；如果仍失败，请切换到 API Provider。";
      } else {
        title = "翻译服务没有返回可用译文";
        summary = "字幕请求已完成，但没有检测到目标语言译文。";
        recommendation = "检查 Provider、目标语言和 API Key；也可以切换 Provider 后重试。";
      }
    } else if (code === "NO_VTT_SOURCE") {
      title = "没有找到可用字幕源";
      summary = "页面没有提供可解析的 WebVTT/SRT 字幕，翻译尚未开始。";
      recommendation = "确认视频已经加载，并打开页面的 Captions/Transcript；如果字幕可见但仍失败，请保留诊断详情。";
    } else if (code === "SUBTITLE_ACCESS_DENIED") {
      title = "字幕文件访问被拒绝";
      summary = "播放器记录到了字幕地址，但字幕服务器返回 HTTP 401/403，扩展没有权限读取。";
      recommendation = "确认仍登录 Canvas/Echo360，并在原播放器中重新打开字幕；刷新页面后再试。";
    } else if (code === "SUBTITLE_FILE_NOT_FOUND") {
      title = "字幕文件已失效或不存在";
      summary = "播放器记录到的字幕地址返回 HTTP 404，当前字幕链接可能已过期。";
      recommendation = "刷新视频页面并重新打开 Captions/Transcript，让播放器生成新的字幕地址。";
    } else if (code === "SUBTITLE_NETWORK_ERROR") {
      title = "无法连接字幕服务器";
      summary = "播放器记录到了字幕地址，但浏览器无法完成字幕文件请求。";
      recommendation = "检查网络、Canvas/Echo360 登录状态和扩展站点权限；刷新页面后重试。";
    } else if (code === "SUBTITLE_SERVER_ERROR") {
      title = "字幕服务器暂时不可用";
      summary = `字幕服务器返回 HTTP ${diagnosticHttpStatus || "5xx"}，扩展没有拿到可解析的字幕文件。`;
      recommendation = "等待片刻后刷新视频页面重试；如果持续出现，请保留诊断详情。";
    } else if (code === "SUBTITLE_FETCH_FAILED") {
      title = "字幕文件读取失败";
      summary = "播放器发现了字幕候选地址，但所有读取尝试都没有返回可用字幕。";
      recommendation = "刷新页面并重新打开 Captions/Transcript；然后根据诊断详情检查网络、权限或字幕地址。";
    } else if (code === "EMPTY_VTT") {
      title = "字幕源为空或格式无法解析";
      summary = "找到字幕轨道，但内容为空，或没有解析出带时间轴的字幕。";
      recommendation = "确认当前视频确实有带时间轴的字幕；下载按钮提供的纯文本不能直接用于翻译。";
    } else if (code === "INVALID_SOURCE_VTT") {
      title = "原始字幕格式无效";
      summary = "翻译请求收到的原始字幕没有有效的 WebVTT 头或时间轴，翻译尚未开始。";
      recommendation = "重新从当前视频获取字幕；不要把不带时间轴的 Transcript 纯文本作为 VTT 发送。";
    } else if (code === "VIDEO_NOT_FOUND") {
      title = "没有找到视频播放器";
      summary = "扩展在等待时间内没有找到可挂载字幕的视频元素。";
      recommendation = "等待播放器完全加载后重试；如果当前页面只是 Canvas 外层页面，请在视频 iframe 中操作。";
    } else if (code === "HTTP_429") {
      title = "翻译服务请求过于频繁";
      summary = "上游服务返回 HTTP 429，当前请求过于频繁，已被限流。";
      recommendation = "等待几分钟后重试，并降低 RPS/并发；Google 网页端点建议 3/3。";
    } else if (code === "HTTP_401" || code === "HTTP_403") {
      const httpStatus = diagnosticHttpStatus || code.slice(5);
      if (context.phase === "source") {
        title = "字幕源访问被拒绝";
        summary = `字幕服务器返回 HTTP ${httpStatus}，当前页面没有权限读取这份字幕。`;
        recommendation = "确认仍登录 Canvas/Echo360，并在原播放器中打开字幕；不要把字幕 URL 复制到第三方服务。";
      } else if (context.phase === "backend" || context.backend === true) {
        title = "本地后端访问被拒绝";
        summary = `本地后端返回 HTTP ${httpStatus}，请求没有被接受。`;
        recommendation = "确认 Backend URL 指向本机服务，并检查本地后端是否配置了额外认证。";
      } else if (String(context.provider || "").toLowerCase() === "google-web") {
        title = "Google 网页翻译访问被拒绝";
        summary = `Google 网页端点返回 HTTP ${httpStatus}，请求没有被接受；这不是 API Key 问题。`;
        recommendation = "检查网络和扩展站点权限，等待后降低并发/RPS，或切换到需要 API Key 的 Provider。";
      } else {
        title = "翻译服务认证失败";
        summary = `上游服务返回 HTTP ${httpStatus}，API Key 无效、过期或没有权限。`;
        recommendation = "检查 API Key、Endpoint 和账号权限。";
      }
    } else if (/^HTTP_\d{3}$/.test(code)) {
      const httpStatus = diagnosticHttpStatus || Number(code.slice(5));
      if (context.phase === "backend" || context.backend === true) {
        title = "本地后端处理失败";
        summary = `本地后端返回 HTTP ${httpStatus}，没有完成翻译请求。`;
        recommendation = "检查本地后端 Console/终端日志；确认扩展和后端版本一致后重试。";
      } else if (httpStatus >= 500) {
        title = "翻译服务暂时不可用";
        summary = `上游服务返回 HTTP ${httpStatus}，服务端暂时没有完成请求。`;
        recommendation = "等待片刻后重试；如果持续出现，请检查 Provider 状态或切换服务。";
      } else if (httpStatus === 404) {
        if (context.phase === "backend" || context.phase === "translation" && context.backend === true) {
          title = "本地后端接口不存在";
          summary = "本地后端返回 HTTP 404，可能是后端版本过旧、地址错误，或异步任务已经被清理。";
          recommendation = "确认 Backend URL 指向当前版本的后端；若只是轮询任务失败，请重新开始翻译，不要把它当作同步回退。";
        } else if (context.phase === "source") {
          title = "字幕文件不存在";
          summary = "字幕地址返回 HTTP 404，当前播放器记录的字幕文件可能已过期。";
          recommendation = "刷新视频页面并重新打开字幕；如果播放器本身没有字幕，请确认课程提供了字幕轨道。";
        } else {
          title = "翻译服务地址不存在";
          summary = "翻译 Endpoint 返回 HTTP 404，地址可能已失效或路径配置错误。";
          recommendation = "检查 Endpoint 是否包含正确的 API 路径和协议。";
        }
      } else if (httpStatus === 408) {
        title = "翻译服务请求超时";
        summary = "上游服务返回 HTTP 408，服务器没有及时收到完整请求。";
        recommendation = "稍后重试，并适当降低并发或请求速率。";
      } else if (httpStatus >= 400) {
        title = "翻译服务拒绝了请求";
        summary = `上游服务返回 HTTP ${httpStatus}，请求没有被接受。`;
        recommendation = "检查 Provider、Endpoint、请求权限和目标语言配置。";
      }
    } else if (code === "NETWORK_ERROR") {
      title = "无法连接翻译服务";
      summary = "网络请求失败：浏览器没有完成翻译请求（Safari 常见显示为 Load failed）。";
      recommendation = "检查网络、站点权限和 Endpoint；不要立即连续重试，必要时切换 Provider。";
    } else if (code === "REQUEST_TIMEOUT" || code === "TRANSLATION_TIMEOUT") {
      title = "翻译请求超时";
      summary = "翻译服务在规定时间内没有返回结果。";
      recommendation = "降低并发或增加单请求超时时间，然后重试。";
    } else if (code === "ARGOS_DEPENDENCY_MISSING") {
      title = "缺少 Argos Translate 运行依赖";
      summary = "本地后端可以运行，但当前 Python 环境没有安装可选的 Argos Translate 依赖。";
      recommendation = "在 backend 环境先执行 python -m pip install --upgrade pip，再执行 python -m pip install -r requirements-argos.txt，然后重启本地后端。";
    } else if (code === "ARGOS_MODEL_MISSING") {
      title = "缺少 Argos 翻译模型";
      summary = message || "Argos 已安装，但没有找到英语到目标语言的可用模型。";
      recommendation = "先执行 argospm update 和 argospm install translate-en_zh，再按诊断提示显式安装英语 MiniSBD 断句模型。";
    } else if (code === "BACKEND_DEPENDENCY_MISSING") {
      title = "本地后端缺少依赖";
      summary = "本地 Python 后端启动了，但翻译脚本依赖没有安装。";
      recommendation = "在 backend 环境执行 pip install -r requirements.txt，然后重启本地后端。";
    } else if (code === "JOB_NOT_FOUND" || code === "JOB_ID_MISSING") {
      title = "后台翻译任务不存在";
      summary = code === "JOB_ID_MISSING"
        ? "翻译任务创建成功响应不完整，没有返回任务 ID。"
        : "扩展轮询的任务已过期、被清理，或后台 Service Worker 重启了。";
      recommendation = "重新开始翻译；如果频繁发生，请检查扩展是否被系统挂起。";
    } else if (code === "UNSUPPORTED_PROVIDER" || code === "PROVIDER_CONFIG_ERROR") {
      title = "翻译服务配置无效";
      summary = code === "UNSUPPORTED_PROVIDER"
        ? `当前 Provider 不受支持：${message || "未提供 Provider"}`
        : message && message !== "Unknown translation error"
        ? `Provider/Model 配置有误：${message}`
        : "Provider/Model 配置有误：当前 Provider 或 Model 无法使用。";
      recommendation = "打开扩展设置，选择支持的 Provider，填写所需 Model/API Key。";
    } else if (code === "UNSUPPORTED_TARGET_LANGUAGE") {
      title = "目标语言不受支持";
      summary = message && message !== "Unknown translation error"
        ? message
        : "当前 Provider 不支持所选目标语言。";
      recommendation = "在设置中选择支持的目标语言；DeepL 不支持 YUE/粤语，请改用 OpenAI、DeepSeek 或 Gemini。";
    } else if (code === "INVALID_PROVIDER_RESPONSE" || code === "INVALID_PROVIDER_OUTPUT") {
      title = "翻译服务返回了无法解析的结果";
      summary = "请求可能成功到达上游，但返回格式不符合扩展预期。";
      recommendation = "检查 Endpoint/Model 是否匹配；如果是自定义 Endpoint，请确认它返回兼容的 API 格式。";
    } else if (code === "INVALID_REASONING_EFFORT") {
      title = "Reasoning Effort 配置无效";
      summary = "当前 Model 不支持设置中的 Reasoning Effort。";
      recommendation = "在设置中把 Reasoning Effort 改为该 Model 支持的值，或清空后重试。";
    } else if (code === "EMPTY_TRANSLATABLE_VTT") {
      title = "字幕中没有可翻译文本";
      summary = "VTT 有时间轴，但没有可翻译的字幕文字。";
      recommendation = "确认字幕文件不是空文件，也不是只有时间轴/样式块。";
    } else if (code === "RESOURCE_HOST_NOT_ALLOWED") {
      title = "字幕地址不在允许的站点范围内";
      summary = "扩展拒绝读取这个字幕地址，避免把页面数据发送到未知站点。";
      recommendation = "确认当前字幕 URL 来自 Echo360/Instructure Media；不要手动改成第三方地址。";
    } else if (code === "RESOURCE_FETCH_FAILED" || code === "RESOURCE_NETWORK_ERROR") {
      title = "字幕文件读取失败";
      summary = "找到了字幕候选地址，但浏览器没有成功读取字幕文件。";
      recommendation = "检查视频是否已加载、字幕权限是否允许，并刷新页面后重试；若候选地址返回 404，请重新打开视频。";
    } else if (code === "UNSUPPORTED_PROVIDER_PROTOCOL") {
      title = "翻译服务协议不支持";
      summary = "当前 Provider 的 Endpoint 使用了扩展不支持的协议或地址格式。";
      recommendation = "改用 HTTPS/官方兼容 Endpoint，或在设置中切换到支持的 Provider。";
    } else if (code === "SLOW_BATCH_RETRY") {
      title = "部分字幕响应较慢，已拆分重试";
      summary = "某个字幕批次响应超过阈值，扩展已自动拆分并重试；这不是整次翻译失败。";
      recommendation = "等待当前任务完成；如果经常发生，降低 maxParagraphs/maxChars 或使用更稳定的 API Provider。";
    } else if (code === "INVALID_BACKEND_RESPONSE") {
      title = "本地后端返回格式无效";
      summary = "本地后端有响应，但内容不是扩展约定的 JSON/任务格式；结果没有被当作成功。";
      recommendation = "确认 Backend URL 指向当前版本，并重新启动本地后端；如果使用代理，请关闭会改写响应的中间层。";
    } else if (code === "BACKEND_DISABLED" || code === "BACKEND_URL_MISSING" || code === "BACKEND_REQUEST_ERROR" || code === "BACKEND_NETWORK_ERROR") {
      title = "本地后端请求失败";
      summary = message || "扩展没有得到本地后端的有效响应。";
      recommendation = "检查本地后端是否运行、Backend URL 是否正确；不需要本地后端时请关闭该选项。";
    } else if (code === "BACKEND_URL_INVALID") {
      title = "Backend 地址无效";
      summary = "本地后端地址只允许使用 HTTP/HTTPS 的 localhost、127.0.0.1 或 [::1]。";
      recommendation = "把 Backend URL 改为例如 http://127.0.0.1:8765，然后再次保存。";
    } else if (code === "PROVIDER_API_KEY_MISSING") {
      title = "缺少翻译服务 API Key";
      summary = `Provider ${PROVIDER_LABELS[context.provider] || context.provider || "当前服务"} 没有可用 API Key。`;
      recommendation = "打开扩展设置，填写该 Provider 的 API Key，或切换到 Google Translate 网页端点。";
    } else if (code === "INVALID_REQUEST") {
      title = "翻译请求参数无效";
      summary = message || "发送给翻译服务的参数没有通过校验。";
      recommendation = "检查目标语言、Provider、Endpoint 和并发参数；如果问题持续，请复制诊断详情。";
    } else if (code === "INVALID_JOB_STATE") {
      title = "后台任务状态异常";
      summary = message || "后台返回了扩展无法识别的任务状态，结果没有被当作成功。";
      recommendation = "重新开始翻译；如果重复出现，请确认扩展和本地后端版本一致。";
    } else if (code === "TRANSLATOR_PROCESS_FAILED") {
      title = "本地翻译进程失败";
      summary = "本地翻译脚本退出时报告失败，结果没有被当作成功。";
      recommendation = "查看诊断详情中的脚本输出；检查 Python 环境、依赖、API Key 和 Endpoint。";
    } else if (code === "TRANSLATOR_SUMMARY_MISSING") {
      title = "翻译进程没有提供结果摘要";
      summary = "翻译进程生成了带时间轴字幕，但没有输出可验证的 RESULT_SUMMARY；结果没有被当作成功，也没有写入缓存。";
      recommendation = "确认扩展和本地翻译脚本来自同一版本，并重新构建/重启本地后端。";
    } else if (code === "TRANSLATOR_SUMMARY_INVALID") {
      title = "翻译进程结果摘要损坏";
      summary = "翻译进程输出了 RESULT_SUMMARY，但摘要不是可解析的对象；结果没有被当作成功，也没有写入缓存。";
      recommendation = "确认扩展和本地翻译脚本来自同一版本，并查看本地后端日志中的 RESULT_SUMMARY 原始输出。";
    } else if (code === "INCONSISTENT_TRANSLATION_RESULT") {
      title = "翻译结果与统计不一致";
      summary = "翻译进程生成的字幕内容与成功/失败统计不一致，扩展已拒绝把它当作完整成功。";
      recommendation = "重新翻译并查看诊断详情；如果持续出现，请检查本地翻译脚本版本。";
    } else if (code === "INCOMPLETE_TRANSLATED_VTT") {
      title = "翻译字幕不完整";
      summary = "返回的 WebVTT 时间轴条目与原始字幕数量不一致，扩展没有把不完整结果当作成功。";
      recommendation = "重新翻译；如果使用自定义后端或缓存，请确认它返回了与原始字幕相同数量的 cue。";
    } else if (code === "TRANSLATION_TIMELINE_MISMATCH") {
      title = "翻译字幕时间轴不一致";
      summary = "翻译结果虽然包含字幕条目，但 cue 的开始/结束时间与原始字幕不一致，扩展没有把它挂到视频上。";
      recommendation = "重新翻译；如果使用自定义后端，请确认它只修改字幕文字，不修改原始 WebVTT 时间轴。";
    } else if (code === "TRANSLATOR_INPUT_WRITE_FAILED") {
      title = "翻译输入文件写入失败";
      summary = "本地后端无法准备翻译输入文件，翻译尚未开始。";
      recommendation = "检查临时目录权限、磁盘空间和本地后端运行用户，然后重启后端。";
    } else if (code === "TRANSLATOR_INPUT_MISSING" || code === "TRANSLATOR_INPUT_READ_FAILED") {
      title = code === "TRANSLATOR_INPUT_MISSING" ? "翻译输入文件不存在" : "翻译输入文件读取失败";
      summary = code === "TRANSLATOR_INPUT_MISSING"
        ? "本地翻译进程找不到输入字幕文件，翻译尚未开始。"
        : "本地翻译进程无法读取输入字幕文件，翻译尚未开始。";
      recommendation = "检查字幕文件路径、权限和磁盘状态，然后重新获取字幕并重试。";
    } else if (code === "TRANSLATOR_OUTPUT_WRITE_FAILED") {
      title = "翻译结果文件写入失败";
      summary = "翻译过程可能已经完成，但结果文件无法写入；结果没有被当作成功。";
      recommendation = "检查输出目录权限和磁盘空间，然后重新翻译。";
    } else if (code === "TRANSLATOR_PROGRESS_WRITE_FAILED") {
      title = "翻译进度文件写入失败";
      summary = "无法保存中途进度快照；当前翻译结果不会被误报为已完成。";
      recommendation = "检查临时目录权限和磁盘空间，然后重新翻译。";
    } else if (code === "TRANSLATOR_OUTPUT_READ_FAILED") {
      title = "翻译结果文件读取失败";
      summary = "翻译进程可能已经结束，但本地后端无法读取结果文件。";
      recommendation = "检查临时目录权限、磁盘空间和本地后端日志，然后重试。";
    } else if (code === "TRANSLATOR_SCRIPT_MISSING") {
      title = "本地翻译脚本缺失";
      summary = "后端配置的翻译脚本文件不存在，翻译尚未开始。";
      recommendation = "重新安装/构建项目，或检查 TRANSLATOR_SCRIPT 配置是否指向当前项目中的脚本。";
    } else if (code === "TRANSLATOR_OUTPUT_MISSING" || code === "INVALID_TRANSLATED_VTT") {
      title = "翻译结果文件无效";
      summary = code === "TRANSLATOR_OUTPUT_MISSING"
        ? "翻译进程结束了，但没有生成结果文件。"
        : "翻译进程生成了文件，但文件没有有效的带时间轴字幕。";
      recommendation = "结果不会写入缓存；检查脚本错误输出后重试。";
    } else if (code === "TRANSLATION_CANCELLED") {
      title = "翻译已取消";
      summary = "翻译进程被取消，未将不完整结果宣布为成功。";
      recommendation = "如需继续，请重新开始翻译。";
    } else if (code === "JOB_FAILED_UNCLASSIFIED") {
      title = "后台任务失败，但没有提供错误详情";
      summary = "后台明确把任务标记为失败，却没有返回错误码、HTTP 状态或可诊断原因；结果没有被当作成功。";
      recommendation = "重新开始翻译；如果重复出现，请确认扩展、Service Worker 和后端版本一致，并查看 Console。";
    } else if (code === "CACHE_WRITE_FAILED") {
      title = "翻译完成，但缓存保存失败";
      summary = "字幕已经翻译并显示，但浏览器没有保存本地缓存。";
      recommendation = "本次结果可以继续使用；检查扩展存储权限或可用空间，之后再次翻译即可。";
    } else if (code === "CACHE_READ_FAILED") {
      title = "翻译缓存读取失败";
      summary = "本地缓存无法读取，扩展已跳过缓存并继续尝试翻译。";
      recommendation = "本次翻译仍可继续；检查扩展存储权限或浏览器可用空间。";
    } else if (code === "INVALID_TRANSLATION_CACHE") {
      title = "翻译缓存无效";
      summary = "本地缓存可以读取，但与当前字幕/目标语言不匹配，或不是有效的带时间轴 WebVTT；扩展已忽略它并重新翻译。";
      recommendation = "本次翻译仍可继续；如果每次都出现，请清理扩展缓存并重新加载页面。";
    } else if (code === "CLIPBOARD_COPY_FAILED") {
      title = "错误详情复制失败";
      summary = "浏览器拒绝了剪贴板写入，诊断内容没有复制。";
      recommendation = "手动展开“诊断详情”并复制文本，或允许当前页面使用剪贴板。";
    } else if (code === "INITIALIZATION") {
      title = "扩展初始化失败";
      summary = message || "扩展没有完成当前播放器页面的初始化。";
      recommendation = "刷新视频 iframe 或重新加载扩展后重试。";
    } else if (code === "RUNTIME_MESSAGE_ERROR" || code === "DIRECT_JOB_CREATE_FAILED" || code === "DIRECT_JOB_READ_FAILED") {
      title = "扩展后台通信失败";
      summary = "页面脚本没有得到 Service Worker 的有效响应。";
      recommendation = "重新加载扩展或页面后重试；如果反复出现，请查看 Console 中的后台错误。";
    } else if (code === "UNKNOWN_MESSAGE_TYPE") {
      title = "扩展消息类型不受支持";
      summary = "页面脚本发送了当前版本后台无法识别的消息类型，请确认扩展各文件来自同一版本。";
      recommendation = "重新加载扩展和页面；如果持续出现，请重新构建并完整安装扩展。";
    } else if (code === "RENDER_SYNC_ERROR") {
      title = "字幕显示同步失败";
      summary = "翻译结果存在，但扩展在把字幕保持在当前播放器上时遇到错误。";
      recommendation = "刷新视频页面后重试；也可以切换浏览器字幕轨模式。";
    } else if (code === "RENDER_MOUNT_FAILED") {
      title = "译文已生成，但没有显示在视频上";
      summary = "翻译请求完成了，扩展却没有找到可挂载的播放器字幕层。";
      recommendation = "确认当前视频 iframe 仍在播放页面；可以切换“浏览器字幕轨”模式后重试。";
    } else if (code === "PARTIAL_TRANSLATION") {
      title = "翻译完成，但有字幕失败";
      summary = `${failed ?? 0} 条字幕没有获得译文，已成功的字幕仍然保留。`;
      recommendation = rateLimited
        ? "失败原因包含限流：等待几分钟后降低 RPS/并发，再点击“重新翻译”。"
        : "展开诊断详情查看失败字幕和错误码，再点击“重新翻译”。";
    } else if (code === "RENDER_FAILED") {
      title = "译文已生成，但字幕显示失败";
      summary = "翻译服务已经返回结果，但扩展在更新视频字幕层或 Transcript 面板时发生错误；结果没有被当作已显示。";
      recommendation = "刷新视频 iframe 后重试；如果仍失败，请切换浏览器字幕轨模式，并查看诊断详情中的渲染错误。";
    } else if (code === "TRANSCRIPT_BRIDGE_TIMEOUT" || code === "TRANSCRIPT_BRIDGE_FAILED" || /^TRANSCRIPT_/.test(code)) {
      title = "Transcript 面板同步失败";
      summary = message && message !== "Unknown translation error"
        ? `译文可能已经生成，但 Transcript 面板桥接层没有完成同步：${message}`
        : "译文可能已经生成，但 Transcript 面板桥接层没有完成同步；视频字幕轨不一定受到影响。";
      recommendation = "刷新 Transcript 面板后重试；如果只需要视频字幕，可以继续使用浏览器字幕轨模式。";
    } else if (code === "PROVIDER_REQUEST_FAILED") {
      title = "翻译服务请求失败";
      summary = message && message !== "Unknown translation error"
        ? `翻译服务请求没有完成：${message}`
        : "翻译服务请求没有完成，当前错误没有更具体的 HTTP、网络或超时分类。";
      recommendation = "检查网络、Endpoint、Provider 配置后重试；如果连续出现，请查看失败原因统计或切换 Provider。";
    } else if (code === "TRANSLATION_FAILURE_DETAILS_MISSING") {
      title = "翻译失败，但缺少失败明细";
      summary = "翻译统计报告了失败字幕，却没有提供对应的错误码或失败条目；结果没有被当作可靠成功。";
      recommendation = "重新构建并重启扩展/后端，确保翻译脚本和扩展版本一致；如果仍出现，请查看 Console。";
    } else if (code === "VALIDATION_UNAVAILABLE") {
      title = "扩展结果校验器不可用";
      summary = "当前扩展组件缺少统一的字幕/统计校验器，因此没有把翻译结果或缓存当作成功。";
      recommendation = "完整重新加载扩展和视频页面；如果持续出现，请重新构建并完整安装同一版本的扩展文件。";
    } else if (code === "INTERNAL_ERROR") {
      title = "本地后端内部错误";
      summary = "本地后端处理请求时发生未分类内部错误，结果没有被当作成功。";
      recommendation = "查看本地后端终端日志并重试；如果持续出现，请保留任务 ID 和诊断详情。";
    } else if (code === "TRANSLATION_ERROR") {
      title = "错误原因未分类";
      summary = message && message !== "Unknown translation error"
        ? `系统未能把这次失败进一步分类：${message}`
        : "系统未能把这次失败进一步分类；没有返回可用的 HTTP、网络、任务或 Provider 错误信息。";
      recommendation = "请查看诊断详情和 Console 中的原始错误；如果问题可复现，请保留运行 ID 并切换 Provider 或刷新页面后重试。";
    } else if (code === "ERROR_DETAILS_MISSING") {
      title = "错误详情缺失";
      summary = "界面收到失败通知，但没有收到可展示的错误码、原因或诊断详情。";
      recommendation = "重新执行一次并立即查看 Console；如果持续出现，请重新加载扩展和页面。";
    } else if (code === "TRANSLATION_WARNING") {
      title = "翻译完成，但有警告";
      summary = clean(context.warning || message || "翻译过程中出现可恢复问题", 500);
      recommendation = "结果已显示；如需完整翻译，请按诊断详情中的建议重新翻译。";
    } else if (code === "STALE_JOB") {
      title = "翻译任务已被替换";
      summary = "页面开始了新的翻译任务，旧任务结果被忽略。";
      recommendation = "如果不是你主动重新翻译，请稍候后只启动一次任务。";
    } else if (code === "PREFERENCES_ERROR") {
      title = "字幕设置保存失败";
      summary = message || "浏览器没有保存当前字幕设置。";
      recommendation = "检查扩展存储权限和可用空间，然后重试。";
    } else if (code === "STORAGE_ERROR") {
      title = "扩展设置保存失败";
      summary = message || "浏览器没有保存扩展设置。";
      recommendation = "检查浏览器扩展存储权限和可用空间，然后重试。";
    }

    return { title, summary: clean(summary, 700), recommendation: clean(recommendation, 700), severity };
  }

  function formatNumber(value) {
    return value == null ? "未知" : String(value);
  }

  function formatFailureCodes(failureCodes) {
    const entries = Object.entries(failureCodes || {});
    return entries.length ? entries.map(([code, count]) => `${code} × ${count}`).join("，") : "无";
  }

  function buildDetails(model) {
    const details = [];
    details.push({ label: "阶段", value: PHASE_LABELS[model.phase] || PHASE_LABELS.unknown });
    details.push({ label: "错误码", value: `[${model.code}]` });
    if (model.status != null) {
      details.push({
        label: "HTTP 状态",
        value: `HTTP ${model.status}${model.upstreamStatus != null ? `（外层适配器）` : ""}`,
      });
    }
    if (model.upstreamStatus != null) {
      details.push({ label: "上游 HTTP 状态", value: `HTTP ${model.upstreamStatus}` });
    }
    if (model.boundaryCode) {
      details.push({ label: "边界错误码", value: `[${model.boundaryCode}]（根因已单独显示）` });
    }
    if (model.provider) details.push({ label: "翻译服务", value: PROVIDER_LABELS[model.provider] || model.provider });
    if (model.target) details.push({ label: "目标语言", value: TARGET_LABELS[model.target] || model.target });
    if (model.runId) details.push({ label: "运行 ID", value: model.runId });
    if (model.jobId) details.push({ label: "任务 ID", value: model.jobId });
    if (model.type) details.push({ label: "错误类型", value: model.type });
    if (model.instance) details.push({ label: "错误实例", value: model.instance });
    if (model.upstreamTitle && model.upstreamTitle !== model.title) {
      details.push({ label: "上游错误标题", value: model.upstreamTitle });
    }
    if (model.extraDetails && typeof model.extraDetails === "object") {
      details.push({
        label: "结构化附加信息",
        value: safeStructured(model.extraDetails, 800),
      });
    }

    const metrics = model.metrics || {};
    const hasProgress = [metrics.total, metrics.processed, metrics.translated, metrics.failed]
      .some((value) => value != null);
    if (hasProgress) {
      details.push({
        label: "进度",
        value: `${formatNumber(metrics.processed)} / ${formatNumber(metrics.total)} 已处理；成功 ${formatNumber(metrics.translated)}；失败 ${formatNumber(metrics.failed)}`,
      });
    }
    if (metrics.line) details.push({ label: "最近进度", value: clean(metrics.line, 300) });
    if (model.context?.requestedConcurrency != null || model.context?.requestedRps != null) {
      details.push({
        label: "请求参数",
        value: `concurrency=${formatNumber(model.context.requestedConcurrency)}，RPS=${formatNumber(model.context.requestedRps)}，重试=${formatNumber(model.context.retries)}`,
      });
    }
    if (metrics.effectiveConcurrency != null || metrics.effectiveRps != null) {
      details.push({
        label: "实际参数",
        value: `concurrency=${formatNumber(metrics.effectiveConcurrency)}，RPS=${formatNumber(metrics.effectiveRps)}，重试 ${formatNumber(metrics.retryCount)} 次，限流响应 ${formatNumber(metrics.rateLimitCount)} 次`,
      });
    }
    if (metrics.providerResults != null || metrics.targetResults != null || metrics.unchangedResults != null) {
      details.push({
        label: "服务响应统计",
        value: `providerResults=${formatNumber(metrics.providerResults)}，targetResults=${formatNumber(metrics.targetResults)}，unchanged=${formatNumber(metrics.unchangedResults)}`,
      });
    }
    if (metrics.elapsedMs != null) details.push({ label: "已耗时", value: `${formatNumber(metrics.elapsedMs)} ms` });
    if (metrics.recoveryAttempted || model.context?.recoveryAttempted) {
      const initial = metrics.initialProfile || model.context?.initialProfile || {};
      const recovery = metrics.recoveryProfile || model.context?.recoveryProfile || {};
      details.push({
        label: "自动恢复",
        value: `已尝试：首轮 concurrency=${formatNumber(initial.effectiveConcurrency)}、RPS=${formatNumber(initial.effectiveRps)}；恢复 concurrency=${formatNumber(recovery.concurrency)}、RPS=${formatNumber(recovery.rps)}`,
      });
    }
    if (Object.keys(model.failureCodes).length > 0) {
      details.push({ label: "失败原因统计", value: formatFailureCodes(model.failureCodes) });
    }
    if (model.sourceMeta) {
      const source = model.sourceMeta;
      const stats = source.stats || {};
      const sourceValue = [
        source.hostType || "",
        stats.cueCount != null ? `${stats.cueCount} cues` : "",
        stats.maxEnd != null ? `末时间 ${stats.maxEnd}s` : "",
        source.strongMapped === true ? "ID 已匹配" : source.sourceId ? "启发式选源" : "",
      ].filter(Boolean).join("；");
      if (sourceValue) details.push({ label: "字幕源", value: sourceValue });
      if (source.sourceId) details.push({ label: "字幕源地址", value: source.sourceId });
    }
    if (model.candidateCount != null || model.sourceStrategy) {
      details.push({
        label: "字幕查找策略",
        value: `${model.sourceStrategy || "未知"}${model.candidateCount != null ? `；候选 ${model.candidateCount} 个` : ""}`,
      });
    }
    if (Array.isArray(model.candidateUrls) && model.candidateUrls.length > 0) {
      details.push({ label: "候选字幕地址", value: model.candidateUrls.join("\n") });
    }
    if (model.sourceDiagnostics?.attempts?.length > 0) {
      const attempts = model.sourceDiagnostics.attempts.slice(0, 8).map((item) =>
        `${item.code || "ERROR"}${item.status ? `/HTTP ${item.status}` : ""}: ${clean(item.error || item.outcome || "失败", 300)}`
      );
      details.push({ label: "字幕源尝试结果", value: attempts.join("\n") });
    }
    if (model.failedItems.length > 0) {
      const sample = model.failedItems.slice(0, 6).map((item) => {
        const where = item.cue != null ? `第 ${item.cue} 条` : item.line != null ? `第 ${item.line} 行` : "某条字幕";
        return `${where}: ${item.code}${item.status ? `/HTTP ${item.status}` : ""} ${item.message}`;
      });
      details.push({
        label: `失败字幕（显示前 ${sample.length} 条）`,
        value: sample.join("\n"),
      });
    }
    if (model.warnings.length > 0) {
      details.push({ label: "警告", value: model.warnings.slice(0, 5).join("\n") });
    }
    details.push({ label: "原始错误", value: model.message });
    return details;
  }

  function normalizeError(errorLike, context = {}) {
    const message = readMessage(errorLike);
    const status = readStatus(errorLike);
    const errorObject = errorLike && typeof errorLike === "object" ? { ...errorLike } : {};
    const problem = problemObject(errorLike);
    const existingCandidates = [
      errorObject.code,
      errorObject.error_code,
      errorObject.errorCode,
      problem.code,
      problem.error_code,
      problem.errorCode,
    ];
    const existingCode = existingCandidates.find((candidate) => candidate && !isGenericCode(candidate)) ||
      existingCandidates.find(Boolean) || "";
    // A caller-supplied phase-specific fallback (for example STORAGE_ERROR)
    // may replace a generic placeholder, but must never overwrite a specific
    // code already attached by the failing boundary.
    // First infer from the actual error/problem fields and its HTTP/message
    // evidence. Only use the caller's phase-specific code when that inference
    // is still generic; a STORAGE_ERROR/translation fallback must never hide a
    // concrete HTTP_503, network, timeout, or nested provider diagnosis.
    // Preserve primitive/legacy errors while normalizing. Converting a string
    // or an Error to `{ ...errorLike }` loses its message/name, which used to
    // turn an ordinary unclassified message into ERROR_DETAILS_MISSING and
    // made the displayed code contradict the actual input.
    const inferredCode = readCode(errorLike, status, message);
    const contextCode = normalizeCodeValue(context.code);
    const forcedCode = normalizeCodeValue(context.forceCode);
    const nestedDiagnostics = nestedDiagnosticFields(errorLike);
    const explicitCandidates = [
      ...nestedDiagnostics.codes,
      ...existingCandidates,
    ].map(normalizeCodeValue).filter(Boolean);
    const explicitSpecific = explicitCandidates.find((candidate) => !isGenericCode(candidate) && !isWrapperCode(candidate));
    const inferredSpecific = !isGenericCode(inferredCode) && !isWrapperCode(inferredCode)
      ? inferredCode
      : "";
    const contextSpecific = !isGenericCode(contextCode) && !isWrapperCode(contextCode)
      ? contextCode
      : "";
    const existingSpecific = !isGenericCode(existingCode) && !isWrapperCode(existingCode)
      ? normalizeCodeValue(existingCode)
      : "";
    // A concrete root diagnosis always wins over a boundary wrapper. The
    // wrapper remains available as boundaryCode below for troubleshooting,
    // but must never turn an HTTP_429/provider error into INTERNAL_ERROR.
    const code = explicitSpecific || inferredSpecific || contextSpecific || existingSpecific ||
      (isWrapperCode(forcedCode)
        ? forcedCode
        : !isGenericCode(inferredCode)
          ? inferredCode
          : !isGenericCode(forcedCode)
            ? forcedCode
            : (isGenericCode(existingCode) ? inferredCode : normalizeCodeValue(existingCode)));
    const upstreamStatus = readUpstreamStatus(errorLike, code, status);
    const metrics = sanitizeDetails(getMetrics(errorLike, context));
    const failureCodes = getFailureCodes(errorLike, metrics, context);
    const failedItems = getFailedItems(errorLike, context);
    const provider = String(context.provider || errorLike?.provider || metrics.provider || "").trim().toLowerCase();
    const target = String(context.target || errorLike?.target || "").trim().toUpperCase();
    const phase = normalizePhase(errorLike?.phase || problem.phase || context.phase);
    const warnings = Array.from(new Set([
      ...(Array.isArray(errorLike?.warnings) ? errorLike.warnings : []),
      ...(Array.isArray(problem.warnings) ? problem.warnings : []),
      ...(Array.isArray(context.warnings) ? context.warnings : []),
    ].map((item) => clean(item, 500)).filter(Boolean))).slice(0, 30);
    const sourceContext = {
      ...context,
      error: errorLike,
      provider,
    };
    const descriptor = describe(code, status, message, metrics, failureCodes, sourceContext);
    const upstreamTitle = clean(errorLike?.title || problem.title || "", 240);
    const rawDetails = errorLike?.details || problem.details || null;
    const extraDetails = rawDetails && typeof rawDetails === "object" ? sanitizeDetails(rawDetails) : rawDetails;
    const boundaryCode = normalizeCodeValue(
      context.boundaryCode || errorObject.boundary_code || errorObject.boundaryCode || problem.boundary_code ||
      explicitCandidates.find((candidate) => isWrapperCode(candidate)) ||
      (isWrapperCode(forcedCode) ? forcedCode : "")
    );
    const explicitSeverity = context.severity || errorLike?.severity || problem.severity;
    const severity = explicitSeverity === "warning" ? "warning" : descriptor.severity;
    const retryable = typeof context.retryable === "boolean"
      ? context.retryable
      : typeof errorLike?.retryable === "boolean"
        ? errorLike.retryable
        : !NON_RETRYABLE_ERROR_CODES.has(code) && (
          RETRYABLE_ERROR_CODES.has(code) ||
          (status != null && status >= 500)
        );
    const rawSourceMeta = context.sourceMeta || errorLike?.sourceMeta || null;
    const sourceMeta = rawSourceMeta && typeof rawSourceMeta === "object"
      ? sanitizeDetails(rawSourceMeta)
      : null;
    const rawSourceDiagnostics = context.sourceDiagnostics || errorLike?.sourceDiagnostics || null;
    const sourceDiagnostics = rawSourceDiagnostics && typeof rawSourceDiagnostics === "object"
      ? sanitizeDetails(rawSourceDiagnostics)
      : null;
    const model = {
      code,
      status,
      upstreamStatus,
      message,
      // Use the local descriptor as the stable UI title. RFC 9457's `title`
      // is still preserved below, but allowing arbitrary upstream titles to
      // replace this value made the same HTTP/code error render differently
      // in the popup, content page and backend job view.
      title: clean(context.title || descriptor.title, 240),
      summary: clean(context.summary || errorLike?.summary || problem.summary || descriptor.summary, 700),
      recommendation: clean(context.recommendation || errorLike?.recommendation || problem.recommendation || descriptor.recommendation, 700),
      severity,
      phase,
      provider,
      target,
      runId: clean(context.runId || errorLike?.runId || "", 120),
      jobId: clean(context.jobId || errorLike?.jobId || "", 120),
      metrics,
      failureCodes,
      failedItems,
      warnings,
      sourceMeta,
      sourceStrategy: clean(context.sourceStrategy || errorLike?.sourceStrategy || "", 120),
      candidateCount: positiveInteger(context.candidateCount ?? errorLike?.candidateCount, null),
      candidateUrls: Array.isArray(context.candidateUrls || errorLike?.candidateUrls)
        ? (context.candidateUrls || errorLike.candidateUrls).slice(0, 20).map((item) => redactUrl(item, 500))
        : [],
      sourceDiagnostics,
      retryable,
      upstreamTitle,
      boundaryCode: boundaryCode && boundaryCode !== code ? boundaryCode : "",
      extraDetails,
      type: clean(context.type || errorLike?.type || problem.type || `urn:echo360:translator:error:${code.toLowerCase()}`, 240),
      instance: redactUrl(context.instance || errorLike?.instance || problem.instance || "", 240),
      context: sanitizeDetails(context),
    };
    model.details = buildDetails(model);
    model.copyText = [
      `${model.title} [${model.code}]`,
      model.summary,
      `建议：${model.recommendation}`,
      ...model.details.map((item) => `${item.label}: ${item.value}`),
    ].join("\n");
    return model;
  }

  function friendlyErrorMessage(errorLike, context = {}) {
    const model = normalizeError(errorLike, context);
    return `[${model.code}] ${model.summary} ${model.recommendation}`.trim();
  }

  function getErrorCode(errorLike) {
    const message = readMessage(errorLike);
    return readCode(errorLike, readStatus(errorLike), message);
  }

  function getErrorStatus(errorLike) {
    return readStatus(errorLike);
  }

  function serializeError(errorLike, context = {}) {
    const model = normalizeError(errorLike, context);
    return {
      code: model.code,
      error_code: model.code,
      status: model.status,
      upstream_status: model.upstreamStatus,
      message: model.message,
      detail: model.message,
      title: model.title,
      raw_title: model.upstreamTitle,
      summary: model.summary,
      recommendation: model.recommendation,
      severity: model.severity,
      phase: model.phase,
      provider: model.provider,
      target: model.target,
      runId: model.runId,
      jobId: model.jobId,
      metrics: model.metrics,
      failure_codes: model.failureCodes,
      failed_items: model.failedItems,
      warnings: model.warnings,
      retryable: model.retryable,
      details: model.extraDetails,
      type: model.type,
      instance: model.instance,
      boundary_code: model.boundaryCode || null,
    };
  }

  const api = {
    normalizeError,
    friendlyErrorMessage,
    formatFailureCodes,
    getErrorCode,
    getErrorStatus,
    serializeError,
    redactUrl,
    normalizeCode: normalizeCodeValue,
    isGenericCode,
    isWrapperCode,
    normalizeHttpStatus,
    alignHttpCode,
    formatDebugLog,
    isTranslatableVttLine,
    countTranslatableLines,
    hasCjkInEveryTimedCue,
    hasCjkInSuccessfulTimedCues,
    timedCueTextEntries,
    validateFailureItemLocations,
    validateFailureItemDiagnostics,
    PROVIDER_LABELS,
    TARGET_LABELS,
    SUPPORTED_TARGET_CODES,
    PHASE_LABELS,
  };
  root.Echo360Error = api;
  ns.errorUtils = api;
})();
