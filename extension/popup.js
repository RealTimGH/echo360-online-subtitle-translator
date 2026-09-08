const STORAGE_KEY = "echo360TranslatorConfig";
const buildConfig = globalThis.Echo360BuildConfig || {};
const enableLocalBackend = buildConfig.enableLocalBackend !== false;
const { DEFAULT_CONFIG: defaultConfig, createModelPresets, createErrorPresenter } =
  globalThis.Echo360PreferencesUi;
const modelPresets = createModelPresets({ includeLocalOnly: enableLocalBackend });
const { isKeylessProvider, buildKeyMap, stashKey, resolveForSave } = globalThis.Echo360ConfigKeys;
const providerHints = {
  "google-web": "免费、无需 API Key，适合先试用；质量通常不如 AI/API 模型。",
  deepseek: "需要 DeepSeek API Key，适合更高质量字幕翻译；Thinking 默认关闭。",
  gemini: "需要 Gemini API Key，适合更高质量字幕翻译。",
  openai: "需要 OpenAI API Key，适合更高质量字幕翻译。",
  deepl: "需要 DeepL API Key，适合常规机器翻译。",
  argos: "本机离线翻译，无需 API Key；使用英语源字幕并需要本地后端和已安装模型。"
};

const extensionApi = globalThis.Echo360ExtensionApi;
const errorPresenter = createErrorPresenter({ surface: "popup" });
const typedPopupError = (errorLike, code = "STORAGE_ERROR") => errorPresenter.typed(errorLike, code);
const clearError = () => errorPresenter.clear();
const showError = (error, context = {}) => errorPresenter.show(error, context);
const storageGet = (key) => extensionApi.storage.local.get(key);
const storageSet = (items) => extensionApi.storage.local.set(items);

function presetValue(preset) {
  return `${preset.provider}|${preset.model}|${preset.endpoint}`;
}

function findPreset(config) {
  return modelPresets.find((preset) =>
    preset.provider === config.provider &&
    preset.model === (config.model || "") &&
    preset.endpoint === (config.endpoint || "")
  );
}

function ensurePresetOption(config) {
  if (config.provider === "argos" && !enableLocalBackend) {
    config.provider = defaultConfig.provider;
    config.model = defaultConfig.model;
    config.endpoint = defaultConfig.endpoint;
  }
  if (isKeylessProvider(config.provider)) {
    config.model = "";
    config.endpoint = "";
  }
  const existing = findPreset(config);
  if (existing) return existing;
  const provider = config.provider || defaultConfig.provider;
  const model = config.model || "";
  const endpoint = config.endpoint || "";
  const label = model ? `${provider} - ${model}` : provider;
  const custom = { provider, model, endpoint, label };
  modelPresets.push(custom);
  return custom;
}

function renderModelOptions(selectedPreset) {
  const select = document.getElementById("modelPreset");
  select.innerHTML = "";
  for (const preset of modelPresets) {
    const option = document.createElement("option");
    option.value = presetValue(preset);
    option.textContent = preset.label;
    select.appendChild(option);
  }
  select.value = presetValue(selectedPreset);
}

function selectedProvider() {
  return document.getElementById("modelPreset").value.split("|")[0] || defaultConfig.provider;
}

// In-memory map of provider → API key, populated on load and updated on switch.
// Lets users switch providers freely without losing each key they've typed.
let localApiKeys = {};

function refreshProviderUi() {
  const provider = selectedProvider();
  const isKeyless = isKeylessProvider(provider);
  const apiKeyEl = document.getElementById("apiKey");
  document.getElementById("providerHint").textContent = providerHints[provider] || "";
  document.getElementById("apiKeyHint").textContent = isKeyless
    ? provider === "argos"
      ? "Argos 不需要 API Key；会使用本机后端和已安装的离线模型。"
      : "Google Translate 不需要 API Key；如果翻译质量不理想，请切换到 AI/API 模型。"
    : "API Key 只保存在 Chrome 本地 storage。";
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
}

async function loadConfig() {
  const { [STORAGE_KEY]: value } = await storageGet(STORAGE_KEY);
  const config = { ...defaultConfig, ...(value || {}) };
  localApiKeys = buildKeyMap(config);
  const selectedPreset = ensurePresetOption(config);
  renderModelOptions(selectedPreset);
  refreshProviderUi();
}

