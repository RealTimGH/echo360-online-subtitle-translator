const STORAGE_KEY = "echo360TranslatorConfig";
const extensionApi = window.Echo360ExtensionApi;
const buildConfig = window.Echo360BuildConfig || {};
const enableLocalBackend = buildConfig.enableLocalBackend !== false;
const { DEFAULT_CONFIG: defaultConfig, PROVIDER_DEFAULTS: providerDefaults, createErrorPresenter } =
  window.Echo360PreferencesUi;
const { API_KEYS_STORAGE_KEY, isKeylessProvider, buildKeyMap, stashKey, resolveForSave } = window.Echo360ConfigKeys;
const errorPresenter = createErrorPresenter({ surface: "options" });
const typedOptionsError = (errorLike, code = "STORAGE_ERROR") => errorPresenter.typed(errorLike, code);

const providerHints = {
  mixed: "把字幕按可调权重分给多个服务并行翻译；失败分片会自动转交给其他健康服务。",
  "google-web": "免费且无需 API Key，适合首次试用；它使用非官方网页端点，稳定性与配额没有保证。",
  deepseek: "需要你自己的 DeepSeek API Key。更适合追求课程字幕翻译质量的长期使用；为了更丝滑的翻译体验，DeepSeek Thinking 默认为关闭。",
  gemini: "需要你自己的 Gemini API Key。适合追求更好翻译质量；请确认所在地区和账号可用。",
  openai: "需要你自己的 OpenAI API Key。适合追求更好翻译质量；Reasoning Effort 仅对支持模型生效。",
  deepl: "需要你自己的 DeepL API Key。适合常规机器翻译质量需求；不支持 YUE 目标语言。",
  azure: "需要 Azure Translator F0 资源的订阅密钥。支持批量翻译、简体/繁体中文和粤语；区域型资源还需在高级设置填写 Region。",
  argos: "完全在本机离线翻译，不需要 API Key；源字幕必须是英语。后端会在翻译时自动启动，无需额外开关。",
  "custom-backend": "把字幕发送到你指定的兼容后端。只有选择此服务时才会使用该 URL；其他在线服务始终由扩展直连。"
};

const DEFAULT_MIXED_WEIGHTS = { "google-web": 60, argos: 40 };
const MIXED_PROVIDER_LABELS = {
  "google-web": "Google Translate",
  deepl: "DeepL",
  azure: "Azure Translator",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  openai: "OpenAI",
  argos: "Argos（本地）",
  "custom-backend": "自定义后端",
};

function applyAppearance(mode) {
  const root = document.documentElement;
  if (!mode || mode === "auto") {
    delete root.dataset.appearance;
  } else {
    root.dataset.appearance = mode;
  }
}

function setStatus(text, isError = false) {
  const status = document.getElementById("status");
  status.textContent = text;
  status.classList.toggle("error", !!isError);
  status.setAttribute("aria-live", isError ? "off" : "polite");
  if (!isError) {
    const details = document.getElementById("errorDetails");
    if (details) details.hidden = true;
  }
}

const clearError = () => errorPresenter.clear();
const showError = (error, context = {}) => errorPresenter.show(error, context);

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getInputValue(id, fallback = "") {
  const el = document.getElementById(id);
  return el ? el.value : fallback;
}

function getNumberValue(id, fallback, min) {
  const raw = getInputValue(id, "");
  const parsed = raw === "" ? Number(fallback) : Number(raw);
  const fallbackNumber = Number(fallback);
  const value = Number.isFinite(parsed) ? parsed : fallbackNumber;
  return Math.max(min, Number.isFinite(value) ? value : min);
}

function refreshAdvancedUi(provider) {
  const advancedRows = [...document.querySelectorAll("[data-provider-advanced]")];
  const hasDevAdvanced = document.querySelector("[data-dev-advanced]") !== null;
  let visibleCount = 0;
  for (const row of advancedRows) {
    const visible = row.dataset.providerAdvanced === provider;
    row.hidden = !visible;
    if (visible) visibleCount += 1;
  }
  const emptyHint = document.getElementById("advancedEmptyHint");
  if (emptyHint) emptyHint.hidden = visibleCount > 0 || hasDevAdvanced;
}

