importScripts("build_config.js", "browser_api.js", "error_utils.js", "direct_translator.js");

const extensionApi = globalThis.Echo360ExtensionApi;
const buildConfig = globalThis.Echo360BuildConfig || {};
const STORAGE_KEY = "echo360TranslatorConfig";
const KEYLESS_PROVIDERS_BG = new Set(["google-web", "argos"]);
const DIRECT_CACHE_KEY = "echo360DirectTranslateCache";
const DIRECT_CACHE_SCHEMA = 3;
const DIRECT_CACHE_MAX_ENTRIES = 10;
const DIRECT_CACHE_MAX_CHARS = 5_000_000;
const DIRECT_JOB_TTL_MS = 60 * 60 * 1000;
const DIRECT_JOB_MAX_COUNT = 100;
const directJobs = new Map();
const INSTRUCTURE_MEDIA_HOST_RE = /(^|\.)instructuremedia\.com$/i;
const SUPPORTED_PROVIDER_CODES_BG = new Set(["google-web", "deepl", "openai", "deepseek", "gemini", "argos"]);
const SUPPORTED_TARGET_CODES_BG = globalThis.Echo360Translator?.errorUtils?.SUPPORTED_TARGET_CODES || new Set([
  "ZH", "ZH-HK", "YUE", "CANTONESE", "EN", "JA", "KO", "FR", "DE",
  "ES", "IT", "PT", "RU", "AR", "HI",
]);

const DIRECT_LOG_TAG = "[echo360-translator][background]";
const ARGOS_BACKEND_LAUNCH_URL = "echo360-subtitle-backend://start";
const ARGOS_BACKEND_START_TIMEOUT_MS = 20000;
let argosBackendStartPromise = null;

function backgroundLog(level, event, details = {}) {
  const logger = console?.[level] || console?.log;
  if (typeof logger !== "function") return;
  logger.call(console, `${DIRECT_LOG_TAG} ${event}`, details);
}

function summarizeJobError(error) {
  const explicitStatus = Number(error?.status ?? error?.statusCode);
  const status = Number.isInteger(explicitStatus) && explicitStatus >= 100 && explicitStatus <= 599
    ? explicitStatus
    : Number(String(error?.message || error || "").match(/HTTP[_\s]+(\d{3})/i)?.[1]) || null;
  const code = error?.code || (status ? `HTTP_${status}` : "JOB_FAILED_UNCLASSIFIED");
  return {
    code: String(code),
    status,
    message: String(error?.message || error || "Unknown translation error").replace(/\s+/g, " ").slice(0, 320),
  };
}

function normalizeBoundaryCode(errorLike, fallbackCode = "BACKEND_REQUEST_ERROR") {
  const utils = globalThis.Echo360Translator?.errorUtils;
  const inferred = utils?.getErrorCode?.(errorLike);
  if (inferred && !utils?.isGenericCode?.(inferred)) return inferred;
  return fallbackCode;
}

function serializeBackgroundError(error, context = {}) {
  const utils = globalThis.Echo360Translator?.errorUtils;
  if (utils?.serializeError) return utils.serializeError(error, context);
  const summary = summarizeJobError(error);
  return { ...summary, phase: context.phase || "unknown" };
}

function backgroundErrorResponse(error, context = {}, fallbackCode = "RUNTIME_MESSAGE_ERROR") {
  const serialized = serializeBackgroundError(error, {
    ...context,
    code: context.code || fallbackCode,
  });
  const code = serialized.error_code || serialized.code || fallbackCode;
  const rawStatus = serialized.status;
  const status = Number.isInteger(Number(rawStatus)) && Number(rawStatus) >= 100 && Number(rawStatus) <= 599
    ? Number(rawStatus)
    : null;
  const message = serialized.detail || serialized.message || "扩展后台操作失败";
  const boundaryCode = serialized.boundary_code || context.forceCode || null;
  const errorDetail = context.forceCode
    ? { ...serialized, boundary_code: context.forceCode }
    : serialized;
  return {
    ok: false,
    error: message,
    code,
    error_code: code,
    status,
    upstream_status: serialized.upstream_status ?? null,
    boundary_code: boundaryCode,
    title: serialized.title || "",
    type: serialized.type || "",
    phase: serialized.phase || context.phase || "unknown",
    error_detail: errorDetail,
  };
}

function timedCueRanges(value) {
  const text = String(value || "").trim();
  const lines = text.replace(/\r/g, "").split("\n");
  const timing = /^\s*((?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/;
  const parseTimestamp = (value) => {
    const parts = String(value || "").split(":");
    if (parts.length !== 2 && parts.length !== 3) return null;
    const seconds = Number(parts[parts.length - 1]);
    const minutes = Number(parts[parts.length - 2]);
    const hours = parts.length === 3 ? Number(parts[0]) : 0;
    if (![hours, minutes, seconds].every(Number.isFinite) || hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
  };
  const isTiming = (line) => {
    const match = String(line || "").match(timing);
    if (!match) return false;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    return start != null && end != null && end >= start ? [start, end] : null;
  };
  const ranges = [];
  const cueHasText = [];
  for (let index = 0; index < lines.length; index += 1) {
    const range = isTiming(lines[index]);
    if (!range) continue;
    ranges.push(range);
    let hasText = false;
    for (let next = index + 1; next < lines.length && lines[next].trim() !== ""; next += 1) {
      if (isTiming(lines[next])) break;
      hasText = true;
      break;
    }
    cueHasText.push(hasText);
  }
  return { ranges, cueHasText };
}

function validTranslatedVtt(value, sourceValue = "") {
  const text = String(value || "").trim();
  if (!/^WEBVTT(?:\s|$)/i.test(text)) return false;
  const parsed = timedCueRanges(text);
  if (parsed.ranges.length === 0 || parsed.cueHasText.some((hasText) => !hasText)) return false;
  if (sourceValue) {
    const source = timedCueRanges(sourceValue);
    if (source.ranges.length !== parsed.ranges.length || source.ranges.some((range, index) =>
      range[0] !== parsed.ranges[index][0] || range[1] !== parsed.ranges[index][1]
    )) return false;
  }
  return true;
}

function countTranslatableLines(value) {
  const shared = globalThis.Echo360Translator?.errorUtils?.countTranslatableLines;
  if (typeof shared === "function") return shared(value);
  const timing = /^\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}(?:\s+.*)?$/;
  return String(value || "").replace(/\r/g, "").split("\n").filter((line) => {
    const text = String(line || "").trim();
    return text && !/^WEBVTT\b/i.test(text) && !/^\d+$/.test(text) &&
      !timing.test(text) && !/^(?:NOTE|STYLE|REGION)\b/i.test(text);
  }).length;
}

function hasCjkInEveryTimedCue(value, options = {}) {
  const shared = globalThis.Echo360Translator?.errorUtils?.hasCjkInEveryTimedCue;
  if (typeof shared === "function") return shared(value, options);
  // The shared validator is part of the build contract. A cue-level fallback
  // would accept one Chinese line and falsely claim that every text line was
  // translated, especially when a cue contains multiple lines.
  return false;
}

function hasCjkInSuccessfulTimedCues(value, failedItems = [], expectedFailedCount = null, options = {}) {
  const shared = globalThis.Echo360Translator?.errorUtils?.hasCjkInSuccessfulTimedCues;
  if (typeof shared === "function") return shared(value, failedItems, expectedFailedCount, options);
  // Fail closed if the shared line-level validator is missing. Returning a
  // broad text-level or cue-level result would create a false success.
  return null;
}

function validateFailureItemLocations(value, failedItems, options = {}) {
  const shared = globalThis.Echo360Translator?.errorUtils?.validateFailureItemLocations;
  if (typeof shared !== "function") return null;
  return shared(value, failedItems, options);
}

function strictMetric(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

const CJK_TARGET_CODES_BG = new Set(["ZH", "ZH-HK", "YUE", "CANTONESE"]);

function deriveFailureCodes(failedItems) {
  return (Array.isArray(failedItems) ? failedItems : []).reduce((counts, item) => {
    const raw = globalThis.Echo360Translator?.errorUtils?.normalizeCode?.(item?.code) || String(item?.code || "").trim().toUpperCase();
    const code = raw && !globalThis.Echo360Translator?.errorUtils?.isGenericCode?.(raw)
      ? raw
      : "FAILURE_DETAIL_MISSING";
    counts[code] = (counts[code] || 0) + 1;
    return counts;
  }, {});
}

function normalizeFailureCodes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = {};
  const invalidCodes = [];
  for (const [rawCode, rawCount] of Object.entries(value)) {
    const count = strictMetric(rawCount);
    const code = globalThis.Echo360Translator?.errorUtils?.normalizeCode?.(rawCode) || String(rawCode || "").trim().toUpperCase();
    if (!code || count == null) return { map: null, invalidCodes: [] };
    if (globalThis.Echo360Translator?.errorUtils?.isGenericCode?.(code) || ["", "ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR"].includes(code)) {
      invalidCodes.push(code || "MISSING");
      continue;
    }
    if (count > 0) normalized[code] = (normalized[code] || 0) + count;
  }
  return { map: normalized, invalidCodes };
}

function failureCodeMapsEqual(left, right) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && Number(left[key]) === Number(right[key]));
}

