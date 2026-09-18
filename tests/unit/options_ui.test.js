import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXT_DIR, evalModule } from "../helpers/load-module.js";

function installOptionsDocument() {
  const html = readFileSync(resolve(EXT_DIR, "options.html"), "utf8");
  document.open();
  document.write(html);
  document.close();
}

async function flushAsyncLoad() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe("options page provider and fallback controls", () => {
  let stored;
  let permissions;

  beforeEach(async () => {
    vi.restoreAllMocks();
    installOptionsDocument();

    stored = {
      echo360TranslatorConfig: {
        provider: "deepseek",
        model: "custom-deepseek-model",
        endpoint: "https://deepseek-proxy.example/v1/chat/completions",
        target: "ZH",
        apiKey: "deepseek-key",
        apiKeys: { deepseek: "deepseek-key" },
        reasoningEffort: "medium",
        deepseekThinkingMode: "disabled",
        deeplFormality: "more",
      },
    };
    const changeListeners = [];
    globalThis.Echo360BuildConfig = { enableLocalBackend: true };
    globalThis.Echo360ExtensionApi = {
      permissions: {
        contains: vi.fn(async () => false),
        request: vi.fn(async () => true),
      },
      runtime: {
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      storage: {
        local: {
          get: vi.fn(async (key) => ({ [key]: stored[key] })),
          set: vi.fn(async (items) => Object.assign(stored, items)),
        },
        onChanged: {
          addListener: vi.fn((listener) => changeListeners.push(listener)),
        },
      },
    };
    permissions = globalThis.Echo360ExtensionApi.permissions;
    globalThis.Echo360Error = {
      normalizeError(error) {
        return {
          code: error?.code || "TEST_ERROR",
          title: "测试错误",
          summary: error?.message || "error",
          recommendation: "重试",
          copyText: "test",
          details: [],
        };
      },
    };
    delete globalThis.Echo360ConfigKeys;
    delete globalThis.Echo360PreferencesUi;
    evalModule("config_keys.js");
    evalModule("preferences_ui.js");
    evalModule("options.js");
    await flushAsyncLoad();
  });

  it("resets model and endpoint as an atomic provider-specific pair", () => {
    const provider = document.getElementById("provider");
    expect(document.getElementById("model").value).toBe("custom-deepseek-model");
    expect(document.getElementById("endpoint").value).toContain("deepseek-proxy.example");

    provider.value = "openai";
    provider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.getElementById("model").value).toBe("gpt-5-nano");
    expect(document.getElementById("endpoint").value).toBe("");
  });

  it("only offers fallback modes accepted by the translation runtime", () => {
    const values = [...document.getElementById("fallbackMode").options].map((option) => option.value);
    expect(values).toEqual(["immediate", "deferred", "deferred-fastpath"]);
  });

  it("keeps one-click AI material export disabled by default and persists an explicit opt-in", async () => {
    const toggle = document.getElementById("quickTranslateAutoExport");
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    await flushAsyncLoad();

    expect(stored.echo360TranslatorConfig.quickTranslateAutoExport).toBe(true);
  });

  it("shows and saves the optional Azure region while keeping Model disabled", async () => {
    const provider = document.getElementById("provider");
    provider.value = "azure";
    provider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.querySelector('[data-provider-advanced="azure"]').hidden).toBe(false);
    expect(document.getElementById("model").disabled).toBe(true);
    document.getElementById("apiKey").value = "azure-key";
    document.getElementById("azureRegion").value = " australiaeast ";
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    await flushAsyncLoad();

    expect(stored.echo360TranslatorConfig).toMatchObject({
      provider: "azure",
      apiKey: "azure-key",
      azureRegion: "australiaeast",
      model: "",
      endpoint: "",
    });
  });

  it("selects Argos without exposing a generic local-backend switch", () => {
    const provider = document.getElementById("provider");
    provider.value = "argos";
    provider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.getElementById("useLocalBackend")).toBeNull();
    expect(document.getElementById("customBackendSection").hidden).toBe(true);
    expect(document.getElementById("apiKey").disabled).toBe(true);
    expect(document.getElementById("model").value).toBe("");
    expect(document.getElementById("endpoint").value).toBe("");
  });

  it("shows the backend URL only for the explicit custom-backend provider", () => {
    const provider = document.getElementById("provider");
    provider.value = "custom-backend";
    provider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.getElementById("customBackendSection").hidden).toBe(false);
    expect(document.getElementById("apiKey").hidden).toBe(true);
    expect(document.getElementById("model").hidden).toBe(true);
    expect(document.getElementById("endpoint").hidden).toBe(true);
  });

  it("requests only the configured custom-backend origin and saves provider-owned routing", async () => {
    const provider = document.getElementById("provider");
    provider.value = "custom-backend";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("customBackendUrl").value = "https://translator.example/api/";

    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    await flushAsyncLoad();

    expect(permissions.contains).toHaveBeenCalledWith({ origins: ["https://translator.example/*"] });
    expect(permissions.request).toHaveBeenCalledWith({ origins: ["https://translator.example/*"] });
    expect(stored.echo360TranslatorConfig).toMatchObject({
      provider: "custom-backend",
      customBackendUrl: "https://translator.example/api",
      apiKey: "",
      model: "",
      endpoint: "",
    });
  });

  it("configures mixed providers with independent weights and API keys", async () => {
    const provider = document.getElementById("provider");
    provider.value = "mixed";
    provider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.getElementById("mixedProviderSection").hidden).toBe(false);
    expect(document.getElementById("apiKey").hidden).toBe(true);
    const deeplRow = document.querySelector('[data-mixed-provider="deepl"]');
    deeplRow.querySelector(".mixed-provider-enabled").checked = true;
    deeplRow.querySelector(".mixed-provider-weight").value = "30";
    deeplRow.querySelector(".mixed-provider-key").value = "deepl-mix-key";

    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    await flushAsyncLoad();

    expect(stored.echo360TranslatorConfig.provider).toBe("mixed");
    expect(stored.echo360TranslatorConfig.mixedProviders).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "google-web", weight: 60 }),
      expect.objectContaining({ provider: "argos", weight: 40 }),
      expect.objectContaining({ provider: "deepl", weight: 30 }),
    ]));
    expect(stored.echo360TranslatorApiKeys.deepl).toBe("deepl-mix-key");
    expect(stored.echo360TranslatorConfig).toMatchObject({
      reasoningEffort: "medium",
      deepseekThinkingMode: "disabled",
      deeplFormality: "more",
    });
  });

  it("does not save a mixed configuration when an enabled provider is missing its key", async () => {
    const provider = document.getElementById("provider");
    provider.value = "mixed";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    const openaiRow = document.querySelector('[data-mixed-provider="openai"]');
    openaiRow.querySelector(".mixed-provider-enabled").checked = true;
    openaiRow.querySelector(".mixed-provider-key").value = "";
    const priorConfig = stored.echo360TranslatorConfig;

    document.getElementById("saveBtn").click();
    await flushAsyncLoad();

    expect(stored.echo360TranslatorConfig).toBe(priorConfig);
    expect(document.querySelector(".error-card-summary").textContent).toContain("OpenAI");
  });

  function changeValue(selector, value, event = "change") {
    const input = document.querySelector(selector);
    if (input.type === "checkbox") input.checked = value;
    else input.value = value;
    input.dispatchEvent(new Event(event, { bubbles: true }));
  }

  function enablePriority() {
    changeValue("#provider", "mixed");
    changeValue("#mixedPriorityEnabled", true);
  }

  function addSecondGroup(threshold = "500") {
    document.getElementById("addMixedPriorityGroup").click();
    const id = document.querySelector(".mixed-priority-group:last-child").dataset.priorityGroup;
    changeValue('[data-mixed-provider="argos"] .mixed-provider-group', id);
    changeValue(".mixed-priority-threshold", threshold, "input");
    return id;
  }

  it("keeps priority optional and saves a single-provider first tier with cumulative thresholds", async () => {
    expect(document.getElementById("mixedPriorityEnabled").checked).toBe(false);
    expect(document.getElementById("mixedPriorityEditor").hidden).toBe(true);
    enablePriority();
    const second = addSecondGroup();
    expect(document.getElementById("mixedWeightSummary").textContent).toContain("默认：Google Translate 100%");
    expect(document.getElementById("mixedWeightSummary").textContent).toContain("超过 500 条：Google Translate 60% · Argos（本地） 40%");
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig).toMatchObject({
      mixedPriorityEnabled: true,
      mixedPriorityGroups: [{ id: "priority-1", afterCues: 0 }, { id: second, afterCues: 500 }],
      mixedProviders: [
        { provider: "google-web", priorityGroup: "priority-1" },
        { provider: "argos", priorityGroup: second },
      ],
    });
    // Exercise the actual page reload, including group membership restoration.
    evalModule("options.js");
    await flushAsyncLoad();
    expect(document.querySelector('[data-mixed-provider="argos"] .mixed-provider-group').value).toBe(second);
    expect(document.querySelector(".mixed-priority-threshold").value).toBe("500");
  });

  it("moves whole groups while keeping thresholds attached to levels", async () => {
    enablePriority();
    const second = addSecondGroup();
    document.querySelector('.mixed-priority-group:last-child [data-move="-1"]').click();
    expect(document.querySelector(".mixed-priority-group").dataset.priorityGroup).toBe(second);
    expect(document.querySelector(".mixed-priority-threshold").value).toBe("500");
    expect(document.querySelector('[data-mixed-provider="argos"] .mixed-provider-group').value).toBe(second);
    expect(document.getElementById("mixedWeightSummary").textContent).toContain("默认：Argos（本地） 100%");
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig.mixedPriorityGroups).toEqual([
      { id: second, afterCues: 0 }, { id: "priority-1", afterCues: 500 },
    ]);
  });

  it.each(["", "0", "-1", "1.5", "9007199254740992"])("rejects invalid threshold %s without saving", async (threshold) => {
    enablePriority();
    addSecondGroup(threshold);
    const before = stored.echo360TranslatorConfig;
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig).toBe(before);
    expect(document.querySelector(".error-card-summary").textContent).toContain("阈值");
  });

  it("rejects an empty group and permits deleting it after its members are reassigned", async () => {
    enablePriority();
    const second = addSecondGroup();
    expect(document.querySelector(".mixed-priority-group:last-child [data-remove-group]").disabled).toBe(true);
    changeValue('[data-mixed-provider="argos"] .mixed-provider-group', "priority-1");
    const before = stored.echo360TranslatorConfig;
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig).toBe(before);
    expect(document.querySelector(".error-card-summary").textContent).toContain("第 2 级至少需要");
    document.querySelector(`[data-remove-group="${second}"]`).click();
    expect(document.querySelectorAll(".mixed-priority-group")).toHaveLength(1);
  });

  it("allows a single selected provider only with priorities enabled", async () => {
    enablePriority();
    changeValue('[data-mixed-provider="argos"] .mixed-provider-enabled', false);
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig.mixedProviders).toHaveLength(1);
    evalModule("options.js");
    await flushAsyncLoad();
    expect(document.querySelector('[data-mixed-provider="argos"] .mixed-provider-enabled').checked).toBe(false);
    expect(document.querySelector('[data-mixed-provider="google-web"] .mixed-provider-enabled').checked).toBe(true);
    changeValue("#mixedPriorityEnabled", false);
    const before = stored.echo360TranslatorConfig;
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig).toBe(before);
    expect(document.querySelector(".error-card-summary").textContent).toContain("至少需要选择两个");
  });

  it("preserves tier settings while disabled and skips dormant threshold validation", async () => {
    enablePriority();
    const second = addSecondGroup("");
    changeValue("#mixedPriorityEnabled", false);
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig.mixedPriorityEnabled).toBe(false);
    expect(stored.echo360TranslatorConfig.mixedPriorityGroups[1]).toEqual({ id: second, afterCues: null });
    expect(document.getElementById("mixedWeightSummary").textContent).toContain("当前比例：");
  });

  it("blocks an incompatible first tier instead of promoting a later tier", async () => {
    enablePriority();
    addSecondGroup();
    document.querySelector('.mixed-priority-group:last-child [data-move="-1"]').click();
    changeValue("#target", "EN");
    const before = stored.echo360TranslatorConfig;
    document.getElementById("saveBtn").click();
    await flushAsyncLoad();
    expect(stored.echo360TranslatorConfig).toBe(before);
    expect(document.querySelector(".error-card-summary").textContent).toContain("第 1 级至少需要");
    expect(document.querySelector(".mixed-priority-group").textContent).toContain("当前不可用");
  });

});