// In-memory map of provider → API key, populated on load and updated on switch.
let localApiKeys = {};
let localProviderConfigs = {};
let localPriorityGroups = [{ id: "priority-1", afterCues: 0 }];
let nextPriorityGroupId = 2;

function priorityEnabled() {
  return document.getElementById("mixedPriorityEnabled").checked;
}

function priorityMemberRows(id) {
  return mixedRows().filter((row) => row.querySelector(".mixed-provider-group")?.value === id &&
    row.querySelector(".mixed-provider-enabled")?.checked);
}

function renderMixedPriorityGroups() {
  document.getElementById("mixedPriorityEditor").hidden = !priorityEnabled();
  for (const row of mixedRows()) {
    let wrapper = row.querySelector(".mixed-provider-priority");
    if (!wrapper) {
      wrapper = document.createElement("label");
      wrapper.className = "mixed-provider-priority";
      wrapper.textContent = "所属级别";
      const select = document.createElement("select");
      select.className = "mixed-provider-group";
      select.setAttribute("aria-label", `${MIXED_PROVIDER_LABELS[row.dataset.mixedProvider]} 所属级别`);
      select.addEventListener("change", () => { renderMixedPriorityGroups(); refreshMixedWeightSummary(); });
      wrapper.append(select);
      row.append(wrapper);
    }
    wrapper.hidden = !priorityEnabled();
    const select = wrapper.querySelector("select");
    const previous = select.value;
    select.replaceChildren(...localPriorityGroups.map((group, index) => new Option(`第 ${index + 1} 级`, group.id)));
    select.value = localPriorityGroups.some((group) => group.id === previous) ? previous : localPriorityGroups[0].id;
  }
  const container = document.getElementById("mixedPriorityGroups");
  container.replaceChildren();
  localPriorityGroups.forEach((group, index) => {
    const card = document.createElement("div");
    card.className = "mixed-priority-group";
    card.dataset.priorityGroup = group.id;
    const title = document.createElement("h3");
    title.textContent = `第 ${index + 1} 级${index === 0 ? " · 默认启用" : ""}`;
    card.append(title);
    const members = document.createElement("div");
    members.className = "hint";
    const rows = priorityMemberRows(group.id);
    members.textContent = rows.length ? rows.map((row) => {
      const unavailable = row.hidden || row.querySelector(".mixed-provider-enabled").disabled;
      return `${MIXED_PROVIDER_LABELS[row.dataset.mixedProvider]}${unavailable ? "（当前不可用）" : ""}`;
    }).join(" · ") : "尚未分配服务，请在下方选择。";
    card.append(members);
    if (index > 0) {
      const label = document.createElement("label");
      label.textContent = "字幕总数超过多少条时加入";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.className = "mixed-priority-threshold";
      input.value = group.afterCues == null ? "" : String(group.afterCues);
      input.placeholder = "例如 500";
      input.setAttribute("aria-label", `第 ${index + 1} 级字幕阈值`);
      input.addEventListener("input", () => {
        group.afterCues = input.value === "" ? null : Number(input.value);
        refreshMixedWeightSummary();
      });
      label.append(input);
      card.append(label);
    }
    const actions = document.createElement("div");
    actions.className = "mixed-priority-actions";
    for (const [label, offset] of [["上移", -1], ["下移", 1]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.move = String(offset);
      button.setAttribute("aria-label", `第 ${index + 1} 级${label}`);
      button.disabled = index + offset < 0 || index + offset >= localPriorityGroups.length;
      button.addEventListener("click", () => {
        const other = localPriorityGroups[index + offset];
        // Thresholds belong to levels; memberships travel with stable group IDs.
        [group.id, other.id] = [other.id, group.id];
        renderMixedPriorityGroups();
        refreshMixedWeightSummary();
      });
      actions.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除空组";
    remove.dataset.removeGroup = group.id;
    remove.disabled = localPriorityGroups.length === 1 || rows.length > 0;
    remove.addEventListener("click", () => {
      localPriorityGroups.splice(index, 1);
      localPriorityGroups[0].afterCues = 0;
      renderMixedPriorityGroups();
      refreshMixedWeightSummary();
    });
    actions.append(remove);
    card.append(actions);
    container.append(card);
  });
  document.getElementById("addMixedPriorityGroup").disabled = localPriorityGroups.length >= 8;
}

function validateMixedPriorityUi(providers) {
  if (!priorityEnabled()) return;
  let previous = -1;
  for (const [index, group] of localPriorityGroups.entries()) {
    let message = "";
    if (!providers.some((item) => item.priorityGroup === group.id)) {
      message = `第 ${index + 1} 级至少需要一个支持当前目标语言的已选服务。`;
    } else if (!Number.isSafeInteger(group.afterCues) || group.afterCues < 0 ||
      (index === 0 ? group.afterCues !== 0 : group.afterCues <= previous)) {
      message = `第 ${index + 1} 级阈值必须是大于上一级阈值的正整数。`;
    }
    if (message) throw Object.assign(new Error(message), { code: "MIXED_PRIORITY_CONFIG_INVALID" });
    previous = group.afterCues;
  }
}

function mixedRows() {
  return [...document.querySelectorAll("[data-mixed-provider]")];
}

function mixedProviderSupportsTarget(provider, target) {
  const code = String(target || "ZH").toUpperCase();
  if (provider === "deepl" && ["YUE", "CANTONESE"].includes(code)) return false;
  if (provider === "argos" && ["YUE", "CANTONESE", "EN"].includes(code)) return false;
  return true;
}

function refreshMixedAvailability() {
  const target = document.getElementById("target")?.value || "ZH";
  for (const row of mixedRows()) {
    const checkbox = row.querySelector(".mixed-provider-enabled");
    const supported = mixedProviderSupportsTarget(row.dataset.mixedProvider, target) &&
      (row.dataset.mixedProvider !== "argos" || enableLocalBackend);
    if (checkbox) checkbox.disabled = !supported;
    row.style.opacity = supported ? "" : "0.55";
    row.title = supported ? "" : "当前目标语言不受此服务支持";
  }
}

function refreshMixedWeightSummary() {
  const enabledRows = mixedRows().filter((row) => {
    const checkbox = row.querySelector(".mixed-provider-enabled");
    return checkbox?.checked && !checkbox.disabled && !row.hidden;
  });
  const weighted = enabledRows.map((row) => ({
    provider: row.dataset.mixedProvider,
    weight: Math.max(1, Number(row.querySelector(".mixed-provider-weight")?.value) || 1),
  }));
  if (priorityEnabled()) {
    const summary = document.getElementById("mixedWeightSummary");
    summary.textContent = localPriorityGroups.map((group, index) => {
      const eligibleIds = new Set(localPriorityGroups.slice(0, index + 1).map((item) => item.id));
      const eligible = weighted.filter((item) => eligibleIds.has(
        mixedRows().find((row) => row.dataset.mixedProvider === item.provider)?.querySelector(".mixed-provider-group")?.value
      ));
      const total = eligible.reduce((sum, item) => sum + item.weight, 0);
      const condition = index === 0 ? "默认" : group.afterCues == null ? "阈值待设置" : `超过 ${group.afterCues} 条`;
      return `${condition}：${eligible.length ? eligible.map((item) => `${MIXED_PROVIDER_LABELS[item.provider]} ${Math.round(item.weight / total * 100)}%`).join(" · ") : "无可用服务"}`;
    }).join("；");
    return;
  }
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  const summary = document.getElementById("mixedWeightSummary");
  if (!summary) return;
  summary.textContent = weighted.length === 0
    ? "尚未选择服务。"
    : `当前比例：${weighted.map((item) => `${MIXED_PROVIDER_LABELS[item.provider] || item.provider} ${Math.round(item.weight / total * 100)}%`).join(" · ")}`;
}

function loadMixedProviderUi(config) {
  localPriorityGroups = Array.isArray(config.mixedPriorityGroups) && config.mixedPriorityGroups.length
    ? config.mixedPriorityGroups.map((group) => ({ ...group }))
    : [{ id: "priority-1", afterCues: 0 }];
  document.getElementById("mixedPriorityEnabled").checked = config.mixedPriorityEnabled === true;
  renderMixedPriorityGroups();
  const saved = new Map((Array.isArray(config.mixedProviders) ? config.mixedProviders : []).map((item) => [item?.provider, item]));
  for (const row of mixedRows()) {
    const provider = row.dataset.mixedProvider;
    const item = saved.get(provider);
    const enabled = item ? item.enabled !== false : !Array.isArray(config.mixedProviders) &&
      Object.prototype.hasOwnProperty.call(DEFAULT_MIXED_WEIGHTS, provider);
    const weight = Math.max(1, Number(item?.weight ?? DEFAULT_MIXED_WEIGHTS[provider] ?? 20) || 1);
    row.querySelector(".mixed-provider-enabled").checked = enabled;
    row.querySelector(".mixed-provider-weight").value = String(weight);
    const groupSelect = row.querySelector(".mixed-provider-group");
    groupSelect.value = localPriorityGroups.some((group) => group.id === item?.priorityGroup)
      ? item.priorityGroup : localPriorityGroups[0].id;
    const keyInput = row.querySelector(".mixed-provider-key");
    if (keyInput) keyInput.value = localApiKeys[provider] || "";
  }
  renderMixedPriorityGroups();
  refreshMixedWeightSummary();
}

function readMixedProviders() {
  return mixedRows()
    .filter((row) => {
      const checkbox = row.querySelector(".mixed-provider-enabled");
      return checkbox?.checked && !checkbox.disabled && !row.hidden;
    })
    .map((row) => ({
      provider: row.dataset.mixedProvider,
      weight: Math.max(1, Math.min(100, Math.round(Number(row.querySelector(".mixed-provider-weight")?.value) || 1))),
      enabled: true,
      priorityGroup: row.querySelector(".mixed-provider-group")?.value || localPriorityGroups[0].id,
    }));
}

function stashMixedApiKeys() {
  for (const row of mixedRows()) {
    const keyInput = row.querySelector(".mixed-provider-key");
    if (keyInput) stashKey(localApiKeys, row.dataset.mixedProvider, keyInput.value);
  }
}

function syncMixedApiKeyInputs() {
  for (const row of mixedRows()) {
    const keyInput = row.querySelector(".mixed-provider-key");
    if (keyInput && document.activeElement !== keyInput) {
      keyInput.value = localApiKeys[row.dataset.mixedProvider] || "";
    }
  }
}

function refreshProviderUi() {
  const provider = document.getElementById("provider").value;
  const isKeyless = isKeylessProvider(provider);
  const apiKeyEl = document.getElementById("apiKey");
  const modelEl = document.getElementById("model");
  const providerHint = document.getElementById("providerHint");
  const apiKeyHint = document.getElementById("apiKeyHint");
  const endpointEl = document.getElementById("endpoint");
  const mixed = provider === "mixed";
  const customBackend = provider === "custom-backend" || (mixed && readMixedProviders().some((item) => item.provider === "custom-backend"));

  providerHint.textContent = providerHints[provider] || "";
  apiKeyHint.textContent = mixed
    ? "混合模式的各服务密钥在服务列表中分别填写，并继续只保存在浏览器本地。"
    : customBackend
    ? "自定义后端的鉴权和上游服务由后端自身管理，扩展不会向它附带已保存的 API Key。"
    : isKeyless
    ? provider === "argos"
      ? "Argos 不需要 API Key；会强制使用本地后端。请先安装 Argos 依赖和对应的 en→目标语言模型。"
      : "Google Translate 不需要 API Key；保存时会自动清空本地 API Key 字段。若翻译质量不理想，请切换到 AI/API 模型。"
    : "API Key 仅保存在 Chrome 本地 storage，用于请求你选择的翻译服务。";
  apiKeyEl.disabled = isKeyless;
  apiKeyEl.placeholder = isKeyless
    ? provider === "argos" ? "Argos 不需要 API Key" : "Google Translate 不需要 API Key"
    : "请输入你的 API Key";
  if (isKeyless) {
    apiKeyEl.value = "";
    apiKeyEl.dataset.forProvider = "";
  } else {
    apiKeyEl.value = localApiKeys[provider] || "";
    apiKeyEl.dataset.forProvider = provider;
  }
  const modelUnavailable = isKeyless || provider === "azure";
  modelEl.disabled = modelUnavailable;
  if (modelUnavailable) modelEl.value = "";
  const directFields = [
    ...document.querySelectorAll("[data-direct-provider-field]"),
    apiKeyEl,
    apiKeyHint,
    modelEl,
    endpointEl,
  ];
  for (const field of directFields) field.hidden = customBackend || mixed;
  const mixedSection = document.getElementById("mixedProviderSection");
  if (mixedSection) mixedSection.hidden = !mixed;
  const customSection = document.getElementById("customBackendSection");
  if (customSection) customSection.hidden = !customBackend;
  if (customBackend || mixed) {
    modelEl.value = "";
    endpointEl.value = "";
  }
  refreshAdvancedUi(provider);
  refreshMixedAvailability();
  renderMixedPriorityGroups();
  refreshMixedWeightSummary();
}

function refreshBuildUi() {
  const argosOption = document.querySelector('option[value="argos"]');
  if (argosOption) argosOption.disabled = !enableLocalBackend;
  const argosMixedRow = document.querySelector('[data-mixed-provider="argos"]');
  if (argosMixedRow) {
    argosMixedRow.hidden = !enableLocalBackend;
    const checkbox = argosMixedRow.querySelector(".mixed-provider-enabled");
    if (checkbox && !enableLocalBackend) checkbox.checked = false;
  }
}

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await extensionApi.storage.local.get(STORAGE_KEY);
  const { [API_KEYS_STORAGE_KEY]: separateKeys } = await extensionApi.storage.local.get(API_KEYS_STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
  localApiKeys = { ...buildKeyMap(config), ...(separateKeys || {}) };
  localProviderConfigs = { ...(config.providerConfigs || {}) };
  if (config.provider && config.provider !== "mixed") {
    localProviderConfigs[config.provider] = {
      model: config.model || "",
      endpoint: config.endpoint || "",
    };
  }
  const currentProvider = providerDefaults[config.provider] && (config.provider !== "argos" || enableLocalBackend)
    ? config.provider
    : defaultConfig.provider;
  const customBackendUrlEl = document.getElementById("customBackendUrl");
  if (customBackendUrlEl) {
    customBackendUrlEl.value = config.customBackendUrl ||
      (config.provider === "custom-backend" ? config.backendUrl : "") ||
      defaultConfig.customBackendUrl;
  }
  const apiKeyEl = document.getElementById("apiKey");
  apiKeyEl.value = isKeylessProvider(currentProvider) ? "" : (localApiKeys[currentProvider] || "");
  apiKeyEl.dataset.forProvider = isKeylessProvider(currentProvider) ? "" : currentProvider;
  document.getElementById("provider").value = currentProvider;
  document.getElementById("provider").dataset.previousProvider = currentProvider;
  document.getElementById("model").value = config.model;
  document.getElementById("endpoint").value = config.endpoint || "";
  const targetEl = document.getElementById("target");
  const storedTarget = (config.target || "ZH").toUpperCase();
  const targetValue = storedTarget === "CANTONESE" ? "YUE" : storedTarget;
  if ([...targetEl.options].some((o) => o.value === targetValue)) {
    targetEl.value = targetValue;
  } else {
    targetEl.value = "ZH";
  }
  setInputValue("maxParagraphs", String(config.maxParagraphs));
  setInputValue("maxChars", String(config.maxChars));
  setInputValue("concurrency", String(config.concurrency));
  setInputValue("rps", String(config.rps));
  setInputValue("retries", String(config.retries));
  setInputValue("timeout", String(config.timeout));
  setInputValue("fallbackMode", config.fallbackMode || defaultConfig.fallbackMode);
  setInputValue("repairConcurrency", String(config.repairConcurrency));
  setInputValue("slowSplitThreshold", String(config.slowSplitThreshold));
  setInputValue("reasoningEffort", config.reasoningEffort || "");
  setInputValue("deepseekThinkingMode", config.deepseekThinkingMode || defaultConfig.deepseekThinkingMode);
  setInputValue("deeplFormality", config.deeplFormality || "");
  setInputValue("azureRegion", config.azureRegion || "");
  setInputValue("appearance", config.appearance || "auto");
  const quickTranslateAutoExportEl = document.getElementById("quickTranslateAutoExport");
  if (quickTranslateAutoExportEl) quickTranslateAutoExportEl.checked = config.quickTranslateAutoExport === true;
  loadMixedProviderUi(config);
  applyAppearance(config.appearance || "auto");
  refreshProviderUi();
  refreshBuildUi();
}

function applyProviderDefaults() {
  // Save the outgoing provider's key before switching, and persist it right
  // away so it survives even if the user never clicks "保存设置".
  const apiKeyEl = document.getElementById("apiKey");
  const prevProvider = apiKeyEl.dataset.forProvider;
  stashKey(localApiKeys, prevProvider, apiKeyEl.value);
  const previousSelected = document.getElementById("provider").dataset.previousProvider;
  if (previousSelected && previousSelected !== "mixed" && previousSelected !== "custom-backend") {
    localProviderConfigs[previousSelected] = {
      model: document.getElementById("model").value.trim(),
      endpoint: document.getElementById("endpoint").value.trim(),
    };
  }
  const provider = document.getElementById("provider").value;
  const defaults = providerDefaults[provider] || providerDefaults.deepseek;
  const modelEl = document.getElementById("model");
  const endpointEl = document.getElementById("endpoint");
  // Model and endpoint belong to a provider as a pair. Carrying a custom
  // DeepSeek model/endpoint into OpenAI (or vice versa) creates a request that
  // is guaranteed to hit the wrong API contract. A deliberate provider
  // change therefore starts from that provider's known-safe defaults; users
  // can still enter a custom model/endpoint afterwards.
  const saved = localProviderConfigs[provider];
  modelEl.value = saved?.model ?? defaults.model;
  endpointEl.value = saved?.endpoint ?? defaults.endpoint;
  document.getElementById("provider").dataset.previousProvider = provider;
  refreshProviderUi();
  persistApiKeysOnly();
}

// Persists only the apiKeys map (merged with whatever else is currently
// stored) so a key typed for a provider isn't lost if the user switches
// providers without clicking "保存设置".
async function persistApiKeysOnly() {
  try {
    await extensionApi.storage.local.set({ [API_KEYS_STORAGE_KEY]: { ...localApiKeys } });
  } catch (error) {
    // A key switch is best-effort, but it must still be visible if browser
    // storage rejects it; otherwise the next translation fails mysteriously.
    const typed = typedOptionsError(error);
    console.error("[echo360-translator][options] API key persistence failed", globalThis.Echo360Error?.serializeError?.(typed, { phase: "preferences" }) || typed);
    showError(typed, { phase: "preferences", code: "STORAGE_ERROR" });
  }
}

// Keeps the options page in sync when the popup (or another options tab)
// changes the stored config, without clobbering a key the user is mid-typing.
function isEditingApiKey() {
  return document.activeElement === document.getElementById("apiKey");
}

function handleExternalConfigChange(newConfig) {
  if (!newConfig) return;
  localApiKeys = { ...localApiKeys, ...buildKeyMap(newConfig) };
  syncMixedApiKeyInputs();
  if (!isEditingApiKey()) refreshProviderUi();
}

extensionApi.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[API_KEYS_STORAGE_KEY]?.newValue) {
    localApiKeys = { ...localApiKeys, ...changes[API_KEYS_STORAGE_KEY].newValue };
    syncMixedApiKeyInputs();
  }
  if (changes[STORAGE_KEY]) handleExternalConfigChange(changes[STORAGE_KEY].newValue);
  else if (!isEditingApiKey()) refreshProviderUi();
});

