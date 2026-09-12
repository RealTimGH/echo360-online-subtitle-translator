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
});
