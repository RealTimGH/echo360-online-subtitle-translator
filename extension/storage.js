(() => {
  const ns = window.Echo360Translator;
  const {
    STORAGE_KEY,
    CACHE_KEY,
    PREFS_KEY_PREFIX,
    ONBOARDING_KEY,
    DEFAULT_SUBTITLE_SIZE,
    SIZE_MAP,
  } = ns.constants;
  const extensionApi = ns.browserApi;
  const KEYLESS_PROVIDERS = new Set(["mixed", "google-web", "argos", "custom-backend"]);
  const DEFAULT_ARGOS_BACKEND_URL = "http://127.0.0.1:8765";
  const API_KEYS_STORAGE_KEY = "echo360TranslatorApiKeys";
  const normalizeTargetCode = (target = "ZH") => {
    const code = String(target || "ZH").trim().toUpperCase();
    return code === "CANTONESE" ? "YUE" : code;
  };
  // Schema history:
  //   v2 – defaulted to Echo360 native CC injection (useNativeSubtitles=false).
  //   v3 – native CC injection demoted to an opt-in Beta; default is the
  //        reliable browser <track> renderer (useNativeSubtitles=true). Note
  //        the flag name is historical: true means "use browser track", false
  //        means "try native CC injection".
  const PREFS_SCHEMA_VERSION = 3;
  // Display/render prefs (enabled, bilingual, size, useNativeSubtitles, ...)
  // are a personal, browser-wide habit - not something tied to one specific
  // lesson - so they are stored under a single fixed key rather than scoped
  // per lesson/pathname. Earlier versions scoped them via getContextKey()
  // (see below), which meant choosing e.g. "always use browser subtitles" on
  // one lesson had no effect on the next lesson opened, since each lesson's
  // unique URL produced its own separate storage entry.
  const GLOBAL_PREFS_KEY = `${PREFS_KEY_PREFIX}global`;

  function isLocalBackendEnabled() {
    return ns.buildConfig?.enableLocalBackend !== false;
  }

  // Still used elsewhere as a general "what lesson am I on" helper; no longer
  // used to scope prefs storage (see GLOBAL_PREFS_KEY above).
  function getContextKey() {
    const m = location.pathname.match(/\/lesson\/([^/]+)/);
    return `${location.hostname}::${m ? m[1] : location.pathname}`;
  }

  // One-time migration for users upgrading from a version that scoped prefs
  // per lesson: adopt whichever legacy per-lesson entry happens to be found
  // first as the new global default, so a choice the user already made isn't
  // silently discarded the first time getPrefs() runs under the new scheme.
  async function migrateLegacyPerLessonPrefs() {
    const all = await extensionApi.storage.local.get(null);
    for (const [key, value] of Object.entries(all || {})) {
      if (key === GLOBAL_PREFS_KEY || !key.startsWith(PREFS_KEY_PREFIX)) continue;
      if (!value || typeof value !== "object") continue;
      await extensionApi.storage.local.set({ [GLOBAL_PREFS_KEY]: value });
      return value;
    }
    return null;
  }

  async function getPrefs() {
    const obj = await extensionApi.storage.local.get(GLOBAL_PREFS_KEY);
    const stored = obj[GLOBAL_PREFS_KEY] || (await migrateLegacyPerLessonPrefs());
    const prefs = stored || {
      enabled: true,
      size: DEFAULT_SUBTITLE_SIZE,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      // Transcript panel enhancement is an independent surface.  Keep it
      // opt-in on fresh installs; an explicit stored choice is preserved by
      // the normalization below so upgrades do not overwrite user settings.
      transcriptPanelEnabled: false,
      // Default: browser <track> renderer. Native CC injection remains
      // available as an opt-in Beta, but at high playback speed Echo360's
      // own caption DOM routinely lags and miss-injection is still common,
      // so it is no longer the out-of-the-box path.
      useNativeSubtitles: true,
      renderModeVersion: PREFS_SCHEMA_VERSION,
    };
    if (prefs.renderModeVersion !== PREFS_SCHEMA_VERSION) {
      // One-shot migration off the v2 "native CC preferred" default onto the
      // reliable browser track. Users who want the Beta native look can
      // re-enable it in the settings popover after upgrading.
      prefs.useNativeSubtitles = true;
      prefs.renderModeVersion = PREFS_SCHEMA_VERSION;
    } else {
      prefs.useNativeSubtitles = prefs.useNativeSubtitles === true;
    }
    prefs.browserBilingual = typeof prefs.browserBilingual === "boolean" ? prefs.browserBilingual : prefs.bilingual === true;
    prefs.browserReverseOrder = typeof prefs.browserReverseOrder === "boolean" ? prefs.browserReverseOrder : prefs.reverseOrder === true;
    // A missing field is the upgrade/fresh-install default: disabled.  Only a
    // stored boolean true represents an explicit opt-in.
    prefs.transcriptPanelEnabled = prefs.transcriptPanelEnabled === true;
    prefs.bilingual = prefs.useNativeSubtitles ? prefs.browserBilingual : true;
    prefs.reverseOrder = prefs.useNativeSubtitles ? prefs.browserReverseOrder : false;
    if (prefs.size === "tiny") prefs.size = "medium";
    else if (!SIZE_MAP[prefs.size]) prefs.size = DEFAULT_SUBTITLE_SIZE;
    return prefs;
  }

  async function savePrefs(prefs) {
    const key = GLOBAL_PREFS_KEY;
    const obj = await extensionApi.storage.local.get(key);
    const existing = obj[key] && typeof obj[key] === "object" ? obj[key] : {};
    const useNativeSubtitles = prefs.useNativeSubtitles !== false;
    const browserBilingual = useNativeSubtitles
      ? prefs.bilingual === true
      : typeof prefs.browserBilingual === "boolean"
        ? prefs.browserBilingual
        : existing.browserBilingual === true;
    const browserReverseOrder = useNativeSubtitles
      ? prefs.reverseOrder === true
      : typeof prefs.browserReverseOrder === "boolean"
        ? prefs.browserReverseOrder
        : existing.browserReverseOrder === true;
    const transcriptPanelEnabled = typeof prefs.transcriptPanelEnabled === "boolean"
      ? prefs.transcriptPanelEnabled
      : existing.transcriptPanelEnabled === true;
    const normalizedPrefs = {
      ...prefs,
      renderModeVersion: PREFS_SCHEMA_VERSION,
      useNativeSubtitles,
      browserBilingual,
      browserReverseOrder,
      transcriptPanelEnabled,
      bilingual: useNativeSubtitles ? browserBilingual : true,
      reverseOrder: useNativeSubtitles ? browserReverseOrder : false,
    };
    await extensionApi.storage.local.set({ [key]: normalizedPrefs });
  }

  async function sha256Text(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function getCacheStore() {
    const obj = await extensionApi.storage.local.get(CACHE_KEY);
    return obj[CACHE_KEY] && typeof obj[CACHE_KEY] === "object" ? obj[CACHE_KEY] : null;
  }

  async function setCacheStore(entryOrNull) {
    try {
      await extensionApi.storage.local.set({ [CACHE_KEY]: entryOrNull || null });
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err || "缓存写入失败"));
      error.code = error.code || "CACHE_WRITE_FAILED";
      console.error("[echo360-translator][storage] subtitle cache write failed", ns.errorUtils?.serializeError?.(error, { phase: "cache" }) || {
        code: error.code,
        message: error.message,
      });
      return { ok: false, error };
    }
  }

  function buildConfigSignature(cfg) {
    const mixedPriorityActive = cfg.provider === "mixed" && cfg.mixedPriorityEnabled === true;
    const mixedProvidersSignature = cfg.provider === "mixed"
      ? JSON.stringify((Array.isArray(cfg.mixedProviders) ? cfg.mixedProviders : []).map((item) => {
        if (mixedPriorityActive || !item || typeof item !== "object" || Array.isArray(item)) return item;
        const { priorityGroup: _priorityGroup, ...withoutPriorityGroup } = item;
        return withoutPriorityGroup;
      }))
      : "";
    return JSON.stringify([
      // Invalidate caches created before the strict result/error contract. A
      // syntactically valid VTT from an older build may still contain only
      // original text, so treating it as a fresh success would be misleading.
      "cache-schema-v2",
      cfg.provider,
      cfg.model,
      cfg.endpoint || "",
      normalizeTargetCode(cfg.target || "ZH"),
      Number(cfg.maxParagraphs) || 0,
      Number(cfg.maxChars) || 0,
      cfg.reasoningEffort || "",
      cfg.deepseekThinkingMode || "",
      cfg.deeplFormality || "",
      cfg.provider === "azure" ? (cfg.azureRegion || "") : "",
      cfg.provider === "custom-backend" ? (cfg.customBackendUrl || cfg.backendUrl || "") : "",
      mixedProvidersSignature,
      cfg.provider === "mixed" ? JSON.stringify(cfg.providerConfigs || {}) : "",
      // Priority routing is meaningful only for the mixed provider. Ignore
      // dormant settings on single-provider configurations, and ignore the
      // group list while the feature is disabled so editing a future policy
      // does not evict a cache that cannot use it yet.
      cfg.provider === "mixed" ? cfg.mixedPriorityEnabled === true : "",
      cfg.provider === "mixed" && cfg.mixedPriorityEnabled === true
        ? JSON.stringify(cfg.mixedPriorityGroups || [])
        : "",
      cfg.provider === "mixed" && (cfg.mixedProviders || []).some((item) => item?.provider === "custom-backend" && item?.enabled !== false)
        ? (cfg.customBackendUrl || cfg.backendUrl || "")
        : "",
    ]);
  }

  async function getConfig() {
    const [configObj, keysObj] = await Promise.all([
      extensionApi.storage.local.get(STORAGE_KEY),
      extensionApi.storage.local.get(API_KEYS_STORAGE_KEY),
    ]);
    const value = configObj[STORAGE_KEY];
    const separateKeys = keysObj[API_KEYS_STORAGE_KEY] || {};
    const defaults = {
      apiKey: "",
      apiKeys: {},
      appearance: "auto",
      customBackendUrl: DEFAULT_ARGOS_BACKEND_URL,
      provider: "google-web",
      mixedProviders: [
        { provider: "google-web", weight: 60, enabled: true, priorityGroup: "" },
        { provider: "argos", weight: 40, enabled: true, priorityGroup: "" },
      ],
      // Priority groups are an opt-in routing policy. Keep the policy dormant
      // by default so existing mixed translations retain their weighted
      // distribution behavior after an upgrade.
      mixedPriorityEnabled: false,
      mixedPriorityGroups: [],
      providerConfigs: {},
      model: "",
      endpoint: "",
      target: "ZH",
      // Automatic AI material export is opt-in. An explicit stored boolean
      // below still wins, so upgrades do not overwrite a user's choice.
      quickTranslateAutoExport: false,
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
    };
    const config = { ...defaults, ...(value || {}) };
    config.target = normalizeTargetCode(config.target);
    config.mixedPriorityEnabled = config.mixedPriorityEnabled === true;
    config.mixedPriorityGroups = Array.isArray(config.mixedPriorityGroups)
      ? config.mixedPriorityGroups
      : [];
    // Missing or malformed values use the default-off behavior. Keep explicit
    // true for users who have already enabled the setting, including on upgrades.
    config.quickTranslateAutoExport = config.quickTranslateAutoExport === true;
    // Resolve the effective API key for the current provider from the per-provider
    // map, falling back to the legacy single apiKey field for migration.
    config.apiKeys = { ...(config.apiKeys || {}), ...separateKeys };
    const provider = config.provider || "google-web";
    const effectiveApiKey = KEYLESS_PROVIDERS.has(provider)
      ? ""
      : (config.apiKeys?.[provider] ?? config.apiKey ?? "");
    const resolved = { ...config, apiKey: effectiveApiKey, apiKeys: config.apiKeys || {} };
    if (!isLocalBackendEnabled() && provider === "argos") {
      const fallback = {
        ...resolved,
        provider: "google-web",
        model: "",
        endpoint: "",
        apiKey: "",
        backendUrl: DEFAULT_ARGOS_BACKEND_URL,
      };
      delete fallback.useLocalBackend;
      return fallback;
    }
    const migratedCustomUrl = String(
      value?.customBackendUrl ||
      (provider === "custom-backend" ? value?.backendUrl : "") ||
      DEFAULT_ARGOS_BACKEND_URL
    ).trim();
    const routed = {
      ...resolved,
      customBackendUrl: migratedCustomUrl,
      // Routing is provider-owned. Argos always uses the packaged endpoint;
      // only the explicit custom-backend provider uses a configurable URL.
      backendUrl: provider === "custom-backend" || provider === "mixed"
        ? migratedCustomUrl
        : DEFAULT_ARGOS_BACKEND_URL,
    };
    delete routed.useLocalBackend;
    return routed;
  }

  async function saveConfig(config) {
    await extensionApi.storage.local.set({ [STORAGE_KEY]: config });
  }

  async function getOnboardingSeen() {
    const obj = await extensionApi.storage.local.get(ONBOARDING_KEY);
    return !!obj[ONBOARDING_KEY];
  }

  async function setOnboardingSeen() {
    await extensionApi.storage.local.set({ [ONBOARDING_KEY]: true });
  }

  async function askApiKeyIfNeeded(config) {
    const provider = String(config.provider || "").toLowerCase();
    const apiKey = String(config.apiKey || "").trim();
    if (KEYLESS_PROVIDERS.has(provider)) {
      return { ...config, apiKey: "" };
    }
    if (apiKey) return config;
    return null;
  }

  ns.storage = {
    getContextKey,
    getPrefs,
    savePrefs,
    sha256Text,
    getCacheStore,
    setCacheStore,
    buildConfigSignature,
    getConfig,
    saveConfig,
    askApiKeyIfNeeded,
    getOnboardingSeen,
    setOnboardingSeen,
  };
})();