function normalizeCustomBackendUrl(url) {
  try {
    const parsed = new URL(url);
    const { protocol, hostname: rawHostname } = parsed;
    const hostname = String(rawHostname || "").replace(/^\[|\]$/g, "").toLowerCase();
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    if ((protocol !== "https:" && !(protocol === "http:" && local)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function backendPermissionPattern(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}/*`;
}

async function saveConfig() {
  try {
    const provider = document.getElementById("provider").value;
    stashMixedApiKeys();
    const mixedProviders = readMixedProviders();
    if (provider === "mixed") validateMixedPriorityUi(mixedProviders);
    if (provider === "mixed" && mixedProviders.length < (priorityEnabled() ? 1 : 2)) {
      showError({
        code: "MIXED_PROVIDERS_REQUIRED",
        message: "混合翻译至少需要选择两个可用服务。",
      }, { phase: "preferences" });
      return;
    }
    const missingMixedKeys = provider === "mixed"
      ? mixedProviders
        .map((item) => item.provider)
        .filter((item) => !isKeylessProvider(item) && !String(localApiKeys[item] || "").trim())
      : [];
    if (missingMixedKeys.length > 0) {
      showError({
        code: "PROVIDER_API_KEY_MISSING",
        message: `请先填写这些混合翻译服务的 API Key：${missingMixedKeys.map((item) => MIXED_PROVIDER_LABELS[item] || item).join("、")}`,
      }, { phase: "preferences" });
      return;
    }
    const usesCustomBackend = provider === "custom-backend" ||
      (provider === "mixed" && mixedProviders.some((item) => item.provider === "custom-backend"));
    const customBackendUrl = normalizeCustomBackendUrl(
      document.getElementById("customBackendUrl")?.value.trim() || defaultConfig.customBackendUrl
    );
    if (usesCustomBackend && !customBackendUrl) {
      showError({
        code: "BACKEND_URL_INVALID",
        message: "自定义后端必须是本机 HTTP 地址或远程 HTTPS 地址，且不能包含账号、查询参数或片段。",
      }, { phase: "preferences" });
      return;
    }
    // Request exactly one origin while the Save click still carries a user
    // gesture. This avoids a blanket host permission for custom backends.
    if (usesCustomBackend) {
      const origins = [backendPermissionPattern(customBackendUrl)];
      const granted = await extensionApi.permissions.contains({ origins }) ||
        await extensionApi.permissions.request({ origins });
      if (!granted) {
        showError({ code: "BACKEND_PERMISSION_DENIED", message: "未获得访问该自定义后端地址的权限。" }, { phase: "preferences" });
        return;
      }
    }
    const { [STORAGE_KEY]: existingValue } = await extensionApi.storage.local.get(STORAGE_KEY);
    const existing = { ...defaultConfig, ...(existingValue || {}) };
    stashKey(localApiKeys, provider, document.getElementById("apiKey").value);
    if (provider !== "mixed" && provider !== "custom-backend") {
      localProviderConfigs[provider] = {
        model: document.getElementById("model").value.trim(),
        endpoint: document.getElementById("endpoint").value.trim(),
      };
    }
    // Merge in whatever is currently in storage in case it changed elsewhere
    // (e.g. the popup) more recently than our own onChanged listener caught up.
    const mergedKeys = { ...(existingValue?.apiKeys || {}), ...localApiKeys };
    const config = {
      customBackendUrl: customBackendUrl || existing.customBackendUrl || defaultConfig.customBackendUrl,
      ...resolveForSave(mergedKeys, provider),
      provider,
      mixedProviders,
      mixedPriorityEnabled: priorityEnabled(),
      mixedPriorityGroups: localPriorityGroups.map((group) => ({ ...group })),
      providerConfigs: { ...localProviderConfigs },
      model: isKeylessProvider(provider) || provider === "azure" ? "" : document.getElementById("model").value.trim(),
      endpoint: provider === "custom-backend" || provider === "mixed" ? "" : document.getElementById("endpoint").value.trim(),
      target: (document.getElementById("target").value || "ZH").toUpperCase(),
      maxParagraphs: getNumberValue("maxParagraphs", existing.maxParagraphs ?? defaultConfig.maxParagraphs, 1),
      maxChars: getNumberValue("maxChars", existing.maxChars ?? defaultConfig.maxChars, 100),
      concurrency: getNumberValue("concurrency", existing.concurrency ?? defaultConfig.concurrency, 1),
      rps: getNumberValue("rps", existing.rps ?? defaultConfig.rps, 0),
      retries: getNumberValue("retries", existing.retries ?? defaultConfig.retries, 0),
      timeout: getNumberValue("timeout", existing.timeout ?? defaultConfig.timeout, 1),
      reasoningEffort: provider === "openai"
        ? getInputValue("reasoningEffort", "")
        : existing.reasoningEffort || "",
      fallbackMode: getInputValue("fallbackMode", existing.fallbackMode || defaultConfig.fallbackMode) || defaultConfig.fallbackMode,
      repairConcurrency: getNumberValue("repairConcurrency", existing.repairConcurrency ?? defaultConfig.repairConcurrency, 1),
      slowSplitThreshold: getNumberValue("slowSplitThreshold", existing.slowSplitThreshold ?? defaultConfig.slowSplitThreshold, 0),
      deepseekThinkingMode: provider === "deepseek"
        ? getInputValue("deepseekThinkingMode", defaultConfig.deepseekThinkingMode)
        : existing.deepseekThinkingMode || defaultConfig.deepseekThinkingMode,
      deeplFormality: provider === "deepl"
        ? getInputValue("deeplFormality", "")
        : existing.deeplFormality || "",
      azureRegion: getInputValue("azureRegion", existing.azureRegion || defaultConfig.azureRegion).trim(),
      appearance: getInputValue("appearance", "auto") || "auto",
      quickTranslateAutoExport: document.getElementById("quickTranslateAutoExport")?.checked === true,
    };
    await extensionApi.storage.local.set({
      [STORAGE_KEY]: config,
      [API_KEYS_STORAGE_KEY]: { ...mergedKeys },
    });
    if (provider === "argos") {
      setStatus("设置已保存，正在启动 Argos 后端…");
      const response = await extensionApi.runtime.sendMessage({
        type: "ensure-argos-backend",
        backendUrl: "http://127.0.0.1:8765",
      });
      if (!response?.ok) {
        throw extensionApi.toError(response, "ARGOS_BACKEND_START_FAILED", "Argos 设置已保存，但后端启动失败");
      }
    }
    clearError();
    setStatus("已保存。请回到 Echo360 页面，点击“加载翻译字幕”。");
    setTimeout(() => {
      setStatus("");
    }, 1200);
  } catch (error) {
    showError(typedOptionsError(error), { phase: "preferences", code: "STORAGE_ERROR" });
  }
}

document.getElementById("provider").addEventListener("change", applyProviderDefaults);
document.getElementById("provider").dataset.previousProvider = document.getElementById("provider").value;
document.getElementById("mixedPriorityEnabled").addEventListener("change", () => {
  renderMixedPriorityGroups();
  refreshMixedWeightSummary();
});
document.getElementById("addMixedPriorityGroup").addEventListener("click", () => {
  if (localPriorityGroups.length >= 8) return;
  let id;
  do { id = `priority-${nextPriorityGroupId++}`; } while (localPriorityGroups.some((group) => group.id === id));
  localPriorityGroups.push({ id, afterCues: null });
  renderMixedPriorityGroups();
  refreshMixedWeightSummary();
  document.querySelector(".mixed-priority-group:last-child input")?.focus();
});
for (const row of mixedRows()) {
  row.querySelector(".mixed-provider-enabled")?.addEventListener("change", () => {
    refreshProviderUi();
    renderMixedPriorityGroups();
    refreshMixedWeightSummary();
  });
  row.querySelector(".mixed-provider-weight")?.addEventListener("input", refreshMixedWeightSummary);
  row.querySelector(".mixed-provider-key")?.addEventListener("change", (event) => {
    stashKey(localApiKeys, row.dataset.mixedProvider, event.target.value);
    persistApiKeysOnly();
  });
}
document.getElementById("apiKey").addEventListener("change", (event) => {
  // Fires on blur when the value changed; persists a typed key even if the
  // user navigates away instead of clicking "保存设置".
  const provider = event.target.dataset.forProvider;
  stashKey(localApiKeys, provider, event.target.value);
  persistApiKeysOnly();
});
document.getElementById("appearance").addEventListener("change", (event) => applyAppearance(event.target.value));
document.getElementById("target").addEventListener("change", () => {
  refreshMixedAvailability();
  renderMixedPriorityGroups();
  refreshMixedWeightSummary();
});
document.getElementById("saveBtn").addEventListener("click", saveConfig);
refreshBuildUi();
loadConfig().catch((err) => {
  showError(typedOptionsError(err), { phase: "preferences", code: "STORAGE_ERROR" });
});

document.querySelector(".error-card-copy")?.addEventListener("click", async (event) => {
  await errorPresenter.copyDiagnostics(event.currentTarget);
});