function noResultCode(payload, failureCodes, failed, total, providerResults, targetResults) {
  const provider = String(payload?.provider || "").toLowerCase();
  if (provider !== "google-web") return "NO_TRANSLATIONS";
  const normalizedFailures = normalizeFailureCodes(failureCodes)?.map || {};
  const invalidResponseCount = Object.entries(normalizedFailures)
    .filter(([code]) => ["INVALID_PROVIDER_RESPONSE", "INVALID_PROVIDER_OUTPUT"].includes(String(code).toUpperCase()))
    .reduce((sum, [, count]) => sum + (strictMetric(count) || 0), 0);
  if (invalidResponseCount > 0 && invalidResponseCount === Number(failed || 0)) {
    return "GOOGLE_WEB_INVALID_RESPONSES";
  }
  const target = String(payload?.target || "ZH").toUpperCase();
  const noTargetCount = Number(normalizedFailures.NO_TARGET_TRANSLATION || 0);
  const otherFailureCount = Object.entries(normalizedFailures)
    .filter(([code]) => code !== "NO_TARGET_TRANSLATION")
    .reduce((sum, [, count]) => sum + (strictMetric(count) || 0), 0);
  if (CJK_TARGET_CODES_BG.has(target) && (
    (targetResults === 0 && providerResults > 0) ||
    (noTargetCount > 0 && otherFailureCount === 0)
  )) return "GOOGLE_WEB_NO_TARGET_TRANSLATIONS";
  return "GOOGLE_WEB_ALL_REQUESTS_FAILED";
}

