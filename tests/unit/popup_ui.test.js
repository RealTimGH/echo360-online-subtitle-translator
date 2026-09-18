import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXT_DIR, evalModule } from "../helpers/load-module.js";

const STORAGE_KEY = "echo360TranslatorConfig";
const API_KEYS_STORAGE_KEY = "echo360TranslatorApiKeys";

function installPopupDocument() {
  const html = readFileSync(resolve(EXT_DIR, "popup.html"), "utf8");
  document.open();
  document.write(html);
  document.close();
}

async function flushPopupLoad() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

function popupConfig(overrides = {}) {
  return {
    provider: "mixed",
    model: "",
    endpoint: "",
    target: "ZH",
    mixedProviders: [
      { provider: "google-web", weight: 60, enabled: true, priorityGroup: "priority-1" },
      { provider: "argos", weight: 40, enabled: true, priorityGroup: "priority-1" },
    ],
    mixedPriorityEnabled: false,
    mixedPriorityGroups: [],
    ...overrides,
  };
}

function setupPopup(config, separateKeys = {}) {
  installPopupDocument();

  const stored = {
    [STORAGE_KEY]: config,
    [API_KEYS_STORAGE_KEY]: separateKeys,
  };
  const changeListeners = [];
  const storageSet = vi.fn(async (items) => Object.assign(stored, items));

  globalThis.Echo360BuildConfig = { enableLocalBackend: true };
  globalThis.Echo360Error = {
    normalizeError(errorLike) {
      return {
        code: errorLike?.code || "TEST_ERROR",
        title: "测试错误",
        summary: errorLike?.message || "error",
        recommendation: "重试",
        copyText: "test",
        details: [],
      };
    },
  };
  globalThis.Echo360ExtensionApi = {
    toError(errorLike, code) {
      const error = errorLike instanceof Error
        ? errorLike
        : new Error(errorLike?.message || String(errorLike));
      error.code = errorLike?.error_detail?.code || errorLike?.code || code;
      return error;
    },
    storage: {
      local: {
        get: vi.fn(async (key) => ({ [key]: stored[key] })),
        set: storageSet,
      },
      onChanged: {
        addListener: vi.fn((listener) => changeListeners.push(listener)),
      },
    },
    runtime: {
      openOptionsPage: vi.fn(() => Promise.resolve()),
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    tabs: {
      create: vi.fn(async () => ({})),
    },
  };

  delete globalThis.Echo360ConfigKeys;
  delete globalThis.Echo360PreferencesUi;
  evalModule("config_keys.js");
  evalModule("preferences_ui.js");
  evalModule("popup.js");

  return { stored, storageSet, changeListeners };
}

describe("popup mixed priority integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows one compatible provider when priority mode is enabled", async () => {
    const config = popupConfig({
      mixedPriorityEnabled: true,
      mixedPriorityGroups: [{ id: "priority-1", afterCues: 0 }],
      mixedProviders: [
        { provider: "google-web", weight: 100, enabled: true, priorityGroup: "priority-1" },
        { provider: "argos", weight: 0, enabled: false, priorityGroup: "priority-1" },
      ],
    });
    const { stored, storageSet } = setupPopup(config);
    await flushPopupLoad();

    document.getElementById("saveBtn").click();
    await flushPopupLoad();

    expect(storageSet).toHaveBeenCalledTimes(1);
    expect(stored[STORAGE_KEY]).toMatchObject({
      mixedPriorityEnabled: true,
      mixedPriorityGroups: [{ id: "priority-1", afterCues: 0 }],
    });
    expect(document.getElementById("status").textContent).toBe("已保存");
  });

  it("keeps the legacy minimum of two compatible providers when priority mode is disabled", async () => {
    const config = popupConfig({
      mixedPriorityEnabled: false,
      mixedPriorityGroups: [{ id: "priority-1", afterCues: 0 }],
      mixedProviders: [
        { provider: "google-web", weight: 100, enabled: true, priorityGroup: "priority-1" },
        { provider: "argos", weight: 0, enabled: false, priorityGroup: "priority-1" },
      ],
    });
    const { stored, storageSet } = setupPopup(config);
    const before = stored[STORAGE_KEY];
    await flushPopupLoad();

    document.getElementById("saveBtn").click();
    await flushPopupLoad();

    expect(storageSet).not.toHaveBeenCalled();
    expect(stored[STORAGE_KEY]).toBe(before);
    expect(document.getElementById("status").textContent).toBe("[MIXED_PROVIDERS_REQUIRED] 测试错误");
  });

  it("preserves ordered groups, cumulative thresholds, and provider membership on save", async () => {
    const groups = [
      { id: "priority-1", afterCues: 0 },
      { id: "priority-2", afterCues: 400 },
      { id: "priority-3", afterCues: 900 },
    ];
    const mixedProviders = [
      { provider: "google-web", weight: 60, enabled: true, priorityGroup: "priority-2" },
      { provider: "argos", weight: 25, enabled: true, priorityGroup: "priority-1" },
      { provider: "deepl", weight: 15, enabled: true, priorityGroup: "priority-3" },
    ];
    const config = popupConfig({
      mixedPriorityEnabled: true,
      mixedPriorityGroups: groups,
      mixedProviders,
    });
    const { stored, storageSet } = setupPopup(config, { deepl: "deepl-key" });
    await flushPopupLoad();

    document.getElementById("saveBtn").click();
    await flushPopupLoad();

    expect(storageSet).toHaveBeenCalledTimes(1);
    expect(stored[STORAGE_KEY].mixedPriorityGroups).toEqual(groups);
    expect(stored[STORAGE_KEY].mixedProviders).toEqual(mixedProviders);
  });
});
