import { afterEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

function chromeApiMock() {
  const store = { saved: 1 };
  return {
    runtime: {
      lastError: null,
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn((message, callback) => callback({ ok: true, message })),
      openOptionsPage: vi.fn((callback) => callback()),
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      create: vi.fn((properties, callback) => callback({ id: 7, ...properties })),
    },
    storage: {
      local: {
        get: vi.fn((key, callback) => callback({ [key]: store[key] })),
        set: vi.fn((items, callback) => { Object.assign(store, items); callback(); }),
        remove: vi.fn((key, callback) => { delete store[key]; callback(); }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
}

describe("shared WebExtension API adapter", () => {
  afterEach(() => {
    delete globalThis.chrome;
    delete globalThis.browser;
    delete globalThis.Echo360ExtensionApi;
    delete globalThis.Echo360Translator;
  });

  it("normalizes Chrome callback APIs, including popup-only tabs/options operations", async () => {
    globalThis.chrome = chromeApiMock();
    evalModule("browser_api.js");
    const api = globalThis.Echo360ExtensionApi;

    await expect(api.storage.local.get("saved")).resolves.toEqual({ saved: 1 });
    await expect(api.storage.local.set({ added: 2 })).resolves.toBeUndefined();
    await expect(api.runtime.openOptionsPage()).resolves.toBeUndefined();
    await expect(api.tabs.create({ url: api.runtime.getURL("options.html") })).resolves.toMatchObject({
      id: 7,
      url: "chrome-extension://test/options.html",
    });
  });

  it("preserves a specific nested diagnosis instead of a generic boundary code", () => {
    globalThis.chrome = chromeApiMock();
    evalModule("browser_api.js");

    const error = globalThis.Echo360ExtensionApi.toError({
      code: "RUNTIME_MESSAGE_ERROR",
      message: "provider rejected request",
      error_detail: { error_code: "HTTP_429" },
    }, "STORAGE_ERROR");

    expect(error.code).toBe("HTTP_429");
    expect(error.message).toBe("provider rejected request");
  });

  it("rejects unavailable optional tab operations with a typed error", async () => {
    globalThis.chrome = chromeApiMock();
    delete globalThis.chrome.tabs;
    evalModule("browser_api.js");

    await expect(globalThis.Echo360ExtensionApi.tabs.create({ url: "x" }))
      .rejects.toMatchObject({ code: "RUNTIME_MESSAGE_ERROR" });
  });
});