function validateDirectTranslationResult(result, payload) {
  const target = String(payload?.target || "ZH").trim().toUpperCase();
  if (!SUPPORTED_TARGET_CODES_BG.has(target)) {
    const error = new Error(`不支持的目标语言代码：${target || "(empty)"}`);
    error.code = "UNSUPPORTED_TARGET_LANGUAGE";
    error.phase = "config";
    error.details = { field: "target", value: target, allowed: Array.from(SUPPORTED_TARGET_CODES_BG).sort() };
    throw error;
  }
  const translatedVtt = result?.translated_vtt;
  if (!validTranslatedVtt(translatedVtt)) {
    const error = new Error("翻译器返回的内容不是有效的带时间轴 WebVTT，或包含空 cue");
    error.code = "INVALID_TRANSLATED_VTT";
    error.phase = "translation";
    error.metrics = result?.metrics || null;
    throw error;
  }
  const sourceParsed = timedCueRanges(payload?.vtt_text || "");
  const translatedParsed = timedCueRanges(translatedVtt);
  const sameCueCount = sourceParsed.ranges.length === translatedParsed.ranges.length;
  const sameTimeline = sameCueCount && sourceParsed.ranges.every((range, index) =>
    range[0] === translatedParsed.ranges[index][0] && range[1] === translatedParsed.ranges[index][1]
  );
  if (!sameTimeline) {
    const error = new Error(sameCueCount
      ? "翻译器返回的 WebVTT 与原始字幕时间轴不一致"
      : "翻译器返回的 WebVTT cue 数量与原始字幕不一致");
    error.code = sameCueCount ? "TRANSLATION_TIMELINE_MISMATCH" : "INCOMPLETE_TRANSLATED_VTT";
    error.phase = "translation";
    error.metrics = result?.metrics || null;
    throw error;
  }
  const metrics = result?.metrics && typeof result.metrics === "object" ? result.metrics : {};
  const total = strictMetric(metrics.total);
  const processed = strictMetric(metrics.processed);
  const translated = strictMetric(metrics.translated);
  const failed = strictMetric(metrics.failed);
  const providerResults = strictMetric(metrics.providerResults ?? metrics.provider_results);
  const targetRequiresCjk = CJK_TARGET_CODES_BG.has(target);
  const targetResults = strictMetric(metrics.targetResults ?? metrics.target_results);
  const expectedTextCount = countTranslatableLines(payload?.vtt_text || "");
  const translatedTextCount = countTranslatableLines(translatedVtt);
  const lineCountValid = payload?.bilingual === true
    ? translatedTextCount >= expectedTextCount
    : translatedTextCount === expectedTextCount;
  if (!lineCountValid) {
    const error = new Error(`翻译结果包含 ${translatedTextCount} 行字幕文字，原始字幕包含 ${expectedTextCount} 行`);
    error.code = "INCOMPLETE_TRANSLATED_VTT";
    error.phase = "translation";
    error.metrics = metrics;
    error.details = {
      sourceTextLines: expectedTextCount,
      translatedTextLines: translatedTextCount,
      bilingual: payload?.bilingual === true,
    };
    throw error;
  }
  if ([total, processed, translated, failed, providerResults].some((value) => value == null) ||
    (targetRequiresCjk && targetResults == null) || total <= 0 ||
    (expectedTextCount > 0 && total !== expectedTextCount) ||
    processed !== total ||
    translated + failed !== total || providerResults !== translated || failed > total ||
    (targetRequiresCjk && (targetResults < 0 || targetResults > providerResults || targetResults !== providerResults))) {
    const error = new Error("翻译器返回的处理统计缺失或不一致，结果没有被当作成功");
    error.code = targetRequiresCjk && targetResults < providerResults && String(payload?.provider || "").toLowerCase() === "google-web"
      ? "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
      : "INCONSISTENT_TRANSLATION_RESULT";
    error.phase = "translation";
    error.metrics = metrics;
    error.failed_items = Array.isArray(result?.failed_items) ? result.failed_items : [];
    throw error;
  }
  const failedItems = Array.isArray(result?.failed_items) ? result.failed_items : [];
  let failureCodes = result?.failure_codes || result?.failureCodes || metrics.failure_codes || metrics.failureCodes || {};
  const normalizedFailureDetails = normalizeFailureCodes(failureCodes);
  if (!normalizedFailureDetails?.map) {
    const error = new Error("翻译器返回的失败原因统计不是对象");
    error.code = "INCONSISTENT_TRANSLATION_RESULT";
    error.phase = "translation";
    error.metrics = metrics;
    error.failure_codes = failureCodes;
    throw error;
  }
  if (normalizedFailureDetails.invalidCodes.length > 0) {
    const error = new Error("翻译器返回的失败原因使用了泛化错误码，无法定位具体失败原因");
    error.code = "TRANSLATION_FAILURE_DETAILS_MISSING";
    error.phase = "translation";
    error.metrics = metrics;
    error.failure_codes = failureCodes;
    throw error;
  }
  failureCodes = normalizedFailureDetails.map;
  if (Object.keys(failureCodes).length === 0 && failedItems.length > 0) {
    failureCodes = deriveFailureCodes(failedItems);
  }
  if (failed === 0 && (failedItems.length > 0 || Object.values(failureCodes).some((count) => strictMetric(count) > 0))) {
    const error = new Error("翻译器报告失败数为 0，但返回了失败详情或失败原因统计");
    error.code = "INCONSISTENT_TRANSLATION_RESULT";
    error.phase = "translation";
    error.metrics = metrics;
    error.failed_items = failedItems;
    throw error;
  }
  const itemFailureCodes = deriveFailureCodes(failedItems);
  const aggregateFailureCount = Object.values(failureCodes).reduce((sum, count) => sum + strictMetric(count), 0);
  const sampledCodesFit = Object.entries(itemFailureCodes).every(([code, count]) => Number(failureCodes[code] || 0) >= Number(count || 0));
  const codeDistributionMatches = failed <= 50
    ? failureCodeMapsEqual(itemFailureCodes, failureCodes)
    : sampledCodesFit;
  if (failed > 0 && (failedItems.length !== Math.min(failed, 50) ||
    failedItems.some((item) => !item || typeof item !== "object" ||
      !String(item.code || "").trim() || !String(item.message || item.error || "").trim() ||
      globalThis.Echo360Translator?.errorUtils?.isGenericCode?.(item.code)) ||
    aggregateFailureCount !== failed || !codeDistributionMatches)) {
    const error = new Error("翻译器报告了失败字幕，但失败明细或失败原因统计不完整");
    error.code = "TRANSLATION_FAILURE_DETAILS_MISSING";
    error.phase = "translation";
    error.metrics = metrics;
    error.failed_items = failedItems;
    error.failure_codes = failureCodes;
    throw error;
  }
  if (failed > 0) {
    const diagnosticValidator = globalThis.Echo360Translator?.errorUtils?.validateFailureItemDiagnostics;
    if (typeof diagnosticValidator !== "function") {
      const error = new Error("翻译器缺少统一失败诊断校验器，结果没有被当作成功");
      error.code = "VALIDATION_UNAVAILABLE";
      error.phase = "translation";
      error.metrics = metrics;
      error.failed_items = failedItems;
      error.failure_codes = failureCodes;
      throw error;
    }
    const diagnosticResult = diagnosticValidator(failedItems);
    if (!diagnosticResult?.ok) {
      const error = new Error("翻译器返回的失败条目中错误码与 HTTP 状态不一致");
      error.code = "INCONSISTENT_TRANSLATION_RESULT";
      error.phase = "translation";
      error.metrics = metrics;
      error.failed_items = failedItems;
      error.failure_codes = failureCodes;
      error.details = {
        reason: diagnosticResult?.reason || "invalid_failure_diagnostic",
        itemIndex: diagnosticResult?.index ?? null,
        code: diagnosticResult?.code || null,
        status: diagnosticResult?.status ?? null,
        upstreamStatus: diagnosticResult?.upstreamStatus ?? null,
      };
      throw error;
    }
    const locationResult = validateFailureItemLocations(payload?.vtt_text || translatedVtt, failedItems, {
      bilingual: payload?.bilingual === true,
    });
    if (!locationResult) {
      const error = new Error("翻译器缺少统一失败字幕位置校验器，结果没有被当作成功");
      error.code = "VALIDATION_UNAVAILABLE";
      error.phase = "translation";
      error.metrics = metrics;
      error.failed_items = failedItems;
      throw error;
    }
    if (!locationResult.ok) {
      const error = new Error("翻译器返回的失败明细没有提供可唯一定位的字幕文字行");
      error.code = "TRANSLATION_FAILURE_DETAILS_MISSING";
      error.phase = "translation";
      error.metrics = metrics;
      error.failed_items = failedItems;
      error.failure_codes = failureCodes;
      error.details = {
        reason: locationResult.reason || "invalid_failure_location",
        itemIndex: locationResult.index ?? null,
        cue: locationResult.cue ?? null,
        line: locationResult.line ?? null,
      };
      throw error;
    }
  }
  if (targetRequiresCjk) {
    if (typeof globalThis.Echo360Translator?.errorUtils?.hasCjkInSuccessfulTimedCues !== "function") {
      const error = new Error("翻译器缺少统一中文覆盖校验器，结果没有被当作成功");
      error.code = "VALIDATION_UNAVAILABLE";
      error.phase = "translation";
      error.metrics = metrics;
      error.failed_items = failedItems;
      throw error;
    }
    const cjkCoverage = hasCjkInSuccessfulTimedCues(translatedVtt, failedItems, failed, {
      bilingual: payload?.bilingual === true,
    });
    if (cjkCoverage === false || (failed > 0 && failed <= 50 && cjkCoverage === null)) {
      const error = new Error(cjkCoverage === null
        ? "翻译报告了失败字幕，但失败明细没有可用于标记对应字幕文字行的位置"
        : "翻译统计报告了中文结果，但成功字幕文字行实际不包含可识别的中文字符");
      error.code = cjkCoverage === null
        ? "TRANSLATION_FAILURE_DETAILS_MISSING"
        : "INCONSISTENT_TRANSLATION_RESULT";
      error.phase = "translation";
      error.metrics = metrics;
      error.failed_items = failedItems;
      error.details = cjkCoverage === null ? { reason: "failed_items_missing_text_line_mapping" } : undefined;
      throw error;
    }
  }
  if (failed >= total || providerResults <= 0) {
    const error = new Error("翻译器没有成功处理任何字幕");
    error.code = noResultCode(payload, failureCodes, failed, total, providerResults, targetResults);
    error.phase = "translation";
    error.metrics = metrics;
    error.failed_items = failedItems;
    error.failure_codes = failureCodes;
    throw error;
  }
  return result;
}

function isAllowedTextResourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      INSTRUCTURE_MEDIA_HOST_RE.test(url.hostname);
  } catch (_) {
    return false;
  }
}

function isAllowedBackendUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hostname = String(url.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch (_) {
    return false;
  }
}

function normalizeAutoLaunchBackendUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl || "http://127.0.0.1:8765");
  } catch (_) {
    throw Object.assign(new Error("Argos 自动启动收到的 Backend 地址无效"), {
      code: "BACKEND_URL_INVALID",
      status: 400,
    });
  }
  const hostname = String(url.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw Object.assign(new Error("Argos 自动启动只允许使用本机 HTTP Backend 地址"), {
      code: "BACKEND_URL_INVALID",
      status: 400,
    });
  }
  const port = Number(url.port || 80);
  if (port !== 8765) {
    throw Object.assign(new Error("Argos 自动启动当前只支持默认端口 8765"), {
      code: "ARGOS_BACKEND_PORT_UNSUPPORTED",
      status: 400,
    });
  }
  return `http://${hostname === "::1" ? "[::1]" : hostname}:8765`;
}

