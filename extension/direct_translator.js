globalThis.Echo360DirectTranslator = (() => {
  // `direct_translator.js` is imported by the service worker immediately
  // after `error_utils.js`, but keep the dependency explicit and safe when
  // the module is loaded in isolation (tests, diagnostics, or a future
  // build-target change). Without this binding, every error path that tries
  // to consult the shared error vocabulary throws `ReferenceError: ns is not
  // defined`, hiding the provider failure it was meant to report.
  const ns = globalThis.Echo360Translator || {};
  const AI_LINE_SEPARATOR = "\n<<<VTT_TRANSLATOR_LINE_BREAK_8F3B>>>\n";
  const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  const CJK_TARGET_CODES = new Set(["ZH", "ZH-HK", "YUE", "CANTONESE"]);
  const SUPPORTED_TARGET_CODES = new Set(["ZH", "ZH-HK", "YUE", "CANTONESE", "EN", "JA", "KO", "FR", "DE", "ES", "IT", "PT", "RU", "AR", "HI"]);
  // Run Google Web at half of the former 96-worker cap, with no default
  // request pacing (rps=0). `maxParagraphs=1` is still applied
  // below so each cue can produce an independent partial update; it is a
  // batching/display choice, not a request-rate limit.
  const GOOGLE_WEB_CONCURRENCY_CAP = 48;
  const GOOGLE_WEB_DEFAULT_RPS = 0;
  // 0 means unlimited, matching 1.4.2. Explicit positive rps values are
  // still honored when a caller deliberately supplies one.
  const GOOGLE_WEB_MAX_RPS = 0;
  const GOOGLE_WEB_MAX_RETRIES = 2;
  const GOOGLE_WEB_RETRY_BASE_MS = 2000;
  const GOOGLE_WEB_RETRY_MAX_MS = 30000;
  const GOOGLE_WEB_RECOVERY_CONCURRENCY = 3;
  const GOOGLE_WEB_RECOVERY_RPS = 3;
  const GOOGLE_WEB_429_CIRCUIT_THRESHOLD = 5;
  const GOOGLE_WEB_429_CIRCUIT_WINDOW_MS = 10000;
  const DIRECT_LOG_TAG = "[echo360-translator][direct]";
  const PROVIDER_ADAPTERS = {
    openai: {
      id: "openai",
      protocol: "openai-responses",
      defaultModel: "gpt-5-nano",
      defaultEndpoint: "https://api.openai.com/v1/responses",
      supportsRecursiveFallback: true,
      authHeaders(apiKey) {
        return { "Authorization": `Bearer ${apiKey}` };
      },
    },
    deepseek: {
      id: "deepseek",
      protocol: "chat-completions",
      defaultModel: "deepseek-v4-flash",
      defaultEndpoint: "https://api.deepseek.com/chat/completions",
      supportsRecursiveFallback: true,
      authHeaders(apiKey) {
        return { "Authorization": `Bearer ${apiKey}` };
      },
      buildExtraBody(cfg) {
        const mode = String(cfg.deepseek_thinking_mode || cfg.deepseekThinkingMode || "disabled").toLowerCase();
        if (mode === "disabled") return { thinking: { type: "disabled" } };
        if (mode === "enabled" || mode === "with-thinking") return { thinking: { type: "enabled" } };
        return {};
      },
    },
    gemini: {
      id: "gemini",
      protocol: "gemini-generate-content",
      defaultModel: "gemini-3.1-flash-lite",
      defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
      supportsRecursiveFallback: true,
      authHeaders(apiKey) {
        return { "x-goog-api-key": apiKey };
      },
    },
    deepl: {
      id: "deepl",
      protocol: "deepl-translate",
      defaultModel: "",
      defaultEndpoint: "https://api-free.deepl.com/v2/translate",
      authHeaders(apiKey) {
        return { "Authorization": `DeepL-Auth-Key ${apiKey}` };
      },
    },
    "google-web": {
      id: "google-web",
      protocol: "google-web",
      defaultModel: "",
      defaultEndpoint: "https://translate.googleapis.com/translate_a/single",
      keyless: true,
      supportsRecursiveFallback: true,
      // Keep the 1.4.2 provider profile for users whose stored config still
      // contains the old generic defaults.
      concurrencyCap: GOOGLE_WEB_CONCURRENCY_CAP,
      defaultRps: GOOGLE_WEB_DEFAULT_RPS,
      authHeaders() {
        return {};
      },
    },
  };
  const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

  function makeTranslationError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  function isTimecode(line) {
    return /^\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}/.test(line);
  }

  function shouldTranslate(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return false;
    // This predicate is used only after the VTT state machine has entered a
    // timed cue. Numeric cue identifiers are outside the cue and are filtered
    // by that state machine; numeric caption text is valid subtitle content.
    if (/^WEBVTT/i.test(trimmed) || isTimecode(trimmed)) return false;
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) return false;
    return true;
  }

  function splitVoiceTag(line) {
    const match = String(line || "").match(/^(\s*<v\b[^>]*>)(.*?)(<\/v>\s*)?$/);
    if (!match) return ["", String(line || "").trim(), ""];
    return [match[1] || "", (match[2] || "").trim(), match[3] || ""];
  }

  function formatTargetLanguage(target) {
    const code = String(target || "ZH").trim().toUpperCase();
    if (code === "YUE" || code === "CANTONESE") {
      return "Traditional Cantonese (Yue Chinese), using Traditional Chinese characters and natural spoken Cantonese phrasing";
    }
    if (code === "ZH-HK") {
      return "Traditional Chinese, using native Traditional Chinese wording, punctuation, and style";
    }
    if (code === "ZH") return "Simplified Chinese";
    return code;
  }

  function normalizeProvider(provider) {
    const name = String(provider || "google-web").trim().toLowerCase();
    if (!PROVIDER_ADAPTERS[name]) throw makeTranslationError("UNSUPPORTED_PROVIDER", `Unsupported provider: ${name}`, { provider: name });
    return name;
  }

  function normalizeTargetLanguage(target, provider) {
    const code = String(target || "ZH").trim().toUpperCase();
    if (!SUPPORTED_TARGET_CODES.has(code)) {
      throw makeTranslationError(
        "UNSUPPORTED_TARGET_LANGUAGE",
        `Unsupported target language: ${code || "(empty)"}`,
        { field: "target", value: code, allowed: Array.from(SUPPORTED_TARGET_CODES).sort() }
      );
    }
    if (provider === "deepl" && ["YUE", "CANTONESE"].includes(code)) {
      throw makeTranslationError(
        "UNSUPPORTED_TARGET_LANGUAGE",
        `DeepL does not support target language ${code}; use an AI provider`,
        { provider, target: code }
      );
    }
    return code;
  }

  function getProviderAdapter(provider) {
    return PROVIDER_ADAPTERS[normalizeProvider(provider)];
  }

  function providerDefault(provider, key) {
    const adapter = getProviderAdapter(provider);
    if (key === "model") return adapter.defaultModel;
    if (key === "endpoint") return adapter.defaultEndpoint;
    if (key === "rps") return adapter.defaultRps || 0;
    return "";
  }

  function providerConcurrencyCap(provider) {
    return getProviderAdapter(provider).concurrencyCap || 96;
  }

  function resolveModel(cfg) {
    return String(cfg.model || "").trim() || providerDefault(cfg.provider, "model");
  }

  function allowedReasoningForModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.startsWith("gpt-5.4")) return new Set(["none", "low", "medium", "high", "xhigh"]);
    if (m.startsWith("gpt-5")) return new Set(["minimal", "low", "medium", "high"]);
    if (m.startsWith("gpt-4.1") || m.startsWith("gpt-4o-mini")) return new Set(["low"]);
    return new Set(["low"]);
  }

  function resolveOpenAiReasoningEffort(model, rawEffort) {
    const requested = String(rawEffort || "").trim().toLowerCase();
    if (requested && !OPENAI_REASONING_EFFORTS.has(requested)) {
      throw makeTranslationError(
        "INVALID_REASONING_EFFORT",
        `reasoning_effort '${requested}' is invalid. allowed=${Array.from(OPENAI_REASONING_EFFORTS).join(",")}`,
        { model, requested, allowed: Array.from(OPENAI_REASONING_EFFORTS) }
      );
    }
    let effort = requested || "low";
    const allowed = allowedReasoningForModel(model);
    if (!allowed.has(effort)) {
      if (requested) {
        throw makeTranslationError(
          "INVALID_REASONING_EFFORT",
          `reasoning_effort '${requested}' is not allowed for model '${model}'. allowed=${Array.from(allowed).join(",")}`,
          { model, requested, allowed: Array.from(allowed) }
        );
      }
      return allowed.has("low") ? "low" : Array.from(allowed)[0];
    }
    return effort;
  }

  function buildTextBatches(items, maxParagraphs, maxChars) {
    const batches = [];
    let current = [];
    let currentChars = 0;
    for (const item of items) {
      const textLen = item.text.length;
      const wouldExceedChars = maxChars > 0 && current.length > 0 && currentChars + textLen > maxChars;
      const wouldExceedParagraphs = maxParagraphs > 0 && current.length >= maxParagraphs;
      if (wouldExceedChars || wouldExceedParagraphs) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += textLen;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  function stripCodeFence(rawText) {
    let text = String(rawText || "").trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    }
    return text.trim();
  }

  function buildDelimitedPrompt(texts, target) {
    const targetText = formatTargetLanguage(target);
    return {
      system: [
        `You are a professional ${targetText} native translator.`,
        "Output only translated content, with no explanations or extra text.",
        "Keep exactly the same number of paragraphs/items as input.",
        "Keep non-translatable content unchanged, including proper nouns, code, URLs, and course codes.",
        "Do not merge, split, drop, or reorder any item.",
        `For multi-item input, use '${AI_LINE_SEPARATOR.trim()}' as the separator between translated items.`,
      ].join("\n"),
      user: [
        `Translate to ${targetText}. Return only translation text with exact item count and order.`,
        "Input:",
        texts.join(AI_LINE_SEPARATOR),
      ].join("\n"),
    };
  }

  function buildIndexedJsonPrompt(texts, target) {
    const targetText = formatTargetLanguage(target);
    const payload = texts.map((text, i) => ({ i, text }));
    return {
      system: "You are a subtitle translation engine. Output ONLY a JSON array. Each item must be an object with keys i and text. Do not drop, merge, reorder, or add items.",
      user: [
        `Translate each text to ${targetText}. Keep indexes unchanged.`,
        `Input JSON:\n${JSON.stringify(payload)}`,
        "Return JSON array only.",
      ].join("\n"),
    };
  }

  function parseDelimitedOutput(rawText, expectedLen) {
    const text = stripCodeFence(rawText);
    let parts = text.split(AI_LINE_SEPARATOR).map((part) => part.trim());
    if (parts.length !== expectedLen) {
      parts = text.split(AI_LINE_SEPARATOR.trim()).map((part) => part.trim());
    }
    if (parts.length !== expectedLen) {
      throw makeTranslationError("INVALID_PROVIDER_OUTPUT", `AI output length mismatch: expected ${expectedLen}, got ${parts.length}`, {
        expected: expectedLen,
        received: parts.length,
      });
    }
    if (parts.some((part) => !String(part || "").trim())) {
      throw makeTranslationError("INVALID_PROVIDER_OUTPUT", "AI output contains an empty translated item", {
        expected: expectedLen,
      });
    }
    return parts;
  }

  function parseIndexedJsonOutput(rawText, expectedLen) {
    const parsed = JSON.parse(stripCodeFence(rawText));
    if (!Array.isArray(parsed)) throw makeTranslationError("INVALID_PROVIDER_OUTPUT", "Model output is not a JSON array");
    const out = new Map();
    for (const item of parsed) {
      if (item && Number.isInteger(item.i) && typeof item.text === "string") {
        const text = item.text.trim();
        if (text) out.set(item.i, text);
      }
    }
    if (out.size !== expectedLen) {
      throw makeTranslationError("INVALID_PROVIDER_OUTPUT", `AI output length mismatch: expected ${expectedLen}, got ${out.size}`, {
        expected: expectedLen,
        received: out.size,
      });
    }
    return Array.from({ length: expectedLen }, (_, i) => out.get(i) || "");
  }

  function normalizeOpenAiEndpoint(endpoint, adapter) {
    const ep = String(endpoint || "").trim();
    if (!ep) return adapter.defaultEndpoint;
    if (ep.endsWith("/v1/responses")) return ep;
    if (ep.startsWith("https://api.openai.com")) return `${ep.replace(/\/+$/, "")}/v1/responses`;
    return ep;
  }

  function normalizeChatCompletionsEndpoint(endpoint, adapter) {
    const ep = String(endpoint || "").trim();
    if (!ep) return adapter.defaultEndpoint;
    if (ep.endsWith("/chat/completions")) return ep;
    if (ep.endsWith("/v1")) return `${ep}/chat/completions`;
    if (adapter.id === "deepseek" && ep.startsWith("https://api.deepseek.com")) return adapter.defaultEndpoint;
    return ep;
  }

  function normalizeGeminiEndpoint(endpoint, model, adapter) {
    const ep = String(endpoint || adapter.defaultEndpoint).trim().replace(/\/+$/, "");
    if (ep.endsWith(":generateContent")) return ep;
    if (ep.includes("/models/")) return `${ep}:generateContent`;
    return `${ep}/models/${model}:generateContent`;
  }

  function normalizeGoogleWebEndpoint(endpoint) {
    return String(endpoint || providerDefault("google-web", "endpoint")).trim().replace(/\?+$/, "");
  }

  function resolveWebTargetLang(target) {
    const code = String(target || "ZH").trim().toUpperCase();
    const map = {
      ZH: "zh-CN",
      "ZH-HK": "zh-TW",
      YUE: "yue",
      CANTONESE: "yue",
      EN: "en",
      JA: "ja",
      KO: "ko",
      FR: "fr",
      DE: "de",
      ES: "es",
      IT: "it",
      PT: "pt",
      RU: "ru",
      AR: "ar",
      HI: "hi",
    };
    return map[code] || code.toLowerCase();
  }

  function normalizeFallbackMode(mode) {
    const value = String(mode || "immediate").trim().toLowerCase();
    if (["immediate", "deferred", "deferred-fastpath"].includes(value)) return value;
    throw makeTranslationError(
      "INVALID_REQUEST",
      `fallback_mode '${value}' is invalid. allowed=immediate,deferred,deferred-fastpath`,
      { field: "fallback_mode", value, allowed: ["immediate", "deferred", "deferred-fastpath"] }
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function directLog(level, event, details = {}) {
    const logger = console?.[level] || console?.log;
    if (typeof logger !== "function") return;
    logger.call(console, `${DIRECT_LOG_TAG} ${event}`, details);
  }

  function getErrorStatus(error) {
    const explicit = Number(error?.status ?? error?.statusCode);
    if (Number.isInteger(explicit) && explicit >= 100 && explicit <= 599) return explicit;
    const match = String(error?.message || error || "").match(/HTTP[_\s]+(\d{3})/i);
    const inferred = match ? Number(match[1]) : null;
    return Number.isInteger(inferred) && inferred >= 100 && inferred <= 599 ? inferred : null;
  }

  function getErrorCode(error) {
    const shared = ns.errorUtils?.getErrorCode?.(error);
    if (shared && !ns.errorUtils?.isGenericCode?.(shared)) return shared;
    const explicit = String(error?.code || "").trim().toUpperCase();
    if (explicit && !["ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR"].includes(explicit)) return explicit.replace(/^HTTP\s+(\d{3})$/, "HTTP_$1");
    const status = getErrorStatus(error);
    if (status) return `HTTP_${status}`;
    if (error?.name === "AbortError") return "REQUEST_TIMEOUT";
    const message = String(error?.message || error || "").toLowerCase();
    if (
      message.includes("load failed") ||
      message.includes("failed to fetch") ||
      message.includes("networkerror") ||
      message.includes("network request failed") ||
      message.includes("connection reset") ||
      message.includes("connection closed") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("ehostunreach") ||
      message.includes("enotfound") ||
      message.includes("offline")
    ) return "NETWORK_ERROR";
    return "PROVIDER_REQUEST_FAILED";
  }

  function summarizeError(error) {
    const status = getErrorStatus(error);
    const serialized = ns.errorUtils?.serializeError?.(error, { phase: "translation" });
    const raw = serialized?.message || String(error?.message || error || "Unknown translation error");
    return {
      code: serialized?.code || getErrorCode(error),
      status: serialized?.status ?? status,
      message: raw.replace(/\s+/g, " ").trim().slice(0, 240),
    };
  }

  function summarizeFailureCodes(items = []) {
    return items.reduce((counts, item) => {
      const raw = ns.errorUtils?.normalizeCode?.(item?.code) || String(item?.code || "").trim().toUpperCase();
      const code = raw && !ns.errorUtils?.isGenericCode?.(raw) ? raw : "FAILURE_DETAIL_MISSING";
      counts[code] = (counts[code] || 0) + 1;
      return counts;
    }, {});
  }

  function parseRetryAfterMs(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(GOOGLE_WEB_RETRY_MAX_MS, Math.round(seconds * 1000));
    }
    const dateMs = Date.parse(raw);
    if (!Number.isFinite(dateMs)) return null;
    return Math.min(GOOGLE_WEB_RETRY_MAX_MS, Math.max(0, dateMs - Date.now()));
  }

  function createHttpError(status, retryAfterMs = null) {
    const error = new Error(`HTTP ${status}`);
    error.name = "ProviderHttpError";
    error.status = Number(status);
    error.code = `HTTP_${status}`;
    if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
    return error;
  }

  function createGoogleRateLimitCircuit() {
    let rateLimitTimestamps = [];
    let circuitError = null;

    function prune(now = Date.now()) {
      rateLimitTimestamps = rateLimitTimestamps.filter(
        (timestamp) => now - timestamp <= GOOGLE_WEB_429_CIRCUIT_WINDOW_MS
      );
    }

    function record(error) {
      if (getErrorStatus(error) !== 429) return circuitError;
      if (circuitError) return circuitError;
      const now = Date.now();
      prune(now);
      rateLimitTimestamps.push(now);
      if (!circuitError && rateLimitTimestamps.length >= GOOGLE_WEB_429_CIRCUIT_THRESHOLD) {
        circuitError = makeTranslationError(
          "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN",
          `Google Web 在 ${GOOGLE_WEB_429_CIRCUIT_WINDOW_MS / 1000} 秒内返回了至少 ${GOOGLE_WEB_429_CIRCUIT_THRESHOLD} 次 HTTP 429，已停止继续请求并准备切换到 Argos`,
          {
            status: 429,
            retryable: false,
            google429Responses: rateLimitTimestamps.length,
            googleCircuitTripped: true,
          }
        );
      }
      return circuitError;
    }

    return {
      record,
      isOpen: () => !!circuitError,
      error: () => circuitError,
      snapshot: () => {
        prune();
        return {
          google429Responses: rateLimitTimestamps.length,
          googleCircuitTripped: !!circuitError,
        };
      },
      throwIfOpen() {
        if (circuitError) throw circuitError;
      },
    };
  }

  function isNonRecoverableError(error) {
    const status = getErrorStatus(error);
    if (status === 401 || status === 403) return true;
    const code = getErrorCode(error);
    return [
      "UNSUPPORTED_PROVIDER",
      "UNSUPPORTED_PROVIDER_PROTOCOL",
      "INVALID_REASONING_EFFORT",
      "PROVIDER_CONFIG_ERROR",
      "PROVIDER_API_KEY_MISSING",
      "INVALID_REQUEST",
      "INVALID_PROVIDER_RESPONSE",
      "INVALID_PROVIDER_OUTPUT",
      "NO_TARGET_TRANSLATION",
      "EMPTY_TRANSLATABLE_VTT",
      "INCONSISTENT_TRANSLATION_RESULT",
      "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN",
    ].includes(code) || String(error?.message || error || "").includes("reasoning_effort");
  }

  function isRetryableError(error) {
    if (isNonRecoverableError(error)) return false;
    const status = getErrorStatus(error);
    if (status === 429 || (status !== null && status >= 500)) return true;
    if (error?.name === "AbortError" || error?.code === "REQUEST_TIMEOUT") return true;
    const code = getErrorCode(error);
    // Only known transient, status-less failures are retried. A malformed
    // provider response is not a network failure; retrying every status-less
    // exception used to hide protocol bugs behind repeated requests.
    return ["NETWORK_ERROR", "PROVIDER_REQUEST_FAILED", "BACKEND_NETWORK_ERROR"].includes(code);
  }

  function retryDelayMs(error, attempt) {
    const retryAfter = Number(error?.retryAfterMs);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(GOOGLE_WEB_RETRY_MAX_MS, retryAfter);
    const status = getErrorStatus(error);
    const base = status === 429 ? GOOGLE_WEB_RETRY_BASE_MS : 700;
    const jitter = status === 429 ? Math.floor(Math.random() * 250) : 0;
    return Math.min(GOOGLE_WEB_RETRY_MAX_MS, base * (2 ** attempt) + jitter);
  }

  function createRateLimiter(rps, { onQueueWait } = {}) {
    const rate = Number(rps) || 0;
    if (rate <= 0) {
      const unlimited = async () => ({ queueWaitMs: 0 });
      unlimited.backoff = () => {};
      return unlimited;
    }

    const gapMs = 1000 / rate;
    let nextAt = 0;
    let cooldownUntil = 0;
    let chain = Promise.resolve();

    const waitForRequest = () => {
      const queuedAt = performance.now();
      const run = chain.then(async () => {
        const now = Date.now();
        const waitMs = Math.max(0, nextAt - now, cooldownUntil - now);
        nextAt = Math.max(now, nextAt, cooldownUntil) + gapMs;
        if (waitMs > 0) await sleep(waitMs);
        const queueWaitMs = Math.round(performance.now() - queuedAt);
        if (queueWaitMs >= 5000) onQueueWait?.({ queueWaitMs, rps: rate });
        return { queueWaitMs };
      });
      chain = run.catch(() => {});
      return run;
    };

    waitForRequest.backoff = (delayMs) => {
      const safeDelay = Math.max(0, Math.min(GOOGLE_WEB_RETRY_MAX_MS, Number(delayMs) || 0));
      cooldownUntil = Math.max(cooldownUntil, Date.now() + safeDelay);
      nextAt = Math.max(nextAt, cooldownUntil);
    };

    return waitForRequest;
  }

  async function fetchJson(url, init, timeoutSeconds, waitForRequest = async () => {}, observer = null) {
    const queuedAt = performance.now();
    const queueInfo = await waitForRequest();
    const queueWaitMs = Math.round(Number(queueInfo?.queueWaitMs) || (performance.now() - queuedAt));
    observer?.({ phase: "request-start", queueWaitMs });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutSeconds) || 30) * 1000);
    const requestStartedAt = performance.now();
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      const text = await resp.text();
      if (!resp.ok) {
        const error = createHttpError(resp.status, parseRetryAfterMs(resp.headers?.get?.("retry-after")));
        error.bodyLength = text.length;
        throw error;
      }
      try {
        const data = JSON.parse(text);
        observer?.({
          phase: "request-success",
          queueWaitMs,
          elapsedMs: Math.round(performance.now() - requestStartedAt),
          status: resp.status,
        });
        return data;
      } catch (_) {
        throw makeTranslationError("INVALID_PROVIDER_RESPONSE", "Provider returned non-JSON response");
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        error.code = "REQUEST_TIMEOUT";
        error.status = null;
        error.message = `Request timed out after ${Math.max(1, Number(timeoutSeconds) || 30)}s`;
      }
      observer?.({
        phase: "request-error",
        queueWaitMs,
        elapsedMs: Math.round(performance.now() - requestStartedAt),
        status: getErrorStatus(error),
        error,
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function extractOpenAiText(data) {
    if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
    const chunks = [];
    for (const item of data.output || []) {
      for (const content of item.content || []) {
        if (content.type === "output_text" && typeof content.text === "string") chunks.push(content.text);
      }
    }
    const joined = chunks.join("").trim();
    if (joined) return joined;
    throw makeTranslationError("INVALID_PROVIDER_RESPONSE", "OpenAI response missing output text");
  }

  function extractChatText(data) {
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return text;
    throw makeTranslationError("INVALID_PROVIDER_RESPONSE", "Chat response missing choices[0].message.content");
  }

  function extractGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.every((part) => part && typeof part.text === "string")
      ? parts.map((part) => part.text).join("").trim()
      : "";
    if (text) return text;
    throw makeTranslationError("INVALID_PROVIDER_RESPONSE", "Gemini response missing candidates[0].content.parts text");
  }

  function extractGoogleWebText(data) {
    const chunks = Array.isArray(data?.[0]) ? data[0] : [];
    const text = chunks.every((item) => Array.isArray(item) && typeof item[0] === "string")
      ? chunks.map((item) => item[0]).join("").trim()
      : "";
    if (text) return text;
    throw makeTranslationError("INVALID_PROVIDER_RESPONSE", "Google Translate response missing translated text");
  }

  function comparableText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // A recovery run starts from the original VTT. If it also fails, its final
  // partial snapshot must not erase Chinese cues that the fast run already
  // completed. Direct translation preserves VTT line structure, so a stable
  // line-wise merge is sufficient and does not couple this background module
  // to the content-script VTT parser.
  function mergePartialVtt(primaryVtt, fallbackVtt, originalVtt) {
    const primaryLines = String(primaryVtt || "").replace(/\r/g, "").split("\n");
    const fallbackLines = String(fallbackVtt || "").replace(/\r/g, "").split("\n");
    const originalLines = String(originalVtt || "").replace(/\r/g, "").split("\n");
    if (primaryLines.length !== originalLines.length || fallbackLines.length !== originalLines.length) {
      return String(primaryVtt || fallbackVtt || originalVtt || "");
    }
    return originalLines.map((originalLine, index) => {
      const primaryLine = primaryLines[index];
      const fallbackLine = fallbackLines[index];
      if (comparableText(primaryLine) === comparableText(originalLine) &&
        comparableText(fallbackLine) !== comparableText(originalLine)) {
        return fallbackLine;
      }
      return primaryLine;
    }).join("\n");
  }

  async function callOpenAi(texts, cfg, adapter, jsonMode = false) {
    const prompt = jsonMode ? buildIndexedJsonPrompt(texts, cfg.target) : buildDelimitedPrompt(texts, cfg.target);
    const model = resolveModel(cfg);
    const body = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: prompt.system }] },
        { role: "user", content: [{ type: "input_text", text: prompt.user }] },
      ],
      reasoning: {
        effort: resolveOpenAiReasoningEffort(model, cfg.reasoning_effort || cfg.reasoningEffort),
      },
    };
    const data = await fetchJson(normalizeOpenAiEndpoint(cfg.endpoint, adapter), {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, cfg.timeout, cfg.waitForRequest);
    return extractOpenAiText(data);
  }

  async function callChatCompletions(texts, cfg, adapter, jsonMode = false) {
    const prompt = jsonMode ? buildIndexedJsonPrompt(texts, cfg.target) : buildDelimitedPrompt(texts, cfg.target);
    const body = {
      model: resolveModel(cfg),
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0,
      ...(adapter.buildExtraBody ? adapter.buildExtraBody(cfg) : {}),
    };
    const data = await fetchJson(normalizeChatCompletionsEndpoint(cfg.endpoint, adapter), {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }, cfg.timeout, cfg.waitForRequest);
    return extractChatText(data);
  }

  async function callGemini(texts, cfg, adapter, jsonMode = false) {
    const prompt = jsonMode ? buildIndexedJsonPrompt(texts, cfg.target) : buildDelimitedPrompt(texts, cfg.target);
    const model = resolveModel(cfg);
    const data = await fetchJson(normalizeGeminiEndpoint(cfg.endpoint, model, adapter), {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: { temperature: 0 },
      }),
    }, cfg.timeout, cfg.waitForRequest);
    return extractGeminiText(data);
  }

  async function callDeepL(texts, cfg, adapter) {
    const endpoint = cfg.endpoint || adapter.defaultEndpoint;
    const body = new URLSearchParams();
    for (const text of texts) body.append("text", text);
    body.set("target_lang", String(cfg.target || "ZH").toUpperCase() === "ZH-HK" ? "ZH-HANT" : (cfg.target || "ZH"));
    body.set("preserve_formatting", "1");
    body.set("split_sentences", "1");
    const formality = String(cfg.deepl_formality || cfg.deeplFormality || "").trim();
    if (formality) body.set("formality", formality);
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        ...adapter.authHeaders(cfg.api_key),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }, cfg.timeout, cfg.waitForRequest);
    const translated = Array.isArray(data?.translations) && data.translations.every((item) =>
      item && typeof item.text === "string" && item.text.trim()
    )
      ? data.translations.map((item) => item.text.trim())
      : [];
    if (translated.length !== texts.length || translated.some((item) => !item)) {
      throw makeTranslationError("INVALID_PROVIDER_OUTPUT", `DeepL returned ${translated.length} non-empty items for ${texts.length} inputs`, {
        expected: texts.length,
        received: translated.length,
      });
    }
    return translated;
  }

  async function callGoogleWeb(texts, cfg, adapter, options = {}) {
    const endpoint = normalizeGoogleWebEndpoint(cfg.endpoint || adapter.defaultEndpoint);
    const target = resolveWebTargetLang(cfg.target);
    const out = [];
    for (let index = 0; index < texts.length; index += 1) {
      cfg.googleRateLimitCircuit?.throwIfOpen?.();
      const text = texts[index];
      const url = `${endpoint}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
      try {
        const data = await withRetries(
          () => fetchJson(url, {
            method: "GET",
            headers: { "Accept": "application/json,text/plain,*/*" },
          }, cfg.timeout, cfg.waitForRequest, (event) => {
            if (event.phase === "request-start" && event.queueWaitMs >= 5000) {
              cfg.onProviderEvent?.({
                type: "queue-wait",
                itemIndex: index,
                batchLabel: options.batchLabel,
                queueWaitMs: event.queueWaitMs,
              });
            }
          }),
          cfg.retries,
          {
            shouldRetry: (error) => !cfg.googleRateLimitCircuit?.isOpen?.() && isRetryableError(error),
            onError: ({ error }) => {
              cfg.googleRateLimitCircuit?.record?.(error);
            },
            onRetry: ({ attempt, delayMs, error }) => {
              const status = getErrorStatus(error);
              if (status === 429) cfg.waitForRequest?.backoff?.(delayMs);
              cfg.onProviderEvent?.({
                type: "retry",
                itemIndex: index,
                batchLabel: options.batchLabel,
                attempt,
                delayMs,
                status,
                error,
              });
            },
          }
        );
        const translated = extractGoogleWebText(data);
        out.push(translated);
      } catch (error) {
        if (cfg.googleRateLimitCircuit?.isOpen?.()) {
          throw cfg.googleRateLimitCircuit.error() || error;
        }
        if (isNonRecoverableError(error)) throw error;
        out.push(text);
        options.onItemFailure?.({ index, error });
      }
    }
    return out;
  }

  async function translateBatch(texts, cfg, options = {}) {
    const adapter = getProviderAdapter(cfg.provider);
    if (adapter.protocol === "deepl-translate") return callDeepL(texts, cfg, adapter);
    if (adapter.protocol === "google-web") return callGoogleWeb(texts, cfg, adapter, options);
    const protocolCalls = {
      "openai-responses": callOpenAi,
      "chat-completions": callChatCompletions,
      "gemini-generate-content": callGemini,
    };
    const call = protocolCalls[adapter.protocol];
    if (!call) throw makeTranslationError("UNSUPPORTED_PROVIDER_PROTOCOL", `Unsupported provider protocol: ${adapter.protocol}`, {
      provider: cfg.provider,
      protocol: adapter.protocol,
    });
    const raw = await call(texts, cfg, adapter, false);
    try {
      return parseDelimitedOutput(raw, texts.length);
    } catch (_) {
      if (options.jsonFallback === false) throw _;
      const jsonRaw = await call(texts, cfg, adapter, true);
      return parseIndexedJsonOutput(jsonRaw, texts.length);
    }
  }

  function supportsRecursiveFallback(provider) {
    return !!getProviderAdapter(provider).supportsRecursiveFallback;
  }

  async function translateBatchChecked(texts, cfg, options = {}) {
    const started = Date.now();
    const translated = await translateBatch(texts, cfg, options);
    const elapsedSeconds = (Date.now() - started) / 1000;
    const threshold = Math.max(0, Number(cfg.slow_split_threshold ?? cfg.slowSplitThreshold) || 0);
    if (
      threshold > 0 &&
      texts.length > 1 &&
      supportsRecursiveFallback(cfg.provider) &&
      elapsedSeconds > threshold
    ) {
      throw makeTranslationError("SLOW_BATCH_RETRY", `slow batch ${elapsedSeconds.toFixed(3)}s>${threshold.toFixed(3)}s, split retry`, {
        elapsedSeconds,
        threshold,
      });
    }
    return translated;
  }

  async function translateBatchRecursive(texts, cfg, retries, warnings, label, options = {}, itemOffset = 0) {
    // Google web already retries each cue independently.  Retrying or
    // recursively splitting the whole batch here would multiply requests
    // after a 429 and was the reason the first few progress updates appeared
    // to hang for minutes.
    if (cfg.provider === "google-web") {
      return translateBatchChecked(texts, cfg, {
        ...options,
        jsonFallback: true,
        batchLabel: label,
      });
    }
    try {
      return await withRetries(
        () => translateBatchChecked(texts, cfg, { ...options, jsonFallback: true, batchLabel: label }),
        retries,
        { onRetry: options.onRetry }
      );
    } catch (err) {
      const message = err?.message || String(err);
      // Preserve the typed error object. Passing only its message drops
      // status/code fields (for example PROVIDER_CONFIG_ERROR or HTTP_401),
      // which can incorrectly trigger recursive splitting and hide the real
      // diagnosis from the final failed-item report.
      if (isNonRecoverableError(err)) throw err;
      if (supportsRecursiveFallback(cfg.provider) && texts.length > 1) {
        const mid = Math.floor(texts.length / 2);
        const left = await translateBatchRecursive(texts.slice(0, mid), cfg, retries, warnings, `${label} left`, options, itemOffset);
        const right = await translateBatchRecursive(texts.slice(mid), cfg, retries, warnings, `${label} right`, options, itemOffset + mid);
        warnings.push(`${label} split fallback: ${message}`);
        return [...left, ...right];
      }
      if (supportsRecursiveFallback(cfg.provider) && texts.length === 1) {
        warnings.push(`${label} single item failed, kept original: ${message}`);
        // Returning the original line is a partial failure, not a successful
        // translation. Report its position so the caller can mark the cue,
        // avoid caching it, and show the actual reason in the UI.
        options.onItemFailure?.({ index: itemOffset, error: err });
        return [texts[0]];
      }
      throw err;
    }
  }

  async function withRetries(fn, retries, options = {}) {
    const maxRetries = Math.max(0, Number(retries) || 0);
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        options.onError?.({
          attempt: attempt + 1,
          maxRetries,
          status: getErrorStatus(err),
          error: err,
        });
        const canRetry = (options.shouldRetry || isRetryableError)(err);
        if (attempt >= maxRetries || !canRetry) break;
        const delayMs = Math.max(0, Number(options.getDelayMs?.(err, attempt) ?? retryDelayMs(err, attempt)) || 0);
        options.onRetry?.({
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          status: getErrorStatus(err),
          error: err,
        });
        await sleep(delayMs);
      }
    }
    throw lastErr;
  }

  async function translateVtt(payload, progressHandler = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw makeTranslationError("INVALID_REQUEST", "Translation payload must be an object", { field: "payload" });
    }
    const handlers = typeof progressHandler === "function"
      ? { onProgress: progressHandler }
      : (progressHandler || {});
    const onProgress = handlers.onProgress || (() => {});
    const onPartialVtt = handlers.onPartialVtt || (() => {});
    const partialEmitIntervalMs = Math.max(0, Number(handlers.partialEmitIntervalMs) || 400);
    let lastPartialEmitAt = 0;

    function emitPartialVtt(force = false) {
      if (!onPartialVtt) return;
      const now = Date.now();
      if (!force && partialEmitIntervalMs > 0 && now - lastPartialEmitAt < partialEmitIntervalMs) return;
      lastPartialEmitAt = now;
      onPartialVtt(translatedLines.join("\n"), {
        completed,
        total: items.length,
        done: !!force,
        translated: translatedCount,
        failed: failedItems.length,
        failed_items: failedItems.slice(0, 50),
        metrics: progressDetails(),
      });
    }

    const provider = normalizeProvider(payload.provider);
    const normalizedTarget = normalizeTargetLanguage(payload.target, provider);
    // Keep all downstream adapters and diagnostics on one canonical target
    // value. This prevents a lowercase/alias target from being sent to a
    // provider while metrics and the UI describe a different language.
    payload = { ...payload, target: normalizedTarget };
    const isGoogleWeb = provider === "google-web";
    const requestedConcurrency = Number(payload.concurrency);
    const requestedRps = Number(payload.rps);
    const rawRps = Number.isFinite(requestedRps) && requestedRps > 0
      ? requestedRps
      : providerDefault(provider, "rps");
    const requestedOrDefaultRps = rawRps || GOOGLE_WEB_DEFAULT_RPS;
    const effectiveRps = isGoogleWeb
      ? Math.max(
        0,
        GOOGLE_WEB_MAX_RPS > 0
          ? Math.min(requestedOrDefaultRps, GOOGLE_WEB_MAX_RPS)
          : requestedOrDefaultRps
      )
      : (Number.isFinite(requestedRps) && requestedRps > 0 ? requestedRps : 0);
    const rawConcurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? requestedConcurrency
      : (isGoogleWeb ? GOOGLE_WEB_CONCURRENCY_CAP : 3);
    const effectiveConcurrency = isGoogleWeb
      ? Math.max(1, Math.min(rawConcurrency, GOOGLE_WEB_CONCURRENCY_CAP))
      : Math.max(1, rawConcurrency || 3);
    const requestedRetries = Number(payload.retries);
    const effectiveRetries = isGoogleWeb
      ? Math.min(
        GOOGLE_WEB_MAX_RETRIES,
        Math.max(0, Number.isFinite(requestedRetries) ? requestedRetries : 1)
      )
      : Math.max(0, Number.isFinite(requestedRetries) ? requestedRetries : 0);
    const cfg = {
      ...payload,
      provider,
      concurrency: effectiveConcurrency,
      rps: effectiveRps,
      retries: effectiveRetries,
      waitForRequest: createRateLimiter(effectiveRps),
      googleRateLimitCircuit: isGoogleWeb ? createGoogleRateLimitCircuit() : null,
    };
    const lines = String(payload.vtt_text || "").replace(/\r/g, "").split("\n");
    const items = [];
    const lineParts = new Map();
    // Keep this zero-based.  A text line can occur after a cue's timecode and
    // a single cue can contain multiple text lines; all of those lines must
    // report the same one-based WebVTT cue number in `failed_items`.
    let currentCueIndex = -1;
    let inCue = false;
    lines.forEach((line, index) => {
      if (isTimecode(line)) {
        currentCueIndex += 1;
        inCue = true;
        return;
      }
      if (!line.trim()) {
        inCue = false;
        return;
      }
      if (!inCue || !shouldTranslate(line)) return;
      const [prefix, body, suffix] = splitVoiceTag(line);
      lineParts.set(index, { prefix, suffix });
      // `items` counts translatable text lines, while failure diagnostics and
      // the renderer need the actual WebVTT cue number. A multiline cue must
      // therefore keep the same cue index for all of its text lines.
      items.push({ index, text: body, cueIndex: currentCueIndex });
    });
    if (items.length === 0) throw makeTranslationError("EMPTY_TRANSLATABLE_VTT", "VTT 中没有可翻译文本");

    // Google web accepts one text per request.  Keeping six cues in one
    // internal batch used to hide progress until all six sequential requests
    // finished, which looked like a hang even when work was progressing.
    // Use one cue per batch for Google so the first successful request updates
    // the UI immediately; other providers keep their normal batching.
    const batchParagraphLimit = isGoogleWeb ? 1 : (Number(payload.max_paragraphs) || 6);
    const batches = buildTextBatches(items, batchParagraphLimit, Number(payload.max_chars) || 1200);
    const translatedLines = [...lines];
    const warnings = [];
    const failedItems = [];
    const failedItemKeys = new Set();
    const deferredFailures = [];
    let completed = 0;
    let translatedCount = 0;
    let nextBatch = 0;
    const fallbackMode = normalizeFallbackMode(cfg.fallback_mode || cfg.fallbackMode);
    const workers = Math.max(1, Math.min(Number(cfg.concurrency) || 3, providerConcurrencyCap(cfg.provider), batches.length));
    const retries = Math.max(0, Number(cfg.retries) || 0);
    const repairConcurrency = Math.max(1, Math.min(Number(cfg.repair_concurrency ?? cfg.repairConcurrency) || 1, 96));
    const startedAt = performance.now();
    const metrics = {
      provider,
      total: items.length,
      batches: batches.length,
      requestedConcurrency: Number.isFinite(requestedConcurrency) ? requestedConcurrency : null,
      requestedRps: Number.isFinite(requestedRps) ? requestedRps : null,
      effectiveConcurrency: workers,
      effectiveRps: isGoogleWeb ? effectiveRps : (Number.isFinite(effectiveRps) ? effectiveRps : 0),
      retriesAllowed: retries,
      processed: 0,
      translated: 0,
      failed: 0,
      retryCount: 0,
      rateLimitCount: 0,
      queueWaitMs: 0,
      providerResults: 0,
      targetResults: 0,
      unchangedResults: 0,
      elapsedMs: 0,
      google429Responses: 0,
      googleCircuitTripped: false,
    };

    function addWarning(message) {
      if (warnings.length < 30) warnings.push(String(message).slice(0, 320));
      else if (warnings.length === 30) warnings.push("Additional translation warnings were omitted; see console metrics.");
    }

    function progressDetails() {
      const circuit = cfg.googleRateLimitCircuit?.snapshot?.() || {};
      return {
        ...metrics,
        ...circuit,
        processed: completed,
        translated: translatedCount,
        failed: failedItems.length,
        failureCodes: summarizeFailureCodes(failedItems),
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }

    function recordFailure(batchNo, item, itemIndex, error) {
      const key = `${batchNo}:${itemIndex}`;
      if (failedItemKeys.has(key)) return;
      failedItemKeys.add(key);
      const summary = summarizeError(error);
      failedItems.push({
        batch: batchNo + 1,
        item: itemIndex + 1,
        cue: Number.isInteger(item?.cueIndex) && item.cueIndex >= 0 ? item.cueIndex + 1 : null,
        line: Number.isInteger(item?.index) ? item.index + 1 : null,
        ...summary,
      });
      addWarning(`batch ${batchNo + 1}/${batches.length}, item ${itemIndex + 1} failed: ${summary.message}`);
    }

    function attachFailureContext(error) {
      const targetError = error instanceof Error ? error : new Error(String(error || "翻译失败"));
      targetError.code = getErrorCode(targetError);
      targetError.metrics = { ...progressDetails() };
      targetError.failed_items = failedItems.slice(0, 50);
      targetError.failure_codes = summarizeFailureCodes(failedItems);
      targetError.warnings = warnings.slice(0, 30);
      targetError.provider = provider;
      targetError.target = String(payload.target || "ZH").toUpperCase();
      targetError.partial_vtt = translatedLines.join("\n");
      targetError.phase = "translation";
      return targetError;
    }

    cfg.onProviderEvent = (event) => {
      if (event.type === "retry") {
        metrics.retryCount += 1;
        if (event.status === 429) metrics.rateLimitCount += 1;
        directLog("warn", "retry scheduled", {
          batch: event.batchLabel,
          item: Number(event.itemIndex) + 1,
          attempt: event.attempt,
          maxRetries: retries,
          status: event.status,
          delayMs: event.delayMs,
        });
      } else if (event.type === "queue-wait") {
        metrics.queueWaitMs += Math.max(0, Number(event.queueWaitMs) || 0);
        directLog("warn", "request queue wait", {
          batch: event.batchLabel,
          item: Number(event.itemIndex) + 1,
          queueWaitMs: event.queueWaitMs,
          effectiveRps,
        });
      } else if (event.type === "item-failed") {
        if (getErrorStatus(event.error) === 429) metrics.rateLimitCount += 1;
        directLog("error", "subtitle item failed; original kept", {
          batch: event.batchLabel,
          item: Number(event.itemIndex) + 1,
          error: summarizeError(event.error),
        });
      } else if (event.type === "item-result") {
        metrics.providerResults += 1;
        if (event.targetHasCjk) metrics.targetResults += 1;
        if (event.unchanged) metrics.unchangedResults += 1;
      }
    };

    function onRetry(info, label) {
      metrics.retryCount += 1;
      if (info.status === 429) metrics.rateLimitCount += 1;
      directLog("warn", "retry scheduled", {
        batch: label,
        attempt: info.attempt,
        maxRetries: retries,
        status: info.status,
        delayMs: info.delayMs,
      });
    }

    if (isGoogleWeb && Number.isFinite(requestedConcurrency) && requestedConcurrency > GOOGLE_WEB_CONCURRENCY_CAP) {
      directLog("warn", "google concurrency clamped", {
        requested: requestedConcurrency,
        effective: effectiveConcurrency,
        cap: GOOGLE_WEB_CONCURRENCY_CAP,
      });
    }
    if (
      isGoogleWeb &&
      GOOGLE_WEB_MAX_RPS > 0 &&
      Number.isFinite(requestedRps) &&
      requestedRps > GOOGLE_WEB_MAX_RPS
    ) {
      directLog("warn", "google RPS clamped", {
        requested: requestedRps,
        effective: effectiveRps,
        cap: GOOGLE_WEB_MAX_RPS,
      });
    }
    directLog("info", "translation started", {
      provider,
      target: String(payload.target || "ZH").toUpperCase(),
      total: items.length,
      batches: batches.length,
      requestedConcurrency: metrics.requestedConcurrency,
      requestedRps: metrics.requestedRps,
      effectiveConcurrency: workers,
      effectiveRps,
      retries,
      fallbackMode,
    });
    reportProgress();

    function reportProgress() {
      onProgress(
        completed,
        items.length,
        `[${completed}/${items.length}] Translating...`,
        progressDetails()
      );
    }

    function applyBatchResult(batch, translated, batchFailures = [], batchNo = 0) {
      if (!Array.isArray(translated) || translated.length !== batch.length) {
        const received = Array.isArray(translated) ? translated.length : null;
        throw makeTranslationError("INVALID_PROVIDER_OUTPUT", `Provider returned ${received == null ? "a non-array response" : `${received} items`} for ${batch.length} inputs`, {
          expected: batch.length,
          received,
        });
      }
      const invalidItemIndex = translated.findIndex((item) => typeof item !== "string" || !item.trim());
      if (invalidItemIndex >= 0) {
        throw makeTranslationError(
          "INVALID_PROVIDER_OUTPUT",
          `Provider returned a non-string or empty item at index ${invalidItemIndex}`,
          { expected: batch.length, received: translated.length, itemIndex: invalidItemIndex }
        );
      }
      const failedIndexes = new Set();
      const stagedFailures = [];
      for (const failure of Array.isArray(batchFailures) ? batchFailures : []) {
        const index = Number(failure?.index);
        if (!Number.isInteger(index) || index < 0 || index >= batch.length) {
          throw makeTranslationError("INCONSISTENT_TRANSLATION_RESULT", `Provider failure index ${String(failure?.index)} is outside batch ${batchNo + 1}`, {
            batch: batchNo + 1,
            itemIndex: failure?.index ?? null,
          });
        }
        if (failedIndexes.has(index)) continue;
        failedIndexes.add(index);
        stagedFailures.push({ index, error: failure?.error });
      }
      const targetRequiresCjk = CJK_TARGET_CODES.has(String(payload.target || "ZH").toUpperCase());
      let acceptedCount = 0;
      let stagedUnchangedCount = 0;
      const stagedLines = [];
      for (let i = 0; i < translated.length; i += 1) {
        const text = translated[i];
        const item = batch[i];
        const parts = lineParts.get(item.index) || { prefix: "", suffix: "" };
        const normalizedText = text.trim();
        if (!normalizedText) {
          const emptyError = makeTranslationError("INVALID_PROVIDER_OUTPUT", `Provider returned an empty item at index ${i}`, {
            itemIndex: i,
          });
          if (!failedIndexes.has(i)) {
            failedIndexes.add(i);
            stagedFailures.push({ index: i, error: emptyError });
          }
          stagedLines.push({ index: item.index, value: lines[item.index] });
          continue;
        }
        if (!failedIndexes.has(i) && targetRequiresCjk && !CJK_RE.test(normalizedText)) {
          if (comparableText(normalizedText) === comparableText(item.text)) {
            // Keep this as a diagnostic counter even though the item is not an
            // accepted translation. `providerResults` remains the count of
            // usable outputs, while `unchangedResults` explains why a 200 OK
            // response still produced a target-language failure.
            stagedUnchangedCount += 1;
          }
          const targetError = makeTranslationError(
            "NO_TARGET_TRANSLATION",
            "Provider 返回了非空结果，但其中没有可识别的目标语言文字",
            { target: String(payload.target || "ZH").toUpperCase(), itemIndex: i }
          );
          failedIndexes.add(i);
          stagedFailures.push({ index: i, error: targetError });
        }
        stagedLines.push({
          index: item.index,
          value: failedIndexes.has(i) ? lines[item.index] : `${parts.prefix}${normalizedText}${parts.suffix}`,
        });
        // Google reports per-cue provider results from callGoogleWeb(). For
        // other providers this is the authoritative counter; a failed item
        // is kept as original text, so it must not be counted as a provider
        // success merely because a placeholder string is present in the
        // returned batch.
        if (!failedIndexes.has(i)) {
          acceptedCount += 1;
        }
      }

      // Commit the batch only after every item has been classified. This
      // prevents an empty/malformed item late in the batch from leaving
      // earlier translated lines and provider counters behind a failed
      // batch, which was a source of false progress and false cacheability.
      for (const line of stagedLines) translatedLines[line.index] = line.value;
      for (const failure of stagedFailures) {
        const item = batch[failure.index];
        recordFailure(batchNo, item, failure.index, failure.error);
        cfg.onProviderEvent?.({
          type: "item-failed",
          itemIndex: failure.index,
          batchLabel: `batch ${batchNo + 1}/${batches.length}`,
          error: failure.error,
        });
      }
      metrics.unchangedResults += stagedUnchangedCount;
      for (let i = 0; i < batch.length; i += 1) {
        if (failedIndexes.has(i)) continue;
        const normalizedText = translated[i].trim();
        cfg.onProviderEvent?.({
          type: "item-result",
          itemIndex: i,
          batchLabel: `batch ${batchNo + 1}/${batches.length}`,
          targetHasCjk: CJK_RE.test(normalizedText),
          unchanged: comparableText(normalizedText) === comparableText(batch[i].text),
        });
      }
      completed += batch.length;
      translatedCount += acceptedCount;
      metrics.processed = completed;
      metrics.translated = translatedCount;
      metrics.failed = failedItems.length;
      directLog("info", "batch completed", {
        batch: batchNo + 1,
        batches: batches.length,
        processed: completed,
        total: items.length,
        translated: translatedCount,
        failed: failedItems.length,
      });
      reportProgress();
      emitPartialVtt(false);
    }

    function keepOriginalBatch(batch, batchNo, error) {
      batch.forEach((item, itemIndex) => recordFailure(batchNo, item, itemIndex, error));
      batch.forEach((item) => {
        translatedLines[item.index] = lines[item.index];
      });
      completed += batch.length;
      metrics.processed = completed;
      metrics.translated = translatedCount;
      metrics.failed = failedItems.length;
      directLog("warn", "batch kept original after failure", {
        batch: batchNo + 1,
        batches: batches.length,
        processed: completed,
        total: items.length,
        failed: batch.length,
        error: summarizeError(error),
      });
      reportProgress();
      emitPartialVtt(false);
    }

    async function worker() {
      while (nextBatch < batches.length) {
        cfg.googleRateLimitCircuit?.throwIfOpen?.();
        const batchNo = nextBatch;
        nextBatch += 1;
        const batch = batches[batchNo];
        const texts = batch.map((item) => item.text);
        const batchFailures = [];
        const label = `batch ${batchNo + 1}/${batches.length}`;
        try {
          if (fallbackMode === "immediate") {
            const translated = await translateBatchRecursive(
              texts,
              cfg,
              retries,
              warnings,
              label,
              {
                batchLabel: label,
                onItemFailure: (failure) => batchFailures.push(failure),
                onRetry: (info) => onRetry(info, label),
              }
            );
            applyBatchResult(batch, translated, batchFailures, batchNo);
          } else {
            const translated = await withRetries(
              () => translateBatchChecked(texts, cfg, {
                jsonFallback: fallbackMode !== "deferred-fastpath",
                batchLabel: label,
                onItemFailure: (failure) => batchFailures.push(failure),
              }),
              retries,
              { onRetry: (info) => onRetry(info, label) }
            );
            applyBatchResult(batch, translated, batchFailures, batchNo);
          }
        } catch (err) {
          const message = err?.message || String(err);
          if (isNonRecoverableError(err)) throw err;
          if (fallbackMode === "immediate") {
            addWarning(`${label} failed: ${message}`);
            keepOriginalBatch(batch, batchNo, err);
          } else {
            deferredFailures.push({ batchNo, batch, texts, error: err });
          }
        }
      }
    }

    try {
      // Wait for every worker to observe the shared circuit before returning
      // an abort. Promise.all() rejects immediately and leaves sibling workers
      // running in the background, which can leak Google requests into the
      // subsequent Argos fallback (or even the next translation job).
      const workerResults = await Promise.allSettled(
        Array.from({ length: workers }, () => worker())
      );
      const rejected = workerResults.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
    } catch (error) {
      const enriched = attachFailureContext(error);
      directLog("error", "translation aborted", {
        code: enriched.code,
        status: getErrorStatus(enriched),
        metrics: enriched.metrics,
        failureCodes: enriched.failure_codes,
        failedItems: enriched.failed_items.slice(0, 10),
      });
      emitPartialVtt(true);
      throw enriched;
    }
    if (fallbackMode !== "immediate" && deferredFailures.length > 0) {
      addWarning(`${fallbackMode} repair phase: ${deferredFailures.length} failed batch(es)`);
      directLog("info", "repair phase started", {
        mode: fallbackMode,
        batches: deferredFailures.length,
        repairConcurrency,
      });
      let nextRepair = 0;
      const repairWorkers = Math.min(repairConcurrency, deferredFailures.length);

      async function repairWorker() {
        while (nextRepair < deferredFailures.length) {
          const item = deferredFailures[nextRepair];
          nextRepair += 1;
          const batchFailures = [];
          const label = `repair batch ${item.batchNo + 1}/${batches.length}`;
          try {
            let translated;
            if (fallbackMode === "deferred-fastpath") {
              translated = await withRetries(
                () => translateBatchChecked(item.texts, cfg, {
                  jsonFallback: true,
                  batchLabel: label,
                  onItemFailure: (failure) => batchFailures.push(failure),
                }),
                retries,
                { onRetry: (info) => onRetry(info, label) }
              );
            } else {
              translated = await translateBatchRecursive(
                item.texts,
                cfg,
                retries,
                warnings,
                label,
                {
                  batchLabel: label,
                  onItemFailure: (failure) => batchFailures.push(failure),
                  onRetry: (info) => onRetry(info, label),
                }
              );
            }
            applyBatchResult(item.batch, translated, batchFailures, item.batchNo);
          } catch (err) {
            const message = err?.message || String(err);
            if (isNonRecoverableError(err)) throw err;
            addWarning(`${label} failed: ${message}`);
            keepOriginalBatch(item.batch, item.batchNo, err);
          }
        }
      }

      try {
        await Promise.all(Array.from({ length: repairWorkers }, () => repairWorker()));
      } catch (error) {
        const enriched = attachFailureContext(error);
        emitPartialVtt(true);
        throw enriched;
      }
    }
    const translatedVtt = translatedLines.join("\n");
    const target = String(payload.target || "ZH").toUpperCase();
    metrics.processed = completed;
    metrics.translated = translatedCount;
    metrics.failed = failedItems.length;
    metrics.elapsedMs = Math.round(performance.now() - startedAt);
    Object.assign(metrics, cfg.googleRateLimitCircuit?.snapshot?.() || {});
    const targetRequiresCjk = CJK_TARGET_CODES.has(target);
    const allItemsFailed = failedItems.length >= items.length;
    if (allItemsFailed || (targetRequiresCjk && (!CJK_RE.test(translatedVtt) || metrics.targetResults === 0))) {
      const failureCodes = summarizeFailureCodes(failedItems);
      const noTargetTranslations = isGoogleWeb && metrics.targetResults === 0;
      const firstAttemptVtt = translatedVtt;

      // Keep the requested 1.4.2 fast profile as the first attempt, but do
      // not leave the user with a misleading "no translations" error when
      // the unofficial endpoint rejects a high-concurrency burst. A single
      // bounded recovery attempt makes the default fast again while still
      // recovering from the common Safari/Google Load failed or HTTP 429
      // failure mode.
      if (
        isGoogleWeb &&
        !cfg.googleRateLimitCircuit?.isOpen?.() &&
        (allItemsFailed || noTargetTranslations) &&
        !payload.__googleWebRecoveryAttempt
      ) {
        const recoverySettings = {
          concurrency: Math.min(GOOGLE_WEB_RECOVERY_CONCURRENCY, items.length),
          rps: GOOGLE_WEB_RECOVERY_RPS,
          retries: Math.max(1, Math.min(GOOGLE_WEB_MAX_RETRIES, effectiveRetries)),
        };
        directLog("warn", "google profile produced no usable Chinese; retrying adaptive profile", {
          initial: {
            effectiveConcurrency: workers,
            effectiveRps,
            failed: failedItems.length,
            providerResults: metrics.providerResults,
            targetResults: metrics.targetResults,
            unchangedResults: metrics.unchangedResults,
            failureCodes,
          },
          recovery: recoverySettings,
        });
        try {
          const recoveryHandlers = {
            ...handlers,
            onProgress: (current, total, line = "", details = {}) => {
              handlers.onProgress?.(
                current,
                total,
                line,
                { ...details, recovery: true, preservedPreviousPartial: true }
              );
            },
            onPartialVtt: (partialVtt, meta = {}) => {
              handlers.onPartialVtt?.(
                mergePartialVtt(partialVtt, firstAttemptVtt, payload.vtt_text),
                { ...meta, recovery: true, preservedPreviousPartial: true }
              );
            },
          };
          const recovered = await translateVtt(
            {
              ...payload,
              ...recoverySettings,
              __googleWebRecoveryAttempt: true,
            },
            recoveryHandlers
          );
          const recoveryWarning = `Google Web 高速配置（concurrency=${workers}, rps=${effectiveRps}）未获得可用中文结果，已自动切换到 concurrency=${recoverySettings.concurrency}, rps=${recoverySettings.rps} 重试。`;
          return {
            ...recovered,
            translated_vtt: mergePartialVtt(recovered.translated_vtt, firstAttemptVtt, payload.vtt_text),
            warnings: [recoveryWarning, ...(Array.isArray(recovered.warnings) ? recovered.warnings : [])],
            metrics: {
              ...(recovered.metrics || {}),
              recoveryAttempted: true,
              initialProfile: {
                effectiveConcurrency: workers,
                effectiveRps,
                failed: failedItems.length,
                providerResults: metrics.providerResults,
                targetResults: metrics.targetResults,
                unchangedResults: metrics.unchangedResults,
                failureCodes,
              },
              recoveryProfile: recoverySettings,
            },
          };
        } catch (recoveryError) {
          recoveryError.metrics = {
            ...(recoveryError.metrics || {}),
            recoveryAttempted: true,
            initialProfile: {
              effectiveConcurrency: workers,
              effectiveRps,
              failed: failedItems.length,
              providerResults: metrics.providerResults,
              targetResults: metrics.targetResults,
              unchangedResults: metrics.unchangedResults,
              failureCodes,
            },
            recoveryProfile: recoverySettings,
          };
          recoveryError.partial_vtt = mergePartialVtt(
            recoveryError.partial_vtt || payload.vtt_text,
            firstAttemptVtt,
            payload.vtt_text
          );
          recoveryError.message = `${recoveryError.message || "Google Web 翻译失败"}；已从 1.4.2 高速配置自动降级到 concurrency=${recoverySettings.concurrency}, rps=${recoverySettings.rps} 重试，仍未获得中文结果`;
          throw recoveryError;
        }
      }

      const hasTargetLanguageFailures = Number(failureCodes.NO_TARGET_TRANSLATION || 0) > 0;
      const invalidResponseCount = ["INVALID_PROVIDER_RESPONSE", "INVALID_PROVIDER_OUTPUT"]
        .reduce((sum, code) => sum + Number(failureCodes[code] || 0), 0);
      const allResponsesInvalid = allItemsFailed && invalidResponseCount === failedItems.length && invalidResponseCount > 0;
      const code = allItemsFailed
        ? (isGoogleWeb
          ? (allResponsesInvalid
            ? "GOOGLE_WEB_INVALID_RESPONSES"
            : hasTargetLanguageFailures ? "GOOGLE_WEB_NO_TARGET_TRANSLATIONS" : "GOOGLE_WEB_ALL_REQUESTS_FAILED")
          : "NO_TRANSLATIONS")
        : (isGoogleWeb ? "GOOGLE_WEB_NO_TARGET_TRANSLATIONS" : "NO_TRANSLATIONS");
      const message = code === "GOOGLE_WEB_NO_TARGET_TRANSLATIONS"
        ? `Google Web 返回了响应，但未获得可识别的中文结果；providerResults=${metrics.providerResults}, targetResults=${metrics.targetResults}, unchanged=${metrics.unchangedResults}, failed=${failedItems.length}, failureCodes=${JSON.stringify(failureCodes)}`
        : allItemsFailed
          ? isGoogleWeb
            ? `Google Web 全部 ${items.length} 条请求失败，未获得中文结果；failureCodes=${JSON.stringify(failureCodes)}`
            : `Provider 全部 ${items.length} 条字幕请求失败，未获得可用译文；failureCodes=${JSON.stringify(failureCodes)}`
          : isGoogleWeb
            ? `Google Web 返回了结果，但未检测到中文翻译；providerResults=${metrics.providerResults}, targetResults=${metrics.targetResults}, unchanged=${metrics.unchangedResults}, failed=${failedItems.length}`
            : "Provider did not return Chinese subtitles";
      const error = new Error(message);
      error.code = code;
      error.metrics = { ...metrics };
      error.failed_items = failedItems.slice(0, 30);
      error.failure_codes = failureCodes;
      error.warnings = warnings.slice(0, 30);
      error.provider = provider;
      error.target = target;
      error.metrics.failureCodes = failureCodes;
      directLog("error", "translation failed", {
        ...metrics,
        code: error.code,
        failureCodes,
        failedItems: failedItems.slice(0, 10),
        firstWarning: warnings[0] || null,
      });
      emitPartialVtt(true);
      throw error;
    }
    const finalFailureCodes = summarizeFailureCodes(failedItems);
    // Keep the complete aggregate failure map alongside the capped
    // failed_items sample. Without this, a legitimate partial result with
    // more than 50 failed cues is rejected at the client boundary because
    // the sample cannot add up to metrics.failed.
    metrics.failureCodes = finalFailureCodes;
    metrics.failure_codes = finalFailureCodes;
    emitPartialVtt(true);
    const result = {
      translated_vtt: translatedVtt,
      warnings,
      // Failure details are a diagnostic sample, not an unbounded transport
      // payload. Metrics/failureCodes retain the complete counts; the UI and
      // validators only promise the first 50 item-level details.
      failed_items: failedItems.slice(0, 50),
      failure_codes: finalFailureCodes,
      failureCodes: finalFailureCodes,
      metrics: { ...metrics },
      cache_hit: false,
    };
    if (failedItems.length > 0) {
      directLog("warn", "translation completed with item failures", {
        ...metrics,
        failedItems: failedItems.length,
        warnings: warnings.length,
      });
    } else {
      directLog("info", "translation completed", metrics);
    }
    return result;
  }

  return { translateVtt, getProviderAdapter };
})();
