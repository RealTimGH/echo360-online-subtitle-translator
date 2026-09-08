(() => {
  const ns = window.Echo360Translator;
  const extensionApi = ns.browserApi;

  function isGenericCode(value) {
    return ns.errorUtils?.isGenericCode?.(value) ||
      ["", "ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR", "FAILURE_DETAIL_MISSING"].includes(String(value ?? "").trim().toUpperCase());
  }

  function normalizeStatus(...values) {
    for (const value of values) {
      const status = Number(value);
      if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
    return null;
  }

  function firstSpecificCode(...values) {
    const normalized = values
      .map((value) => ns.errorUtils?.normalizeCode?.(value) || String(value ?? "").trim().toUpperCase().replace(/^HTTP\s+(\d{3})$/, "HTTP_$1"))
      .filter(Boolean);
    const isWrapper = (value) => ns.errorUtils?.isWrapperCode?.(value) || [
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
    ].includes(String(value || "").toUpperCase());
    return normalized.find((value) => !isGenericCode(value) && !isWrapper(value)) ||
      normalized.find((value) => !isGenericCode(value)) || "";
  }

  function makeClientError(message, code = "TRANSLATION_ERROR", extra = {}) {
    const readable = message && typeof message === "object"
      ? (message.detail || message.message || message.error || message.title || "请求失败")
      : message;
    const error = new Error(String(readable || "请求失败"));
    error.code = code;
    Object.assign(error, extra);
    return error;
  }

  function errorFromResponse(response, fallbackMessage, fallbackCode) {
    const problem = response?.problem || response?.error_detail || response?.data?.problem ||
      response?.data?.error_detail ||
      (response?.error && typeof response.error === "object" ? response.error : null) ||
      (response?.data?.error && typeof response.data.error === "object" ? response.data.error : null) ||
      response?.data || {};
    const rawMessage = problem?.detail || problem?.message || response?.error || fallbackMessage;
    const message = rawMessage && typeof rawMessage === "object"
      ? (rawMessage.detail || rawMessage.message || rawMessage.error || rawMessage.title || fallbackMessage)
      : rawMessage;
    const sharedModel = ns.errorUtils?.normalizeError?.(response, { phase: response?.phase || "backend" });
    const sharedCode = sharedModel?.code || ns.errorUtils?.getErrorCode?.(response);
    const envelopeBoundaryCode = ns.errorUtils?.normalizeCode?.(
      response?.boundary_code || response?.error_detail?.boundary_code
    ) || "";
    // A service-worker/network envelope can preserve the actual provider
    // failure under details.causeCode. The envelope is useful context, but it
    // is not the diagnosis users can act on. Prefer the root cause and keep
    // the wrapper as boundary_code for the diagnostic card.
    const causeCandidates = [
      response?.causeCode,
      response?.cause_code,
      response?.details?.causeCode,
      response?.details?.cause_code,
      response?.error_detail?.causeCode,
      response?.error_detail?.cause_code,
      response?.error_detail?.details?.causeCode,
      response?.error_detail?.details?.cause_code,
      problem?.causeCode,
      problem?.cause_code,
      problem?.details?.causeCode,
      problem?.details?.cause_code,
    ];
    const nestedCandidates = [
      problem?.problem,
      problem?.error_detail,
      problem?.data,
      problem?.error,
    ].flatMap((value) => value && typeof value === "object"
      ? [value.error_code, value.code, value.errorCode]
      : []);
    const status = normalizeStatus(response?.status, response?.status_code, problem?.status, problem?.status_code);
    const selectedCode = firstSpecificCode(
      ...causeCandidates,
      sharedCode,
      ...nestedCandidates,
      problem?.error_code,
      problem?.code,
      problem?.errorCode,
      response?.error_code,
      response?.code,
    ) || (status ? `HTTP_${status}` : fallbackCode);
    // `status` is the outer response status; a nested problem can carry the
    // actionable upstream code (for example HTTP_429 inside an HTTP_500
    // proxy response). Do not overwrite that diagnosis with the envelope
    // status. Only synthesize an HTTP code when no explicit diagnosis exists.
    const code = selectedCode || fallbackCode;
    return makeClientError(message, code, {
      status,
      upstream_status: normalizeStatus(
        response?.upstream_status,
        response?.upstreamStatus,
        response?.causeStatus,
        response?.cause_status,
        response?.details?.causeStatus,
        response?.details?.cause_status,
        response?.error_detail?.causeStatus,
        response?.error_detail?.cause_status,
        response?.error_detail?.details?.causeStatus,
        response?.error_detail?.details?.cause_status,
        problem?.upstream_status,
        problem?.upstreamStatus,
        problem?.causeStatus,
        problem?.cause_status,
        problem?.details?.causeStatus,
        problem?.details?.cause_status,
        sharedModel?.upstreamStatus,
      ),
      title: response?.title || problem?.title || "",
      type: response?.type || problem?.type || "",
      details: response?.details || problem?.details || null,
      metrics: response?.metrics || problem?.metrics || null,
      failure_codes: response?.failure_codes || response?.failureCodes || problem?.failure_codes || null,
      failed_items: response?.failed_items || response?.failedItems || problem?.failed_items || [],
      warnings: [
        ...(Array.isArray(response?.warnings) ? response.warnings : []),
        ...(Array.isArray(problem?.warnings) ? problem.warnings : []),
      ],
      retryable: typeof response?.retryable === "boolean"
        ? response.retryable
        : typeof problem?.retryable === "boolean" ? problem.retryable : undefined,
      phase: response?.phase || problem?.phase || "backend",
      boundaryCode: envelopeBoundaryCode && envelopeBoundaryCode !== selectedCode
        ? envelopeBoundaryCode
        : undefined,
    });
  }

  async function proxyRequest(backendUrl, path, method = "GET", payload = null) {
    const response = await extensionApi.runtime.sendMessage({ type: "proxy-request", backendUrl, path, method, payload });
    if (!response || !response.ok) throw errorFromResponse(response, "请求后端失败", "BACKEND_REQUEST_ERROR");
    return response.data;
  }

  async function proxyTranslateSync(backendUrl, payload) {
    const response = await extensionApi.runtime.sendMessage({ type: "proxy-translate", backendUrl, payload });
    if (!response || !response.ok) throw errorFromResponse(response, "同步翻译请求失败", "BACKEND_REQUEST_ERROR");
    return response.data;
  }

  async function ensureArgosBackend(backendUrl) {
    const response = await extensionApi.runtime.sendMessage({
      type: "ensure-argos-backend",
      backendUrl,
    });
    if (!response || !response.ok) {
      throw errorFromResponse(response, "无法启动本地 Argos 后端", "ARGOS_BACKEND_START_FAILED");
    }
    return response.data || { ready: true };
  }

  function friendlyErrorMessage(raw) {
    if (ns.errorUtils?.friendlyErrorMessage) {
      return ns.errorUtils.friendlyErrorMessage(raw, { phase: "translation" });
    }
    const msg = String(raw || "未知翻译错误").replace(/^Error:\s*/, "");
    return `[TRANSLATION_ERROR] ${msg}`;
  }

  function jobErrorDiagnosis(job, jobId = "") {
    const detail = job?.error_detail && typeof job.error_detail === "object"
      ? job.error_detail
      : {};
    const detailCode = firstSpecificCode(
      detail.error_code,
      detail.code,
      detail.errorCode,
    );
    const causeCandidates = [
      job?.causeCode,
      job?.cause_code,
      job?.details?.causeCode,
      job?.details?.cause_code,
      detail.causeCode,
      detail.cause_code,
      detail.details?.causeCode,
      detail.details?.cause_code,
    ];
    const embeddedCode = String(job?.error || "").match(/^\[([A-Z0-9_]+)\]/i)?.[1] || "";
    const status = normalizeStatus(
      job?.status_code,
      job?.statusCode,
      detail.status,
      detail.status_code,
      detail.statusCode,
    );
    const upstreamStatus = normalizeStatus(
      job?.upstream_status,
      job?.upstreamStatus,
      job?.causeStatus,
      job?.cause_status,
      job?.details?.causeStatus,
      job?.details?.cause_status,
      detail.upstream_status,
      detail.upstreamStatus,
      detail.causeStatus,
      detail.cause_status,
      detail.details?.causeStatus,
      detail.details?.cause_status,
    );
    const code = firstSpecificCode(
      // Keep the concrete nested diagnosis ahead of an outer INTERNAL_ERROR /
      // PROVIDER_REQUEST_FAILED wrapper. A failed job is a layered response;
      // the outer status alone is not the provider diagnosis.
      ...causeCandidates,
      job?.error_code,
      detail.error_code,
      detail.code,
      embeddedCode,
      status ? `HTTP_${status}` : "",
    ) || "JOB_FAILED_UNCLASSIFIED";
    const detailMessage = detail.detail || detail.message || detail.error || "";
    const jobMessage = job?.error || "";
    const message = detailCode && detailCode === code && detailMessage
      ? detailMessage
      : jobMessage || detailMessage || (code === "JOB_FAILED_UNCLASSIFIED"
        ? "后台任务已标记失败，但没有返回错误码或诊断详情"
        : "翻译失败");
    return {
      code,
      status,
      upstreamStatus,
      message: String(message),
      jobId: job?.jobId || job?.id || jobId || "",
    };
  }

  function formatJobError(job) {
    const diagnosis = jobErrorDiagnosis(job);
    return diagnosis.code && !diagnosis.message.includes(`[${diagnosis.code}]`)
      ? `[${diagnosis.code}] ${diagnosis.message}`
      : diagnosis.message;
  }

  function createJobError(job, jobId = "") {
    const diagnosis = jobErrorDiagnosis(job, jobId);
    const error = new Error(
      diagnosis.code && !diagnosis.message.includes(`[${diagnosis.code}]`)
        ? `[${diagnosis.code}] ${diagnosis.message}`
        : diagnosis.message
    );
    const detail = job.error_detail || {};
    error.code = diagnosis.code;
    error.status = diagnosis.status;
    error.upstream_status = diagnosis.upstreamStatus || normalizeStatus(
      job.upstream_status,
      job.upstreamStatus,
      detail.upstream_status,
      detail.upstreamStatus,
      ns.errorUtils?.normalizeError?.(job, { phase: "backend" })?.upstreamStatus,
    );
    error.metrics = job.metrics || job.progress?.metrics || detail.metrics || null;
    error.failed_items = Array.isArray(job.failed_items)
      ? job.failed_items
      : Array.isArray(detail.failed_items) ? detail.failed_items : [];
    error.failure_codes = job.failure_codes || detail.failure_codes || detail.failureCodes || error.metrics?.failureCodes || null;
    error.partial_vtt = job.partial_vtt || "";
    error.provider = job.provider || detail.provider || error.metrics?.provider || "";
    error.target = job.target || detail.target || error.metrics?.target || "";
    error.warnings = [
      ...(Array.isArray(job.warnings) ? job.warnings : []),
      ...(Array.isArray(detail.warnings) ? detail.warnings : []),
    ];
    error.progress = job.progress || null;
    error.jobId = diagnosis.jobId;
    error.error_detail = job.error_detail || null;
    error.title = job.title || detail.title || "";
    error.type = job.type || detail.type || "";
    error.retryable = typeof job.retryable === "boolean" ? job.retryable : detail.retryable;
    error.phase = job.phase || detail.phase || "backend";
    error.details = job.details || detail.details || null;
    error.boundary_code = job.boundary_code || detail.boundary_code || "";
    if (error.failed_items.length > 0) {
      const diagnosticValidator = ns.errorUtils?.validateFailureItemDiagnostics;
      const validatorAvailable = typeof diagnosticValidator === "function";
      const diagnosticResult = validatorAvailable
        ? diagnosticValidator(error.failed_items)
        : { ok: false, reason: "validator_unavailable", index: null };
      if (!diagnosticResult?.ok) {
        error.code = validatorAvailable ? "INCONSISTENT_TRANSLATION_RESULT" : "VALIDATION_UNAVAILABLE";
        error.message = validatorAvailable
          ? "后台任务返回的失败条目中错误码与 HTTP 状态/条目结构不一致"
          : "扩展缺少统一失败诊断校验器，后台结果没有被当作成功";
        error.details = {
          ...(error.details && typeof error.details === "object" ? error.details : {}),
          reason: diagnosticResult?.reason || "invalid_failure_diagnostic",
          itemIndex: diagnosticResult?.index ?? null,
          code: diagnosticResult?.code || null,
          status: diagnosticResult?.status ?? null,
          upstreamStatus: diagnosticResult?.upstreamStatus ?? null,
        };
      }
    }
    return error;
  }

  function normalizeProgress(progress) {
    if (!progress || typeof progress !== "object") return { current: 0, total: 0 };
    return {
      ...progress,
      current: Number.isFinite(Number(progress.current)) ? Number(progress.current) : 0,
      total: Number.isFinite(Number(progress.total)) ? Number(progress.total) : 0,
    };
  }

  const TIMING_LINE_RE = /^\s*((?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/;

  function parseTimestamp(value) {
    const parts = String(value || "").split(":");
    if (parts.length !== 2 && parts.length !== 3) return null;
    const seconds = Number(parts[parts.length - 1]);
    const minutes = Number(parts[parts.length - 2]);
    const hours = parts.length === 3 ? Number(parts[0]) : 0;
    if (![hours, minutes, seconds].every(Number.isFinite) || hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
      return null;
    }
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  }

  function parseTimingLine(line) {
    const match = String(line || "").match(TIMING_LINE_RE);
    if (!match) return null;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    return start != null && end != null && end >= start ? { start, end } : null;
  }

  function countTimedCues(vtt) {
    return String(vtt || "").replace(/\r/g, "").split("\n")
      .filter((line) => parseTimingLine(line)).length;
  }

  function timedCueRanges(vtt) {
    return String(vtt || "").replace(/\r/g, "").split("\n")
      .map((line) => parseTimingLine(line))
      .filter(Boolean)
      .map(({ start, end }) => [start, end]);
  }

  function metricInteger(value) {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      const number = Number(value.trim());
      return Number.isSafeInteger(number) ? number : null;
    }
    return null;
  }

  const CJK_TARGET_CODES = new Set(["ZH", "ZH-HK", "YUE", "CANTONESE"]);
  const SUPPORTED_TARGET_CODES = ns.errorUtils?.SUPPORTED_TARGET_CODES || new Set([
    "ZH", "ZH-HK", "YUE", "CANTONESE", "EN", "JA", "KO", "FR", "DE",
    "ES", "IT", "PT", "RU", "AR", "HI",
  ]);

  function requiresCjk(target) {
    return CJK_TARGET_CODES.has(String(target || "").toUpperCase());
  }

  function deriveFailureCodes(failedItems) {
    return (Array.isArray(failedItems) ? failedItems : []).reduce((counts, item) => {
      const raw = ns.errorUtils?.normalizeCode?.(item?.code) || String(item?.code || "").trim().toUpperCase();
      const code = raw && !isGenericCode(raw) ? raw : "FAILURE_DETAIL_MISSING";
      counts[code] = (counts[code] || 0) + 1;
      return counts;
    }, {});
  }

  function normalizeFailureCodes(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const normalized = {};
    const invalidCodes = [];
    for (const [rawCode, rawCount] of Object.entries(value)) {
      const count = metricInteger(rawCount);
      const code = ns.errorUtils?.normalizeCode?.(rawCode) || String(rawCode || "").trim().toUpperCase();
      if (!code || count == null || count < 0) return { map: null, invalidCodes: [] };
      if (isGenericCode(code)) {
        invalidCodes.push(code || "MISSING");
        continue;
      }
      if (count > 0) normalized[code] = (normalized[code] || 0) + count;
    }
    return { map: normalized, invalidCodes };
  }

  function hasPositiveFailureCode(value) {
    const normalized = normalizeFailureCodes(value);
    return !!normalized?.map && Object.values(normalized.map).some((count) => metricInteger(count) > 0);
  }

  function failureCodeMapsEqual(left, right) {
    const leftKeys = Object.keys(left || {}).sort();
    const rightKeys = Object.keys(right || {}).sort();
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => Number(left[key]) === Number(right[key]));
  }

  function noResultCode({ provider, targetCode, failureCodes, failed, total, providerResults, targetResults }) {
    const isGoogleWeb = String(provider || "").toLowerCase() === "google-web";
    const normalizedFailures = normalizeFailureCodes(failureCodes)?.map || {};
    const failureEntries = Object.entries(normalizedFailures);
    const invalidResponseCount = failureEntries
      .filter(([code]) => ["INVALID_PROVIDER_RESPONSE", "INVALID_PROVIDER_OUTPUT"].includes(String(code).toUpperCase()))
      .reduce((sum, [, count]) => sum + (metricInteger(count) || 0), 0);
    if (invalidResponseCount > 0 && invalidResponseCount === Number(failed || 0)) {
      return isGoogleWeb ? "GOOGLE_WEB_INVALID_RESPONSES" : "INVALID_PROVIDER_RESPONSE";
    }
    if (!isGoogleWeb) return "NO_TRANSLATIONS";
    const noTargetCount = Number(normalizedFailures.NO_TARGET_TRANSLATION || 0);
    const otherFailureCount = Object.entries(normalizedFailures)
      .filter(([code]) => code !== "NO_TARGET_TRANSLATION")
      .reduce((sum, [, count]) => sum + (metricInteger(count) || 0), 0);
    if (requiresCjk(targetCode) && (
      (targetResults === 0 && providerResults > 0) ||
      (noTargetCount > 0 && otherFailureCount === 0)
    )) {
      return "GOOGLE_WEB_NO_TARGET_TRANSLATIONS";
    }
    return "GOOGLE_WEB_ALL_REQUESTS_FAILED";
  }

  function countCueTexts(vtt) {
    const lines = String(vtt || "").replace(/\r/g, "").split("\n");
    let count = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!parseTimingLine(lines[index])) continue;
      let hasText = false;
      for (let next = index + 1; next < lines.length && lines[next].trim() !== ""; next += 1) {
        // A malformed VTT may omit the blank line between cues. Do not count
        // the next timing line itself as caption text in that case.
        if (parseTimingLine(lines[next])) break;
        hasText = true;
      }
      if (hasText) count += 1;
    }
    return count;
  }

  function countTranslatableLines(vtt) {
    if (ns.errorUtils?.countTranslatableLines) return ns.errorUtils.countTranslatableLines(vtt);
    return String(vtt || "").replace(/\r/g, "").split("\n").filter((line) => {
      const text = String(line || "").trim();
      return text && !/^WEBVTT\b/i.test(text) && !/^\d+$/.test(text) &&
        !/^\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}(?:\s+.*)?$/.test(text) &&
        !/^(?:NOTE|STYLE|REGION)\b/i.test(text);
    }).length;
  }

  function hasCjkInEveryTimedCue(vtt, options = {}) {
    if (typeof ns.errorUtils?.hasCjkInEveryTimedCue === "function") {
      return ns.errorUtils.hasCjkInEveryTimedCue(vtt, options);
    }
    // A missing shared validator is a build-integrity problem. Returning a
    // broad `hasCjkText(vtt)` result here would accept one translated line as
    // proof that every cue was translated.
    return false;
  }

  function hasCjkInSuccessfulTimedCues(vtt, failedItems = [], expectedFailedCount = null, options = {}) {
    if (typeof ns.errorUtils?.hasCjkInSuccessfulTimedCues === "function") {
      return ns.errorUtils.hasCjkInSuccessfulTimedCues(vtt, failedItems, expectedFailedCount, options);
    }
    // The shared validator is part of the build contract. Returning a
    // broad text-level or cue-level result here would create a false success.
    return null;
  }

  function validateSourceVtt(vtt, phase = "source") {
    const text = String(vtt || "").trim();
    const actualCueCount = countTimedCues(text);
    const cueTextCount = countCueTexts(text);
    if (!/^WEBVTT(?:\s|$)/i.test(text) || actualCueCount <= 0) {
      throw makeClientError("原始字幕不是有效的带时间轴 WebVTT", "INVALID_SOURCE_VTT", {
        phase,
        details: { cueCount: actualCueCount, cueWithText: cueTextCount },
      });
    }
    if (cueTextCount !== actualCueCount) {
      throw makeClientError("原始字幕包含没有文字的时间轴条目，翻译尚未开始", "INVALID_SOURCE_VTT", {
        phase,
        details: { cueCount: actualCueCount, cueWithText: cueTextCount },
      });
    }
    return vtt;
  }

  function validateTranslationResult(result, phase = "translation", options = {}) {
    const hasSourceVtt = Object.prototype.hasOwnProperty.call(options, "sourceVtt") && options.sourceVtt != null;
    if (hasSourceVtt) {
      // The source is another trust boundary. A custom backend or stale job
      // must not be allowed to make an invalid source look like a result
      // validation failure (or, worse, a cache hit).
      validateSourceVtt(options.sourceVtt, "source");
    }
    const targetCode = String(options.target || result?.target || "ZH").trim().toUpperCase();
    if (!SUPPORTED_TARGET_CODES.has(targetCode)) {
      throw makeClientError(`不支持的目标语言代码：${targetCode || "(empty)"}`, "UNSUPPORTED_TARGET_LANGUAGE", {
        phase: "config",
        details: { field: "target", value: targetCode, allowed: Array.from(SUPPORTED_TARGET_CODES).sort() },
      });
    }
    if (!result || typeof result !== "object") {
      throw makeClientError(
        phase === "backend" ? "本地后端完成任务，但没有返回结果对象" : "翻译任务完成，但没有返回结果对象",
        phase === "backend" ? "INVALID_BACKEND_RESPONSE" : "INVALID_PROVIDER_RESPONSE",
        { phase }
      );
    }
    const vtt = String(result.translated_vtt || "").trim();
    if (!vtt) {
      throw makeClientError("翻译任务完成，但没有返回 translated_vtt", "TRANSLATOR_OUTPUT_MISSING", { phase });
    }
    const actualCueCount = countTimedCues(vtt);
    const cueTextCount = countCueTexts(vtt);
    if (!/^WEBVTT(?:\s|$)/i.test(vtt) || actualCueCount <= 0 || cueTextCount !== actualCueCount) {
      throw makeClientError("翻译任务返回的内容不是有效的带时间轴 WebVTT", "INVALID_TRANSLATED_VTT", {
        phase,
        details: { translatedChars: vtt.length, cueCount: actualCueCount, cueWithText: cueTextCount },
      });
    }
    const metrics = result.metrics && typeof result.metrics === "object" ? result.metrics : {};
    // A cache marker is metadata, not permission to skip validation. Job
    // responses can carry `cache_hit`, but they still cross the normal result
    // boundary and must include complete statistics. Only the explicit local
    // cache lookup path may omit those statistics.
    const isCacheResult = phase === "cache";
    const providerResultsRaw = metrics.providerResults ?? metrics.provider_results;
    const targetResultsRaw = metrics.targetResults ?? metrics.target_results;
    const providerResults = metricInteger(providerResultsRaw);
    const targetResults = metricInteger(targetResultsRaw);
    const total = metricInteger(metrics.total);
    const processed = metricInteger(metrics.processed);
    const translated = metricInteger(metrics.translated);
    const failed = metricInteger(metrics.failed);
    const targetRequiresCjk = requiresCjk(targetCode);
    const expectedSourceTextCount = hasSourceVtt ? countTranslatableLines(options.sourceVtt) : null;
    if (hasSourceVtt) {
      const actualTranslatedTextCount = countTranslatableLines(vtt);
      const lineCountValid = options.bilingual === true
        ? actualTranslatedTextCount >= expectedSourceTextCount
        : actualTranslatedTextCount === expectedSourceTextCount;
      if (!lineCountValid) {
        throw makeClientError(
          `翻译结果包含 ${actualTranslatedTextCount} 行字幕文字，原始字幕包含 ${expectedSourceTextCount} 行`,
          "INCOMPLETE_TRANSLATED_VTT",
          {
            phase,
            details: {
              sourceTextLines: expectedSourceTextCount,
              translatedTextLines: actualTranslatedTextCount,
              bilingual: options.bilingual === true,
            },
          }
        );
      }
    }
    if (!isCacheResult) {
      const requiredMetrics = {
        total: metrics.total,
        processed: metrics.processed,
        translated: metrics.translated,
        failed: metrics.failed,
        providerResults: providerResultsRaw,
      };
      if (targetRequiresCjk) {
        requiredMetrics.targetResults = targetResultsRaw;
      }
      const missingMetrics = Object.entries(requiredMetrics)
        .filter(([key]) => (key === "total" ? total : key === "processed" ? processed :
          key === "translated" ? translated : key === "failed" ? failed :
            key === "providerResults" ? providerResults : targetResults) == null)
        .map(([key]) => key);
      if (missingMetrics.length > 0) {
        throw makeClientError("翻译任务缺少可验证的处理统计，结果没有被当作成功", "INCONSISTENT_TRANSLATION_RESULT", {
          phase,
          details: { missingMetrics },
          metrics,
        });
      }
      const providerName = String(options.provider || result.provider || metrics.provider || "").toLowerCase();
      const targetMismatchCode = targetRequiresCjk && targetResults < providerResults && providerName === "google-web"
        ? "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
        : "INCONSISTENT_TRANSLATION_RESULT";
      if (
        total <= 0 || (expectedSourceTextCount > 0 && total !== expectedSourceTextCount) ||
        processed !== total || translated < 0 || translated > total || failed < 0 || failed > total ||
        translated + failed !== total || providerResults == null || providerResults !== translated ||
        (targetRequiresCjk && targetResults !== providerResults)
      ) {
        throw makeClientError(
          targetMismatchCode === "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
            ? "Google Web 返回的中文条目少于 Provider 成功条目，部分响应没有目标语言译文"
            : "翻译任务的处理统计不一致，结果没有被当作成功",
          targetMismatchCode,
          {
          phase,
          metrics,
          details: targetMismatchCode === "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
            ? { providerResults, targetResults }
            : undefined,
        });
      }
    }
    const failedItems = Array.isArray(result.failed_items)
      ? result.failed_items
      : Array.isArray(result.failedItems)
        ? result.failedItems
        : Array.isArray(metrics.failed_items)
          ? metrics.failed_items
          : Array.isArray(metrics.failedItems) ? metrics.failedItems : [];
    let failureCodes = result.failure_codes || result.failureCodes || metrics.failure_codes || metrics.failureCodes || {};
    const normalizedFailureDetails = normalizeFailureCodes(failureCodes);
    if ((!normalizedFailureDetails || !normalizedFailureDetails.map) && !isCacheResult) {
      throw makeClientError("翻译任务返回的失败原因统计不是对象", "INCONSISTENT_TRANSLATION_RESULT", {
        phase,
        metrics,
        failure_codes: failureCodes,
      });
    }
    if (!isCacheResult && normalizedFailureDetails?.invalidCodes?.length > 0) {
      throw makeClientError("翻译任务的失败原因使用了泛化错误码，无法定位具体失败原因", "TRANSLATION_FAILURE_DETAILS_MISSING", {
        phase,
        metrics,
        failed_items: failedItems,
        failure_codes: failureCodes,
        details: { genericCodes: normalizedFailureDetails.invalidCodes },
      });
    }
    failureCodes = normalizedFailureDetails?.map || {};
    if (!isCacheResult && Object.keys(failureCodes).length === 0 && failedItems.length > 0) {
      failureCodes = deriveFailureCodes(failedItems);
    }
    if (!isCacheResult && failed != null && failed > 0) {
      if (!failedItems.length || failedItems.length !== Math.min(failed, 50) ||
        failedItems.some((item) => !item || typeof item !== "object" ||
          !String(item.code || "").trim() || !String(item.message || item.error || "").trim() ||
          isGenericCode(item.code))) {
        throw makeClientError("翻译任务报告了失败字幕，但没有返回完整的失败明细", "TRANSLATION_FAILURE_DETAILS_MISSING", {
          phase,
          metrics,
          failed_items: failedItems,
          failure_codes: failureCodes,
          details: { expectedFailedItems: Math.min(failed, 50), actualFailedItems: failedItems.length },
        });
      }
      const itemFailureCodes = deriveFailureCodes(failedItems);
      const aggregateFailureCount = Object.values(failureCodes).reduce((sum, count) => sum + metricInteger(count), 0);
      const exactFailureCodeMatch = failed <= 50 && failureCodeMapsEqual(itemFailureCodes, failureCodes);
      const sampledFailureCodesFit = failed > 50 && Object.entries(itemFailureCodes).every(([code, count]) =>
        Number(failureCodes[code] || 0) >= Number(count || 0));
      if (aggregateFailureCount !== failed || (!exactFailureCodeMatch && !sampledFailureCodesFit)) {
        throw makeClientError("翻译任务的失败统计与失败明细不一致", "INCONSISTENT_TRANSLATION_RESULT", {
          phase,
          metrics,
          failed_items: failedItems,
          failure_codes: failureCodes,
        });
      }
    }
    if (!isCacheResult && failed === 0 && (failedItems.length > 0 || hasPositiveFailureCode(failureCodes))) {
      throw makeClientError("翻译任务报告失败数为 0，但返回了失败详情或失败原因统计", "INCONSISTENT_TRANSLATION_RESULT", {
        phase,
        metrics,
        failed_items: failedItems,
        failure_codes: failureCodes,
      });
    }
    if (!isCacheResult && failed > 0) {
      const diagnosticValidator = ns.errorUtils?.validateFailureItemDiagnostics;
      if (typeof diagnosticValidator !== "function") {
        throw makeClientError("扩展缺少统一失败诊断校验器，结果没有被当作成功", "VALIDATION_UNAVAILABLE", {
          phase,
          metrics,
          failed_items: failedItems,
          failure_codes: failureCodes,
        });
      }
      const diagnosticResult = diagnosticValidator(failedItems);
      if (!diagnosticResult?.ok) {
        throw makeClientError("翻译任务的失败条目中错误码与 HTTP 状态不一致", "INCONSISTENT_TRANSLATION_RESULT", {
          phase,
          metrics,
          failed_items: failedItems,
          failure_codes: failureCodes,
          details: {
            reason: diagnosticResult?.reason || "invalid_failure_diagnostic",
            itemIndex: diagnosticResult?.index ?? null,
            code: diagnosticResult?.code || null,
            status: diagnosticResult?.status ?? null,
            upstreamStatus: diagnosticResult?.upstreamStatus ?? null,
          },
        });
      }
      const locationValidator = ns.errorUtils?.validateFailureItemLocations;
      if (typeof locationValidator !== "function") {
        throw makeClientError("扩展缺少统一失败字幕位置校验器，结果没有被当作成功", "VALIDATION_UNAVAILABLE", {
          phase,
          metrics,
          failed_items: failedItems,
        });
      }
      const locationVtt = hasSourceVtt ? options.sourceVtt : vtt;
      const locationResult = locationValidator(locationVtt, failedItems, {
        bilingual: options.bilingual === true,
      });
      if (!locationResult?.ok) {
        throw makeClientError("翻译任务的失败明细没有提供可唯一定位的字幕文字行", "TRANSLATION_FAILURE_DETAILS_MISSING", {
          phase,
          metrics,
          failed_items: failedItems,
          failure_codes: failureCodes,
          details: {
            reason: locationResult?.reason || "invalid_failure_location",
            itemIndex: locationResult?.index ?? null,
            cue: locationResult?.cue ?? null,
            line: locationResult?.line ?? null,
          },
        });
      }
    }
    if (Number.isFinite(total) && total > 0 && Number.isFinite(failed) && failed >= total) {
      throw makeClientError("翻译任务没有成功处理任何字幕", noResultCode({
        provider: options.provider || result.provider || metrics.provider,
        targetCode,
        failureCodes,
        failed,
        total,
        providerResults,
        targetResults,
      }), {
        phase,
        metrics,
        failed_items: failedItems,
        failure_codes: failureCodes,
      });
    }
    if (providerResults != null && Number(providerResults) <= 0) {
      throw makeClientError("翻译任务没有得到 Provider 的有效结果", noResultCode({
        provider: options.provider || result.provider || metrics.provider,
        targetCode,
        failureCodes,
        failed,
        total,
        providerResults,
        targetResults,
      }), { phase, metrics, failure_codes: failureCodes, failed_items: failedItems });
    }
    if (!isCacheResult && targetRequiresCjk &&
      (targetResults == null || Number(targetResults) <= 0)) {
      throw makeClientError("翻译任务没有得到可识别的中文译文", noResultCode({
        provider: options.provider || result.provider || metrics.provider,
        targetCode,
        failureCodes,
        failed,
        total,
        providerResults,
        targetResults,
      }), { phase, metrics, failure_codes: failureCodes, failed_items: failedItems });
    }
    if (!isCacheResult && targetRequiresCjk && targetResults !== providerResults) {
      throw makeClientError("翻译结果的中文条目数与 Provider 成功结果数不一致", "INCONSISTENT_TRANSLATION_RESULT", {
        phase,
        metrics,
        details: { providerResults, targetResults },
        failure_codes: failureCodes,
        failed_items: failedItems,
      });
    }
    if (!isCacheResult && targetRequiresCjk && typeof ns.errorUtils?.hasCjkInSuccessfulTimedCues !== "function") {
      throw makeClientError("扩展缺少统一中文覆盖校验器，结果没有被当作成功", "VALIDATION_UNAVAILABLE", {
        phase,
        metrics,
        failed_items: failedItems,
      });
    }
    if (isCacheResult && targetRequiresCjk && typeof ns.errorUtils?.hasCjkInEveryTimedCue !== "function") {
      throw makeClientError("扩展缺少统一缓存字幕校验器，缓存没有被当作成功", "VALIDATION_UNAVAILABLE", {
        phase,
        metrics,
      });
    }
    const cjkCoverage = targetRequiresCjk
      ? (isCacheResult
        ? hasCjkInEveryTimedCue(vtt, { bilingual: options.bilingual === true })
        : hasCjkInSuccessfulTimedCues(vtt, failedItems, failed, { bilingual: options.bilingual === true }))
      : true;
    if (targetRequiresCjk && (
      cjkCoverage === false ||
      (!isCacheResult && failed > 0 && failed <= 50 && cjkCoverage === null)
    )) {
      throw makeClientError(
        isCacheResult
          ? "本地翻译缓存并非每个字幕文字行都包含可识别的中文字符，已忽略缓存"
          : cjkCoverage === null
            ? "翻译报告了失败字幕，但失败明细没有可用于标记对应字幕文字行的位置"
            : "翻译统计报告了中文结果，但成功字幕文字行实际不包含可识别的中文字符",
        isCacheResult
          ? "INVALID_TRANSLATION_CACHE"
          : cjkCoverage === null
            ? "TRANSLATION_FAILURE_DETAILS_MISSING"
            : "INCONSISTENT_TRANSLATION_RESULT",
        {
          phase,
          metrics,
          failed_items: failedItems,
          details: cjkCoverage === null ? { reason: "failed_items_missing_text_line_mapping" } : undefined,
        }
      );
    }
    if (hasSourceVtt) {
      const expectedRanges = timedCueRanges(options.sourceVtt);
      const actualRanges = timedCueRanges(vtt);
      const expectedCues = expectedRanges.length;
      const actualCues = actualRanges.length;
      if (expectedCues > 0 && actualCues !== expectedCues) {
        throw makeClientError(`翻译结果包含 ${actualCues} 个 cue，原始字幕包含 ${expectedCues} 个 cue`, "INCOMPLETE_TRANSLATED_VTT", {
          phase,
          details: { expectedCues, actualCues },
        });
      }
      if (expectedCues > 0 && actualRanges.some((range, index) => range[0] !== expectedRanges[index][0] || range[1] !== expectedRanges[index][1])) {
        throw makeClientError("翻译结果的 cue 时间轴与原始字幕不一致", "TRANSLATION_TIMELINE_MISMATCH", {
          phase,
          details: {
            expectedCues,
            actualCues,
            firstMismatch: actualRanges.findIndex((range, index) => range[0] !== expectedRanges[index][0] || range[1] !== expectedRanges[index][1]) + 1,
          },
        });
      }
    }
    return result;
  }

  function validateJob(job, phase) {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      throw makeClientError("后台没有返回有效的任务对象（响应不是对象）", "INVALID_BACKEND_RESPONSE", { phase });
    }
    const hasErrorDocument = !!(
      job.error_code || job.errorCode || job.error_detail || job.detail || job.problem ||
      (typeof job.error === "object" && job.error)
    );
    if (typeof job.status !== "string" || !job.status.trim()) {
      if (hasErrorDocument) {
        const error = errorFromResponse(job, "后台返回了错误问题文档", "INVALID_BACKEND_RESPONSE");
        error.phase = phase;
        throw error;
      }
      throw makeClientError("后台任务响应缺少有效的 status 字段", "INVALID_BACKEND_RESPONSE", {
        phase,
        details: { status: job.status ?? null },
      });
    }
    if (!["queued", "running", "completed", "failed"].includes(job.status)) {
      if (hasErrorDocument) {
        const error = errorFromResponse(job, "后台返回了错误问题文档", "INVALID_BACKEND_RESPONSE");
        error.phase = phase;
        throw error;
      }
      throw makeClientError(`后台返回了无法识别的任务状态：${String(job.status || "空")}`, "INVALID_JOB_STATE", {
        phase,
        details: { status: job.status ?? null },
      });
    }
    return job;
  }

  function validateJobCreationResponse(data, phase = "backend") {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw makeClientError("创建翻译任务的响应不是有效对象", "INVALID_BACKEND_RESPONSE", {
        phase,
        details: { responseType: Array.isArray(data) ? "array" : typeof data },
      });
    }

    const rawJobId = data.job_id ?? data.jobId;
    if (typeof rawJobId === "string" && rawJobId.trim()) {
      // Normalize the two historical spellings at this boundary. All callers
      // below use one contract, so a camelCase response cannot silently look
      // like a missing task or be accepted without an ID check.
      return { ...data, job_id: rawJobId.trim() };
    }

    // A response containing an error document must preserve that concrete
    // diagnosis. Only use JOB_ID_MISSING for a structurally valid success
    // envelope that genuinely omitted its required identifier.
    if (data.error_code || data.errorCode || data.error_detail || data.problem || data.error) {
      const error = errorFromResponse(data, "创建翻译任务失败，后端返回了错误文档", "INVALID_BACKEND_RESPONSE");
      error.phase = phase;
      throw error;
    }
    throw makeClientError("创建翻译任务的响应缺少 job_id", "JOB_ID_MISSING", {
      phase,
      details: { responseKeys: Object.keys(data).slice(0, 30) },
    });
  }

  function createDirectTranslateJob(payload) {
    return extensionApi.runtime.sendMessage({ type: "direct-translate-async", payload })
      .then((response) => {
        if (!response || !response.ok) throw errorFromResponse(response, "创建翻译任务失败", "DIRECT_JOB_CREATE_FAILED");
        return validateJobCreationResponse(response.data, "backend");
      })
      .catch((error) => {
        if (error?.code) throw error;
        throw makeClientError(error?.message || String(error), "RUNTIME_MESSAGE_ERROR", { phase: "backend" });
      });
  }

  function readDirectTranslateJob(jobId) {
    return extensionApi.runtime.sendMessage({ type: "direct-translate-job", jobId })
      .then((response) => {
        if (!response || !response.ok) throw errorFromResponse(response, "读取翻译任务失败", "DIRECT_JOB_READ_FAILED");
        return response.data;
      })
      .catch((error) => {
        if (error?.code) throw error;
        throw makeClientError(error?.message || String(error), "RUNTIME_MESSAGE_ERROR", { phase: "backend" });
      });
  }

  async function waitDirectJob(jobId, options = {}) {
    const maxMs = 8 * 60 * 1000;
    const start = Date.now();
    let lastPartialVtt = "";
    while (Date.now() - start < maxMs) {
      if (options.isActive && !options.isActive()) {
        throw makeClientError("stale job", "STALE_JOB");
      }
      let rawJob = await readDirectTranslateJob(jobId);
      // A stale caller can accidentally hand the polling function the create
      // envelope. Treat that envelope as malformed-but-recoverable and read
      // the actual job once; never treat it as a completed translation.
      if (rawJob?.job_id && !rawJob.status) rawJob = await readDirectTranslateJob(rawJob.job_id || jobId);
      const job = validateJob(rawJob, "backend");
      const p = normalizeProgress(job.progress);
      if (job.partial_vtt && job.partial_vtt !== lastPartialVtt) {
        lastPartialVtt = job.partial_vtt;
        options.onPartialVtt?.(job.partial_vtt, p);
      }
      if ((job.status === "queued" || job.status === "running") && p.total > 0) {
        options.onProgress?.(p.current, p.total, p.line || "", p);
      }
      if (job.status === "completed") return validateTranslationResult(job.result, "translation", {
        target: options.target,
        sourceVtt: options.sourceVtt,
        provider: options.provider,
        bilingual: options.bilingual === true,
      });
      if (job.status === "failed") {
        const error = createJobError(job, jobId);
        console.error("[echo360-translator][content] direct job failed", {
          jobId,
          code: error.code,
          status: error.status,
          message: error.message,
          metrics: error.metrics,
          failedItems: error.failed_items.length,
          failureSample: error.failed_items.slice(0, 10),
          failureCodes: error.failure_codes,
        });
        throw error;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    throw makeClientError("翻译任务超时（超过 8 分钟）", "TRANSLATION_TIMEOUT");
  }

  async function waitJob(backendUrl, jobId, options = {}) {
    const maxMs = 8 * 60 * 1000;
    const start = Date.now();
    let lastPartialVtt = "";
    while (Date.now() - start < maxMs) {
      if (options.isActive && !options.isActive()) {
        throw makeClientError("stale job", "STALE_JOB");
      }
      let job;
      try {
        job = validateJob(await proxyRequest(backendUrl, `/translate-async/${jobId}`), "backend");
      } catch (error) {
        // A 404 while polling means this specific job is gone. It is not proof
        // that the async endpoint is unsupported; translation_service.js only
        // falls back to sync when job creation itself returns 404.
        const status = Number(error?.status ?? error?.statusCode);
        if (status === 404 || error?.code === "HTTP_404") {
          error.code = "JOB_NOT_FOUND";
          error.message = "异步翻译任务不存在或已被后端清理";
          error.phase = "backend";
          error.retryable = false;
        }
        throw error;
      }
      const p = normalizeProgress(job.progress);
      if (job.partial_vtt && job.partial_vtt !== lastPartialVtt) {
        lastPartialVtt = job.partial_vtt;
        options.onPartialVtt?.(job.partial_vtt, p);
      }
      if ((job.status === "queued" || job.status === "running") && p.total > 0) {
        options.onProgress?.(p.current, p.total, p.line || "", p);
      }
      if (job.status === "completed") return validateTranslationResult(job.result, "backend", {
        target: options.target,
        sourceVtt: options.sourceVtt,
        provider: options.provider,
        bilingual: options.bilingual === true,
      });
      if (job.status === "failed") {
        const error = createJobError(job, jobId);
        console.error("[echo360-translator][content] backend job failed", {
          jobId,
          code: error.code,
          status: error.status,
          message: error.message,
          metrics: error.metrics,
          failedItems: error.failed_items.length,
          failureSample: error.failed_items.slice(0, 10),
          failureCodes: error.failure_codes,
        });
        throw error;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    throw makeClientError("翻译任务超时（超过 8 分钟）", "TRANSLATION_TIMEOUT");
  }

  ns.backendClient = {
    proxyRequest,
    proxyTranslateSync,
    ensureArgosBackend,
    friendlyErrorMessage,
    waitJob,
    createDirectTranslateJob,
    waitDirectJob,
    validateJobCreationResponse,
    validateSourceVtt,
    validateTranslationResult,
  };
})();