async function argosBackendHealth(backendUrl, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${backendUrl}/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startAndWaitForArgosBackend(rawBackendUrl) {
  const backendUrl = normalizeAutoLaunchBackendUrl(rawBackendUrl);
  if (await argosBackendHealth(backendUrl)) {
    return { ready: true, launched: false, backendUrl };
  }

  let launchTab = null;
  try {
    launchTab = await extensionApi.tabs.create({
      url: `${ARGOS_BACKEND_LAUNCH_URL}?port=8765`,
      active: false,
    });
  } catch (error) {
    throw Object.assign(new Error(
      "无法调用 Argos 后端启动协议；请先安装并至少启动一次 Echo360 Subtitle Backend"
    ), {
      code: "ARGOS_BACKEND_LAUNCH_UNAVAILABLE",
      phase: "backend",
      cause: error,
    });
  }

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < ARGOS_BACKEND_START_TIMEOUT_MS) {
      if (await argosBackendHealth(backendUrl, 700)) {
        return { ready: true, launched: true, backendUrl };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } finally {
    if (Number.isInteger(Number(launchTab?.id))) {
      await extensionApi.tabs.remove(Number(launchTab.id)).catch(() => {});
    }
  }
  throw Object.assign(new Error(
    "已请求操作系统启动 Argos 后端，但 20 秒内没有连接成功"
  ), {
    code: "ARGOS_BACKEND_START_TIMEOUT",
    phase: "backend",
  });
}

async function ensureArgosBackend(rawBackendUrl) {
  if (!argosBackendStartPromise) {
    argosBackendStartPromise = startAndWaitForArgosBackend(rawBackendUrl)
      .finally(() => { argosBackendStartPromise = null; });
  }
  return argosBackendStartPromise;
}

async function fetchAllowedTextResource(rawUrl) {
  if (!isAllowedTextResourceUrl(rawUrl)) {
    return backgroundErrorResponse(
      Object.assign(new Error("字幕资源地址不在允许的 Instructure Media 站点范围内"), { code: "RESOURCE_HOST_NOT_ALLOWED" }),
      { phase: "source" },
      "RESOURCE_HOST_NOT_ALLOWED"
    );
  }
  try {
    const resp = await fetch(rawUrl, { credentials: "include" });
    const text = await resp.text();
    if (!resp.ok) {
      return backgroundErrorResponse(
        Object.assign(new Error(`字幕资源请求返回 HTTP ${resp.status}`), {
          code: `HTTP_${resp.status}`,
          status: resp.status,
        }),
        { phase: "source" },
        `HTTP_${resp.status}`
      );
    }
    if (!text.trim()) {
      return backgroundErrorResponse(
        Object.assign(new Error("字幕资源返回空内容"), { code: "EMPTY_VTT", status: resp.status }),
        { phase: "source" },
        "EMPTY_VTT"
      );
    }
    return { ok: true, data: { text, status: resp.status } };
  } catch (err) {
    return backgroundErrorResponse(err, { phase: "source" }, "RESOURCE_NETWORK_ERROR");
  }
}

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildDirectCacheKey(payload) {
  const normalizedText = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();
  const normalizedString = (value, fallback = "") => String(value ?? fallback).trim();
  const normalizedNumber = (value, fallback = null) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const digestInput = {
    cache_schema: DIRECT_CACHE_SCHEMA,
    vtt_text: normalizedText(payload.vtt_text),
    provider: normalizedString(payload.provider, "google-web").toLowerCase(),
    model: normalizedString(payload.model),
    endpoint: normalizedString(payload.endpoint),
    target: normalizedString(payload.target, "ZH").toUpperCase(),
    max_paragraphs: normalizedNumber(payload.max_paragraphs, 6),
    max_chars: normalizedNumber(payload.max_chars, 1200),
    concurrency: normalizedNumber(payload.concurrency, 96),
    rps: normalizedNumber(payload.rps, 0),
    retries: normalizedNumber(payload.retries, 1),
    timeout: normalizedNumber(payload.timeout, null),
    bilingual: !!payload.bilingual,
    reasoning_effort: normalizedString(payload.reasoning_effort),
    deepseek_thinking_mode: normalizedString(payload.deepseek_thinking_mode),
    deepl_formality: normalizedString(payload.deepl_formality),
    fallback_mode: normalizedString(payload.fallback_mode, "immediate").toLowerCase(),
    repair_concurrency: normalizedNumber(payload.repair_concurrency, 1),
    slow_split_threshold: normalizedNumber(payload.slow_split_threshold, 0),
  };
  return sha256Text(JSON.stringify(digestInput));
}

function normalizeDirectRequestPayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw Object.assign(new Error("翻译请求 payload 必须是对象"), {
      code: "INVALID_REQUEST",
      status: 400,
      phase: "config",
      details: { field: "payload", reason: "expected_object" },
    });
  }
  const readString = (field, fallback) => {
    const hasField = rawPayload && Object.prototype.hasOwnProperty.call(rawPayload, field);
    if (!hasField || rawPayload[field] == null) return fallback;
    if (typeof rawPayload[field] !== "string") {
      throw Object.assign(new Error(`${field} 必须是字符串`), {
        code: "INVALID_REQUEST",
        status: 400,
        phase: "config",
        details: { field, reason: "expected_string" },
      });
    }
    const value = rawPayload[field].trim();
    if (!value) {
      throw Object.assign(new Error(`${field} 不能为空`), {
        code: "INVALID_REQUEST",
        status: 400,
        phase: "config",
        details: { field, reason: "empty_string" },
      });
    }
    return value;
  };
  const readOptionalString = (field, fallback = "") => {
    const hasField = Object.prototype.hasOwnProperty.call(rawPayload, field);
    if (!hasField || rawPayload[field] == null) return fallback;
    if (typeof rawPayload[field] !== "string") {
      throw Object.assign(new Error(`${field} 必须是字符串`), {
        code: "INVALID_REQUEST",
        status: 400,
        phase: "config",
        details: { field, reason: "expected_string" },
      });
    }
    return rawPayload[field].trim();
  };
  const readNumber = (field, fallback, { integer = false, min = 0, allowNull = false } = {}) => {
    const hasField = Object.prototype.hasOwnProperty.call(rawPayload, field);
    const raw = hasField ? rawPayload[field] : undefined;
    if (!hasField || raw == null || (allowNull && raw === "")) return fallback;
    if (typeof raw === "boolean" || (typeof raw === "string" && !raw.trim())) {
      throw Object.assign(new Error(`${field} 必须是${integer ? "整数" : "数字"}`), {
        code: "INVALID_REQUEST",
        status: 400,
        phase: "config",
        details: { field, reason: "expected_finite_number", integer, min },
      });
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min) {
      throw Object.assign(new Error(`${field} 必须是大于等于 ${min} 的${integer ? "整数" : "有限数字"}`), {
        code: "INVALID_REQUEST",
        status: 400,
        phase: "config",
        details: { field, reason: "out_of_range", value: raw, integer, min },
      });
    }
    return value;
  };
  const readBoolean = (field, fallback = false) => {
    const hasField = Object.prototype.hasOwnProperty.call(rawPayload, field);
    if (!hasField || rawPayload[field] == null) return fallback;
    if (typeof rawPayload[field] !== "boolean") {
      throw Object.assign(new Error(`${field} 必须是布尔值`), {
        code: "INVALID_REQUEST",
        status: 400,
        phase: "config",
        details: { field, reason: "expected_boolean" },
      });
    }
    return rawPayload[field];
  };
  const provider = readString("provider", "google-web").toLowerCase();
  if (!SUPPORTED_PROVIDER_CODES_BG.has(provider)) {
    throw Object.assign(new Error(`不支持的 Provider：${provider || "(empty)"}`), {
      code: "UNSUPPORTED_PROVIDER",
      status: 400,
      phase: "config",
      provider,
      details: { field: "provider", value: provider, allowed: Array.from(SUPPORTED_PROVIDER_CODES_BG).sort() },
    });
  }
  const target = readString("target", "ZH").toUpperCase();
  if (!SUPPORTED_TARGET_CODES_BG.has(target)) {
    throw Object.assign(new Error(`不支持的目标语言代码：${target}`), {
      code: "UNSUPPORTED_TARGET_LANGUAGE",
      status: 400,
      phase: "config",
      provider,
      target,
      details: { field: "target", value: target, allowed: Array.from(SUPPORTED_TARGET_CODES_BG).sort() },
    });
  }
  if (provider === "deepl" && ["YUE", "CANTONESE"].includes(target)) {
    throw Object.assign(new Error(`DeepL 不支持目标语言 ${target}`), {
      code: "UNSUPPORTED_TARGET_LANGUAGE",
      status: 400,
      phase: "config",
      provider,
      target,
      details: { provider, target },
    });
  }
  if (provider === "argos" && ["YUE", "CANTONESE", "EN"].includes(target)) {
    throw Object.assign(new Error(`Argos（英语源）不支持目标语言 ${target}`), {
      code: "UNSUPPORTED_TARGET_LANGUAGE",
      status: 400,
      phase: "config",
      provider,
      target,
      details: { provider, target, source: "EN" },
    });
  }
  const fallbackMode = readString("fallback_mode", "immediate").toLowerCase();
  if (!["immediate", "deferred", "deferred-fastpath"].includes(fallbackMode)) {
    throw Object.assign(new Error(`fallback_mode 参数无效：${fallbackMode}`), {
      code: "INVALID_REQUEST",
      status: 400,
      phase: "config",
      provider,
      target,
      details: { field: "fallback_mode", value: fallbackMode, allowed: ["immediate", "deferred", "deferred-fastpath"] },
    });
  }
  const normalized = {
    ...rawPayload,
    provider,
    target,
    model: readOptionalString("model"),
    endpoint: readOptionalString("endpoint"),
    reasoning_effort: readOptionalString("reasoning_effort", null),
    deepseek_thinking_mode: readOptionalString("deepseek_thinking_mode", "disabled"),
    deepl_formality: readOptionalString("deepl_formality"),
    fallback_mode: fallbackMode,
    max_paragraphs: readNumber("max_paragraphs", 6, { integer: true, min: 0 }),
    max_chars: readNumber("max_chars", 1200, { integer: true, min: 0 }),
    concurrency: readNumber("concurrency", 96, { integer: true, min: 1 }),
    rps: readNumber("rps", 0, { min: 0 }),
    retries: readNumber("retries", 1, { integer: true, min: 0 }),
    timeout: readNumber("timeout", null, { min: 1, allowNull: true }),
    repair_concurrency: readNumber("repair_concurrency", 1, { integer: true, min: 1 }),
    slow_split_threshold: readNumber("slow_split_threshold", 0, { min: 0 }),
    bilingual: readBoolean("bilingual", false),
    force_refresh: readBoolean("force_refresh", false),
  };
  if (typeof normalized.vtt_text !== "string" || !normalized.vtt_text.trim()) {
    throw Object.assign(new Error("缺少有效的带时间轴字幕 vtt_text"), {
      code: "INVALID_SOURCE_VTT",
      status: 422,
      phase: "source",
      details: { field: "vtt_text", reason: "required_non_empty_string" },
    });
  }
  return normalized;
}

