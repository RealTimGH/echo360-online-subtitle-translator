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
  beforeEach(async () => {
    vi.restoreAllMocks();
    installOptionsDocument();

    const stored = {
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

  it("forces the local backend and clears key fields when Argos is selected", () => {
    const provider = document.getElementById("provider");
    provider.value = "argos";
    provider.dispatchEvent(new Event("change", { bubbles: true }));

    expect(document.getElementById("useLocalBackend").checked).toBe(true);
    expect(document.getElementById("useLocalBackend").disabled).toBe(true);
    expect(document.getElementById("apiKey").disabled).toBe(true);
    expect(document.getElementById("model").value).toBe("");
    expect(document.getElementById("endpoint").value).toBe("");
  });
});