// Persists only the apiKeys map (merged with whatever else is currently
// stored) so a key typed for a provider isn't lost if the user switches
// providers or closes the popup without clicking "保存".
async function persistApiKeysOnly() {
  try {
    const { [STORAGE_KEY]: value } = await storageGet(STORAGE_KEY);
    const merged = { ...defaultConfig, ...(value || {}), apiKeys: { ...(value?.apiKeys || {}), ...localApiKeys } };
    await storageSet({ [STORAGE_KEY]: merged });
  } catch (error) {
    const typed = typedPopupError(error);
    console.error("[echo360-translator][popup] API key persistence failed", globalThis.Echo360Error?.serializeError?.(typed, { phase: "preferences" }) || typed);
    showError(typed, { phase: "preferences", code: "STORAGE_ERROR" });
  }
}

// Keeps the popup in sync when the options page (or another popup instance)
// changes the stored config, without clobbering a key the user is mid-typing.
function isEditingApiKey() {
  return document.activeElement === document.getElementById("apiKey");
}

function handleExternalConfigChange(newConfig) {
  if (!newConfig) return;
  localApiKeys = buildKeyMap(newConfig);
  if (!isEditingApiKey()) refreshProviderUi();
}

extensionApi.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  handleExternalConfigChange(changes[STORAGE_KEY].newValue);
});

function openOptionsPage() {
  try {
    const result = extensionApi.runtime.openOptionsPage();
    if (result) {
      if (result && typeof result.catch === "function") result.catch((error) => showError(typedPopupError(error, "RUNTIME_MESSAGE_ERROR"), { phase: "preferences" }));
      return;
    }
    const fallback = extensionApi.tabs.create({ url: extensionApi.runtime.getURL("options.html") });
    if (fallback && typeof fallback.catch === "function") fallback.catch((error) => showError(typedPopupError(error, "RUNTIME_MESSAGE_ERROR"), { phase: "preferences" }));
  } catch (error) {
    showError(typedPopupError(error, "RUNTIME_MESSAGE_ERROR"), { phase: "preferences" });
  }
}

async function saveConfig() {
  const status = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");
  saveBtn.disabled = true;
  status.textContent = "";
  clearError();

  try {
    const { [STORAGE_KEY]: value } = await storageGet(STORAGE_KEY);
    const [provider, model, endpoint] = document.getElementById("modelPreset").value.split("|");
    stashKey(localApiKeys, provider, document.getElementById("apiKey").value);
    // Merge in whatever is currently in storage in case it changed elsewhere
    // (e.g. the options page) more recently than our own onChanged listener caught up.
    const mergedKeys = { ...(value?.apiKeys || {}), ...localApiKeys };
    const config = {
      ...defaultConfig,
      ...(value || {}),
      provider,
      model,
      endpoint,
      ...resolveForSave(mergedKeys, provider),
      useLocalBackend: enableLocalBackend && (provider === "argos" || !!(value || {}).useLocalBackend),
    };
    await storageSet({ [STORAGE_KEY]: config });
    if (provider === "argos") {
      status.textContent = "设置已保存，正在启动 Argos 后端…";
      const response = await extensionApi.runtime.sendMessage({
        type: "ensure-argos-backend",
        backendUrl: config.backendUrl,
      });
      if (!response?.ok) {
        throw extensionApi.toError(response, "ARGOS_BACKEND_START_FAILED", "Argos 设置已保存，但后端启动失败");
      }
    }
    status.textContent = "已保存";
    status.classList.remove("error");
  } catch (err) {
    showError(err, { phase: "preferences", code: "STORAGE_ERROR" });
  } finally {
    saveBtn.disabled = false;
  }
}

document.getElementById("saveBtn").addEventListener("click", saveConfig);
document.getElementById("optionsBtn").addEventListener("click", openOptionsPage);
document.querySelector(".error-card-copy").addEventListener("click", async (event) => {
  await errorPresenter.copyDiagnostics(event.currentTarget);
});
document.getElementById("modelPreset").addEventListener("change", () => {
  // Before switching, stash whatever the user typed for the previous provider
  // and persist it immediately so it survives even without an explicit save.
  const apiKeyEl = document.getElementById("apiKey");
  const prevProvider = apiKeyEl.dataset.forProvider;
  stashKey(localApiKeys, prevProvider, apiKeyEl.value);
  refreshProviderUi();
  persistApiKeysOnly();
});
document.getElementById("apiKey").addEventListener("change", (event) => {
  // Fires on blur when the value changed; persists a typed key even if the
  // user closes the popup instead of clicking "保存".
  const provider = event.target.dataset.forProvider;
  stashKey(localApiKeys, provider, event.target.value);
  persistApiKeysOnly();
});
loadConfig().catch((err) => {
  showError(typedPopupError(err), { phase: "preferences", code: "STORAGE_ERROR" });
});