async function getDirectCache() {
  const obj = await extensionApi.storage.local.get(DIRECT_CACHE_KEY);
  const cache = obj[DIRECT_CACHE_KEY];
  return cache && typeof cache === "object" ? cache : {};
}

async function setDirectCache(cache) {
  await extensionApi.storage.local.set({ [DIRECT_CACHE_KEY]: pruneDirectCache(cache) });
}

async function getDirectCacheEntry(cacheKey, sourceVtt = "", target = "", bilingual = false) {
  const cache = await getDirectCache();
  const entry = cache[cacheKey];
  if (!entry) return null;
  const targetCode = String(target || "").toUpperCase();
  const targetRequiresCjk = ["ZH", "ZH-HK", "YUE", "CANTONESE"].includes(targetCode);
  const sourceTextCount = countTranslatableLines(sourceVtt);
  const cachedTextCount = countTranslatableLines(entry.translated_vtt || "");
  if (!entry.translated_vtt || !validTranslatedVtt(entry.translated_vtt, sourceVtt) ||
    (!bilingual && cachedTextCount !== sourceTextCount) ||
    (bilingual && cachedTextCount < sourceTextCount) ||
    (targetRequiresCjk && !hasCjkInEveryTimedCue(entry.translated_vtt, { bilingual }))) {
    throw Object.assign(new Error("本地翻译缓存不是有效的带时间轴 WebVTT，已忽略"), {
      code: "INVALID_TRANSLATION_CACHE",
      phase: "cache",
    });
  }
  entry.used_at = Date.now();
  try {
    await setDirectCache(cache);
    return entry;
  } catch (err) {
    // Cache metadata updates should never block a valid cache hit.
    const warning = {
      code: "CACHE_WRITE_FAILED",
      message: "翻译缓存命中，但更新缓存使用时间失败；本次仍使用缓存",
      details: { operation: "touch_cache_entry", cause: String(err?.message || err || "storage write failed").slice(0, 240) },
    };
    backgroundLog("warn", "direct cache metadata update failed", {
      error: serializeBackgroundError(Object.assign(new Error(warning.message), warning), { phase: "cache" }),
    });
    entry.cache_warning = warning;
    return entry;
  }
}

function pruneDirectCache(cache) {
  const entries = Object.entries(cache)
    .filter(([, entry]) => entry?.translated_vtt)
    .sort((a, b) => Number(b[1].used_at || b[1].created_at || 0) - Number(a[1].used_at || a[1].created_at || 0));
  const next = {};
  let totalChars = 0;
  for (const [key, entry] of entries) {
    const size = Number(entry.size || entry.translated_vtt.length || 0);
    if (Object.keys(next).length >= DIRECT_CACHE_MAX_ENTRIES) continue;
    if (totalChars + size > DIRECT_CACHE_MAX_CHARS) continue;
    next[key] = entry;
    totalChars += size;
  }
  return next;
}

