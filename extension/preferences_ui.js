// Shared configuration defaults and error-card behavior for popup.js and
// options.js. Keeping these browser-extension pages on one boundary prevents
// defaults, error precedence, and accessibility behavior from drifting apart.
(() => {
  const root = globalThis;

  const DEFAULT_CONFIG = Object.freeze({
    apiKey: "",
    customBackendUrl: "http://127.0.0.1:8765",
    provider: "google-web",
    model: "",
    endpoint: "",
    target: "ZH",
    maxParagraphs: 6,
    maxChars: 1200,
    concurrency: 96,
    rps: 0,
    retries: 1,
    timeout: 10,
    reasoningEffort: "",
    fallbackMode: "immediate",
    repairConcurrency: 1,
    slowSplitThreshold: 0,
    deepseekThinkingMode: "disabled",
    deeplFormality: "",
    azureRegion: "",
  });

  const PROVIDER_DEFAULTS = Object.freeze({
    "google-web": Object.freeze({ model: "", endpoint: "" }),
    openai: Object.freeze({ model: "gpt-5-nano", endpoint: "" }),
    deepseek: Object.freeze({ model: "deepseek-v4-flash", endpoint: "" }),
    gemini: Object.freeze({ model: "gemini-3.1-flash-lite", endpoint: "" }),
    deepl: Object.freeze({ model: "", endpoint: "" }),
    azure: Object.freeze({ model: "", endpoint: "" }),
    argos: Object.freeze({ model: "", endpoint: "" }),
    "custom-backend": Object.freeze({ model: "", endpoint: "" }),
  });

  const PROVIDER_LABELS = Object.freeze({
    "google-web": "Google Translate",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    openai: "OpenAI",
    deepl: "DeepL",
    azure: "Azure AI Translator F0",
    argos: "Argos Translate（本地）",
    "custom-backend": "自定义后端",
  });

  function createModelPresets({ includeLocalOnly = true } = {}) {
    const providers = ["google-web", "deepseek", "gemini", "openai", "deepl", "azure"];
    if (includeLocalOnly) providers.push("argos");
    providers.push("custom-backend");
    return providers.map((provider) => {
      const defaults = PROVIDER_DEFAULTS[provider];
      return {
        provider,
        ...defaults,
        label: defaults.model
          ? `${PROVIDER_LABELS[provider]} - ${defaults.model}`
          : PROVIDER_LABELS[provider],
      };
    });
  }

  function fallbackErrorModel(error) {
    return {
      code: error?.code || error?.error_code || error?.error_detail?.error_code ||
        error?.error_detail?.code || "ERROR_DETAILS_MISSING",
      title: "错误详情缺失",
      summary: error?.message || error?.error || "界面收到失败通知，但没有收到可展示的错误详情。",
      recommendation: "请重试并查看扩展 Console。",
      copyText: String(error?.message || error?.error || "错误详情缺失 [ERROR_DETAILS_MISSING]"),
      details: [{ label: "诊断状态", value: "未提供结构化错误信息" }],
    };
  }

  function createErrorPresenter({
    surface = "preferences",
    documentRoot = root.document,
    clipboard = root.navigator?.clipboard,
    resetDelay = 2200,
  } = {}) {
    let currentModel = null;

    function typed(errorLike, code = "STORAGE_ERROR") {
      const error = root.Echo360ExtensionApi?.toError
        ? root.Echo360ExtensionApi.toError(errorLike, code, "操作失败")
        : (errorLike instanceof Error ? errorLike : new Error(String(errorLike?.message || errorLike || "操作失败")));
      if (!error.code) error.code = code;
      error.phase = error.phase || "preferences";
      return error;
    }

    function elements() {
      const status = documentRoot?.getElementById?.("status") || null;
      const details = documentRoot?.getElementById?.("errorDetails") || null;
      return {
        status,
        details,
        announcement: documentRoot?.getElementById?.("errorAnnouncement") || null,
        title: details?.querySelector?.(".error-card-title") || null,
        summary: details?.querySelector?.(".error-card-summary") || null,
        recommendation: details?.querySelector?.(".error-card-recommendation") || null,
        diagnostics: details?.querySelector?.("pre") || null,
      };
    }

    function clear() {
      const refs = elements();
      refs.status?.classList.remove("error", "warning");
      refs.status?.setAttribute("aria-live", "polite");
      refs.details?.classList.remove("warning");
      refs.details?.setAttribute("role", "region");
      refs.details?.setAttribute("aria-live", "off");
      refs.announcement?.setAttribute("role", "status");
      refs.announcement?.setAttribute("aria-live", "polite");
      if (refs.details) refs.details.hidden = true;
      if (refs.title) refs.title.textContent = "";
      if (refs.summary) refs.summary.textContent = "";
      if (refs.recommendation) refs.recommendation.textContent = "";
      if (refs.diagnostics) refs.diagnostics.textContent = "";
      currentModel = null;
    }

    function show(error, context = {}) {
      const model = root.Echo360Error?.normalizeError?.(error, context) || fallbackErrorModel(error);
      const refs = elements();
      const warning = model.severity === "warning";
      currentModel = model;

      refs.status?.classList.toggle("error", !warning);
      refs.status?.classList.toggle("warning", warning);
      refs.status?.setAttribute("aria-live", "off");
      refs.details?.classList.toggle("warning", warning);
      refs.details?.setAttribute("role", "region");
      refs.details?.setAttribute("aria-live", "off");
      refs.announcement?.setAttribute("role", warning ? "status" : "alert");
      refs.announcement?.setAttribute("aria-live", warning ? "polite" : "assertive");
      if (refs.status) refs.status.textContent = `[${model.code}] ${model.title}`;
      if (refs.title) refs.title.textContent = `${model.title} [${model.code}]`;
      if (refs.summary) refs.summary.textContent = model.summary;
      if (refs.recommendation) refs.recommendation.textContent = `建议：${model.recommendation}`;
      if (refs.diagnostics) {
        refs.diagnostics.textContent = (model.details || [])
          .map((item) => `${item.label}: ${item.value}`)
          .join("\n");
      }
      if (refs.details) refs.details.hidden = false;
      console.error(`[echo360-translator][${surface}] operation failed`, model);
      return model;
    }

    async function copyDiagnostics(button) {
      try {
        if (!clipboard?.writeText) throw new Error("clipboard API unavailable");
        await clipboard.writeText(currentModel?.copyText || "");
        if (button) button.textContent = "已复制";
        return true;
      } catch (error) {
        const normalized = typed(error, "CLIPBOARD_COPY_FAILED");
        console.error(
          `[echo360-translator][${surface}] copying error diagnostics failed`,
          root.Echo360Error?.serializeError?.(normalized, { phase: "preferences" }) || normalized
        );
        show(normalized, { phase: "preferences", code: "CLIPBOARD_COPY_FAILED" });
        if (button) button.textContent = "复制失败，请手动展开详情";
        return false;
      } finally {
        if (button && resetDelay >= 0) {
          root.setTimeout(() => { button.textContent = "复制错误信息"; }, resetDelay);
        }
      }
    }

    return {
      typed,
      clear,
      show,
      copyDiagnostics,
      get currentModel() {
        return currentModel;
      },
    };
  }

  root.Echo360PreferencesUi = {
    DEFAULT_CONFIG,
    PROVIDER_DEFAULTS,
    createModelPresets,
    createErrorPresenter,
  };
})();