async function setDirectCacheEntry(cacheKey, translatedVtt, sourceVtt = "", target = "", bilingual = false) {
  const targetCode = String(target || "").toUpperCase();
  const targetRequiresCjk = ["ZH", "ZH-HK", "YUE", "CANTONESE"].includes(targetCode);
  if (!translatedVtt || !validTranslatedVtt(translatedVtt, sourceVtt) ||
    ((!bilingual && countTranslatableLines(translatedVtt) !== countTranslatableLines(sourceVtt)) ||
      (bilingual && countTranslatableLines(translatedVtt) < countTranslatableLines(sourceVtt))) ||
    (targetRequiresCjk && !hasCjkInEveryTimedCue(translatedVtt, { bilingual }))) {
    return { ok: false, error: Object.assign(new Error("拒绝缓存无效的 translated_vtt"), { code: "INVALID_TRANSLATED_VTT" }) };
  }
  if (translatedVtt.length > DIRECT_CACHE_MAX_CHARS) {
    return { ok: false, error: Object.assign(new Error("translated_vtt 超出本地缓存大小限制"), { code: "CACHE_WRITE_FAILED" }) };
  }
  let cache;
  try {
    cache = await getDirectCache();
  } catch (err) {
    return {
      ok: false,
      error: Object.assign(new Error("本地翻译缓存读取失败，无法更新缓存"), {
        code: "CACHE_READ_FAILED",
        cause: err,
      }),
    };
  }
  cache[cacheKey] = {
    translated_vtt: translatedVtt,
    created_at: Date.now(),
    used_at: Date.now(),
    size: translatedVtt.length,
  };
  try {
    await setDirectCache(cache);
    return { ok: true };
  } catch (_) {
    try {
      await extensionApi.storage.local.set({
        [DIRECT_CACHE_KEY]: pruneDirectCache({ [cacheKey]: cache[cacheKey] }),
      });
      return { ok: true };
    } catch (err) {
      console.warn("[echo360-translator] direct cache skipped:", err?.message || String(err));
      return { ok: false, error: Object.assign(new Error(err?.message || String(err)), { code: "CACHE_WRITE_FAILED" }) };
    }
  }
}

/**
 * Reads the stored API key for the given provider so the service worker can
 * inject it into translation payloads. Content scripts never need to touch the
 * key directly — they send payloads without api_key and the SW fills it in.
 */
async function resolveApiKey(provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider && !SUPPORTED_PROVIDER_CODES_BG.has(normalizedProvider)) {
    throw Object.assign(new Error(`不支持的 Provider：${normalizedProvider}`), {
      code: "UNSUPPORTED_PROVIDER",
      status: 400,
      phase: "config",
      provider: normalizedProvider,
    });
  }
  if (!normalizedProvider || KEYLESS_PROVIDERS_BG.has(normalizedProvider)) return "";
  let config;
  try {
    const obj = await extensionApi.storage.local.get(STORAGE_KEY);
    config = obj[STORAGE_KEY];
  } catch (error) {
    throw Object.assign(new Error("读取翻译服务 API Key 失败"), {
      code: "STORAGE_ERROR",
      phase: "preferences",
      provider: normalizedProvider,
      details: { cause: String(error?.message || error || "storage read failed").slice(0, 240) },
    });
  }
  if (!config) {
    throw Object.assign(new Error(`Provider ${normalizedProvider} 缺少 API Key`), {
      code: "PROVIDER_API_KEY_MISSING",
      phase: "preferences",
      provider: normalizedProvider,
    });
  }
  const apiKey = config.apiKeys?.[normalizedProvider] || config.apiKey || "";
  if (!String(apiKey).trim()) {
    throw Object.assign(new Error(`Provider ${normalizedProvider} 缺少 API Key`), {
      code: "PROVIDER_API_KEY_MISSING",
      phase: "preferences",
      provider: normalizedProvider,
    });
  }
  return apiKey;
}

function createDirectJob(payload) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    jobId,
    provider: payload.provider || "",
    target: payload.target || "ZH",
    status: "queued",
    progress: { current: 0, total: 0 },
    partial_vtt: "",
    result: null,
    error: "",
    error_code: "",
    status_code: null,
    metrics: null,
    failure_codes: null,
    warnings: [],
    failed_items: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  directJobs.set(jobId, job);
  backgroundLog("info", "direct job created", {
    jobId,
    provider: payload.provider || "",
    target: payload.target || "ZH",
    requestedConcurrency: payload.concurrency ?? null,
    requestedRps: payload.rps ?? null,
    retries: payload.retries ?? null,
  });

  (async () => {
    try {
      job.status = "running";
      job.startedAt = Date.now();
      job.updatedAt = Date.now();
      backgroundLog("info", "direct job started", { jobId });
      const sourceTextCount = countTranslatableLines(payload.vtt_text || "");
      if (!validTranslatedVtt(payload.vtt_text || "") || sourceTextCount <= 0) {
        throw Object.assign(new Error(
          sourceTextCount <= 0
            ? "原始 WebVTT 没有可翻译的字幕文字；翻译尚未开始"
            : "原始字幕不是有效的带时间轴 WebVTT，或包含空 cue；翻译尚未开始"
        ), {
          code: sourceTextCount > 0 ? "INVALID_SOURCE_VTT" : "EMPTY_TRANSLATABLE_VTT",
          phase: "source",
        });
      }
      const cacheKey = await buildDirectCacheKey(payload);
      const preTranslationWarnings = [];
      if (!payload.force_refresh) {
        let cached = null;
        try {
          cached = await getDirectCacheEntry(
            cacheKey,
            payload.vtt_text || "",
            payload.target || "",
            payload.bilingual === true,
          );
        } catch (err) {
          const invalidCache = err?.code === "INVALID_TRANSLATION_CACHE";
          const cacheError = Object.assign(new Error(
            invalidCache
              ? "本地翻译缓存无效，已忽略缓存并继续翻译"
              : "本地翻译缓存读取失败，已忽略缓存并继续翻译"
          ), {
            code: invalidCache ? "INVALID_TRANSLATION_CACHE" : "CACHE_READ_FAILED",
            phase: "cache",
            cause: err,
          });
          preTranslationWarnings.push(`[${cacheError.code}] ${cacheError.message}`);
          job.warnings.push(preTranslationWarnings[preTranslationWarnings.length - 1]);
          backgroundLog("warn", "direct cache read failed; continuing without cache", {
            jobId,
            error: serializeBackgroundError(cacheError, { phase: "cache", jobId }),
          });
        }
        if (cached) {
          const cachedTarget = String(payload.target || "ZH").toUpperCase();
          const cachedRequiresCjk = CJK_TARGET_CODES_BG.has(cachedTarget);
          const cachedMetrics = {
            cacheHit: true,
            cached: true,
            provider: String(payload.provider || "").toLowerCase(),
            target: cachedTarget,
            total: sourceTextCount,
            processed: sourceTextCount,
            translated: sourceTextCount,
            failed: 0,
            provider_results: sourceTextCount,
            providerResults: sourceTextCount,
            target_results: cachedRequiresCjk ? sourceTextCount : null,
            targetResults: cachedRequiresCjk ? sourceTextCount : null,
            failure_codes: {},
            failureCodes: {},
            failed_items: [],
          };
          const cachedWarnings = cached.cache_warning
            ? [`[${cached.cache_warning.code}] ${cached.cache_warning.message}`]
            : [];
          job.result = {
            translated_vtt: cached.translated_vtt,
            warnings: cachedWarnings,
            failed_items: [],
            failure_codes: {},
            failureCodes: {},
            provider: cachedMetrics.provider,
            target: cachedTarget,
            metrics: cachedMetrics,
            cache_hit: true,
          };
          job.metrics = job.result.metrics;
          job.warnings = cachedWarnings;
          job.failure_codes = {};
          job.failed_items = [];
          job.status = "completed";
          job.updatedAt = Date.now();
          backgroundLog("info", "direct job cache hit", { jobId });
          return;
        }
      }
      const result = await Echo360DirectTranslator.translateVtt(payload, {
        onProgress: (current, total, line = "", details = {}) => {
          job.status = "running";
          job.progress = { current, total, line, ...details };
          job.metrics = details;
          job.updatedAt = Date.now();
        },
        onPartialVtt: (partialVtt, meta = {}) => {
          job.partial_vtt = partialVtt;
          job.progress = {
            current: Number(meta.completed || job.progress?.current || 0),
            total: Number(meta.total || job.progress?.total || 0),
            line: job.progress?.line || "",
            partial: !meta.done,
            translated: Number(meta.translated || 0),
            failed: Number(meta.failed || 0),
            failed_items: Array.isArray(meta.failed_items) ? meta.failed_items : (job.progress?.failed_items || []),
            ...(meta.metrics || {}),
          };
          job.metrics = meta.metrics || job.metrics;
          job.updatedAt = Date.now();
        },
      });
      validateDirectTranslationResult(result, payload);
      const combinedWarnings = [...preTranslationWarnings, ...(Array.isArray(result.warnings) ? result.warnings : [])];
      job.result = { ...result, warnings: combinedWarnings, cache_hit: false };
      job.metrics = result.metrics || null;
      job.warnings = combinedWarnings;
      job.failed_items = Array.isArray(result.failed_items) ? result.failed_items : [];
      job.failure_codes = result.failure_codes || result.failureCodes || result.metrics?.failure_codes || result.metrics?.failureCodes || {};
      job.status = "completed";
      job.updatedAt = Date.now();
      if (job.failed_items.length === 0) {
        try {
          const cacheResult = await setDirectCacheEntry(
            cacheKey,
            result.translated_vtt,
            payload.vtt_text || "",
            payload.target || "",
            payload.bilingual === true,
          );
          if (cacheResult?.ok === false) {
            const cacheCode = cacheResult.error?.code || "CACHE_WRITE_FAILED";
            const cacheWarning = `[${cacheCode}] ${cacheResult.error?.message || "本地缓存写入失败"}`;
            job.warnings.push(cacheWarning);
            job.result.warnings = [...(Array.isArray(job.result.warnings) ? job.result.warnings : []), cacheWarning];
            backgroundLog("warn", "direct cache write failed", { jobId, error: serializeBackgroundError(cacheResult.error, { phase: "cache", jobId }) });
          }
        } catch (err) {
          const cacheCode = err?.code || "CACHE_WRITE_FAILED";
          const cacheWarning = `[${cacheCode}] ${err?.message || String(err)}`;
          job.warnings.push(cacheWarning);
          job.result.warnings = [...(Array.isArray(job.result.warnings) ? job.result.warnings : []), cacheWarning];
          backgroundLog("warn", "direct cache write failed", { jobId, error: serializeBackgroundError(err, { phase: "cache", jobId }) });
        }
      } else {
        backgroundLog("warn", "partial result not cached", {
          jobId,
          failedItems: job.failed_items.length,
          metrics: job.metrics,
        });
      }
      backgroundLog(job.failed_items.length > 0 ? "warn" : "info", "direct job completed", {
        jobId,
        failedItems: job.failed_items.length,
        warnings: job.warnings.length,
        metrics: job.metrics,
      });
    } catch (err) {
      job.status = "failed";
      job.metrics = err?.metrics || job.metrics || null;
      const errorDetail = serializeBackgroundError(err, {
        phase: "translation",
        jobId,
        provider: job.provider,
        target: job.target,
        metrics: job.metrics,
        failureCodes: err?.failure_codes || job.metrics?.failureCodes || null,
        failedItems: Array.isArray(err?.failed_items) ? err.failed_items : job.failed_items,
        warnings: Array.isArray(err?.warnings) ? err.warnings : job.warnings,
      });
      job.status_code = Number(errorDetail.status) || null;
      job.error_code = errorDetail.code || (job.status_code ? `HTTP_${job.status_code}` : "JOB_FAILED_UNCLASSIFIED");
      job.error = errorDetail.message ||
        (job.error_code === "JOB_FAILED_UNCLASSIFIED"
          ? "后台任务已失败，但没有返回错误详情"
          : "翻译任务失败");
      job.failure_codes = errorDetail.failure_codes || err?.failure_codes || job.metrics?.failureCodes || null;
      job.failed_items = Array.isArray(err?.failed_items) ? err.failed_items : job.failed_items;
      job.warnings = Array.isArray(err?.warnings) ? err.warnings : job.warnings;
      job.error_detail = {
        ...errorDetail,
        code: job.error_code,
        status: job.status_code,
        provider: job.provider,
        target: job.target,
        phase: errorDetail.phase || err?.phase || "translation",
      };
      if (err?.partial_vtt) job.partial_vtt = err.partial_vtt;
      job.updatedAt = Date.now();
      backgroundLog("error", "direct job failed", {
        jobId,
        ...errorDetail,
        metrics: job.metrics,
        failedItems: job.failed_items.length,
        failureSample: job.failed_items.slice(0, 10),
        failureCodes: job.failure_codes,
      });
    }
  })();

  return jobId;
}

function pruneDirectJobs() {
  const now = Date.now();
  for (const [jobId, job] of directJobs.entries()) {
    if (now - (job.updatedAt || job.createdAt) > DIRECT_JOB_TTL_MS) directJobs.delete(jobId);
  }
  const overflow = directJobs.size - DIRECT_JOB_MAX_COUNT;
  if (overflow > 0) {
    const removable = Array.from(directJobs.entries())
      .filter(([, job]) => job.status === "completed" || job.status === "failed")
      .sort((a, b) => Number(a[1].updatedAt || a[1].createdAt || 0) - Number(b[1].updatedAt || b[1].createdAt || 0));
    for (const [jobId] of removable.slice(0, overflow)) directJobs.delete(jobId);
  }
}

async function proxyBackendRequest(message) {
  if (buildConfig.enableLocalBackend === false) {
    return backgroundErrorResponse(
      Object.assign(new Error("本地后端在当前构建中已禁用"), { code: "BACKEND_DISABLED", status: 503 }),
      { phase: "backend" },
      "BACKEND_DISABLED"
    );
  }

  const { backendUrl } = message;
  if (!backendUrl) {
    return backgroundErrorResponse(
      Object.assign(new Error("未配置本地后端地址"), { code: "BACKEND_URL_MISSING", status: 400 }),
      { phase: "backend" },
      "BACKEND_URL_MISSING"
    );
  }

  try {
    if (!isAllowedBackendUrl(backendUrl)) {
      return backgroundErrorResponse(
        Object.assign(new Error("本地后端地址只允许使用 HTTP/HTTPS 的 localhost、127.0.0.1 或 [::1]"), {
          code: "BACKEND_URL_INVALID",
          status: 400,
        }),
        { phase: "backend" },
        "BACKEND_URL_INVALID"
      );
    }
    const parsedBase = new URL(backendUrl);
    const base = parsedBase.toString().replace(/\/+$/, "");
    const path = message.type === "proxy-translate" ? "/translate" : (message.path || "/health");
    const method = message.type === "proxy-translate" ? "POST" : (message.method || "GET");
    const headers = { "Content-Type": "application/json", ...(message.headers || {}) };
    const init = { method, headers };
    if (message.payload != null) {
      const payload = normalizeDirectRequestPayload(message.payload);
      const api_key = await resolveApiKey(payload.provider);
      init.body = JSON.stringify({ ...payload, api_key });
    }
    const resp = await fetch(`${base}${path}`, init);
    const text = await resp.text();
    if (!resp.ok) {
      let problem = null;
      try { problem = JSON.parse(text); } catch (_) {}
      const problemDetail = problem && typeof problem === "object" ? problem : null;
      const problemStatus = Number(
        problemDetail?.status ?? problemDetail?.status_code ?? problemDetail?.error_detail?.status
      );
      const typedProblemStatus = Number.isInteger(problemStatus) && problemStatus >= 100 && problemStatus <= 599
        ? problemStatus
        : null;
      const problemCode = String(
        problemDetail?.error_code ?? problemDetail?.code ?? problemDetail?.error_detail?.error_code ?? ""
      ).trim().toUpperCase();
      const codeStatus = /^HTTP_\d{3}$/.test(problemCode) ? Number(problemCode.slice(5)) : null;
      const upstreamStatus = typedProblemStatus != null && typedProblemStatus !== resp.status
        ? typedProblemStatus
        : codeStatus != null && codeStatus !== resp.status
          ? codeStatus
          : null;
      const boundary = problemDetail
        ? {
          ...problemDetail,
          status: resp.status,
          ...(upstreamStatus != null ? { upstream_status: upstreamStatus } : {}),
          phase: "backend",
        }
        : { status: resp.status, message: `HTTP ${resp.status}`, code: `HTTP_${resp.status}`, phase: "backend" };
      const serialized = serializeBackgroundError(boundary, { phase: "backend" });
      const boundaryCode = serialized.boundary_code || problemDetail?.boundary_code || null;
      return {
        ok: false,
        error: serialized.detail || serialized.message || `HTTP ${resp.status}`,
        code: serialized.error_code || serialized.code || normalizeBoundaryCode(boundary, `HTTP_${resp.status}`),
        error_code: serialized.error_code || serialized.code || normalizeBoundaryCode(boundary, `HTTP_${resp.status}`),
        status: resp.status,
        upstream_status: serialized.upstream_status || null,
        boundary_code: boundaryCode,
        title: serialized.title || problemDetail?.title || "",
        type: serialized.type || problemDetail?.type || "",
        phase: serialized.phase || "backend",
        error_detail: serialized,
      };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return backgroundErrorResponse(
        Object.assign(new Error("本地后端返回了非 JSON 内容"), {
          code: "INVALID_BACKEND_RESPONSE",
          status: resp.status,
        }),
        { phase: "backend" },
        "INVALID_BACKEND_RESPONSE"
      );
    }
    return { ok: true, data };
  } catch (err) {
    const serialized = serializeBackgroundError(err, { phase: "backend" });
    const boundaryCode = serialized.code === "NETWORK_ERROR"
      ? "BACKEND_NETWORK_ERROR"
      : ["TRANSLATION_ERROR", "PROVIDER_REQUEST_FAILED"].includes(serialized.code)
        ? "BACKEND_REQUEST_ERROR"
        : serialized.code;
    const forceBoundaryCode = ["BACKEND_NETWORK_ERROR", "BACKEND_REQUEST_ERROR"].includes(boundaryCode)
      ? boundaryCode
      : undefined;
    backgroundLog("error", "backend proxy failed", {
      code: boundaryCode,
      causeCode: serialized.code,
      status: serialized.status,
      upstreamStatus: serialized.upstream_status || null,
      message: serialized.message || serialized.detail || "",
    });
    const boundaryError = forceBoundaryCode
      ? Object.assign(new Error(serialized.message || serialized.detail || "本地后端请求失败"), {
        code: boundaryCode,
        status: serialized.status,
        phase: "backend",
        details: {
          causeCode: serialized.code || null,
          causeStatus: serialized.status || null,
          causeUpstreamStatus: serialized.upstream_status || null,
        },
      })
      : err;
    return backgroundErrorResponse(boundaryError, {
      phase: "backend",
      code: boundaryCode,
      ...(forceBoundaryCode ? { forceCode: forceBoundaryCode } : {}),
    }, boundaryCode);
  }
}

extensionApi.runtime.addOnMessageListener(async (message) => {
  if (!message || typeof message !== "object") {
    return backgroundErrorResponse(
      Object.assign(new Error("扩展收到空消息或无效消息对象"), { code: "INVALID_REQUEST", status: 400 }),
      { phase: "backend" },
      "INVALID_REQUEST"
    );
  }

  if (message.type === "fetch-text-resource") {
    return fetchAllowedTextResource(message.url);
  }

  if (message.type === "direct-translate-async") {
    pruneDirectJobs();
    const rawPayload = message.payload || {};
    if (!rawPayload || typeof rawPayload !== "object" || typeof rawPayload.vtt_text !== "string" || !rawPayload.vtt_text.trim()) {
      return {
        ...backgroundErrorResponse(
          Object.assign(new Error("缺少有效的带时间轴字幕 vtt_text"), {
            code: "INVALID_SOURCE_VTT",
            status: 422,
            phase: "source",
          }),
          { phase: "source" },
          "INVALID_SOURCE_VTT"
        ),
      };
    }
    try {
      // Normalize and validate the request before cache lookup. A cached VTT
      // must never turn an unsupported provider/target into a false success.
      const payload = normalizeDirectRequestPayload(rawPayload);
      const api_key = await resolveApiKey(payload.provider);
      const jobId = createDirectJob({ ...payload, api_key });
      return { ok: true, data: { job_id: jobId } };
    } catch (error) {
      return backgroundErrorResponse(error, {
        phase: error?.phase || "preferences",
        provider: rawPayload.provider || "",
        target: rawPayload.target || "ZH",
      }, "DIRECT_JOB_CREATE_FAILED");
    }
  }

  if (message.type === "direct-translate-job") {
    if (!message.jobId) {
      return backgroundErrorResponse(
        Object.assign(new Error("缺少 jobId"), { code: "INVALID_REQUEST", status: 400 }),
        { phase: "backend" },
        "INVALID_REQUEST"
      );
    }
    const job = directJobs.get(message.jobId);
    if (!job) {
      return backgroundErrorResponse(
        Object.assign(new Error("扩展后台翻译任务不存在或已被清理"), { code: "JOB_NOT_FOUND", status: 404 }),
        { phase: "backend", jobId: message.jobId },
        "JOB_NOT_FOUND"
      );
    }
    return { ok: true, data: job };
  }

  if (message.type === "OPEN_OPTIONS_PAGE") {
    try {
      const result = chrome.runtime.openOptionsPage();
      if (result && typeof result.then === "function") {
        return result
          .then(() => ({ ok: true, data: null }))
          .catch((error) => backgroundErrorResponse(error, { phase: "preferences" }, "RUNTIME_MESSAGE_ERROR"));
      }
      return { ok: true, data: null };
    } catch (error) {
      return backgroundErrorResponse(error, { phase: "preferences" }, "RUNTIME_MESSAGE_ERROR");
    }
  }

  if (message.type === "ensure-argos-backend") {
    if (buildConfig.enableLocalBackend === false) {
      return backgroundErrorResponse(
        Object.assign(new Error("当前构建未启用本地 Argos 后端"), { code: "BACKEND_DISABLED", status: 503 }),
        { phase: "backend" },
        "BACKEND_DISABLED"
      );
    }
    try {
      return { ok: true, data: await ensureArgosBackend(message.backendUrl) };
    } catch (error) {
      return backgroundErrorResponse(error, { phase: "backend" }, "ARGOS_BACKEND_START_FAILED");
    }
  }

  if (message.type !== "proxy-translate" && message.type !== "proxy-request") {
    return backgroundErrorResponse(
      Object.assign(new Error(`未知的扩展消息类型：${String(message.type || "(empty)")}`), {
        code: "UNKNOWN_MESSAGE_TYPE",
        status: 400,
      }),
      { phase: "backend" },
      "UNKNOWN_MESSAGE_TYPE"
    );
  }

  return proxyBackendRequest(message);
});
