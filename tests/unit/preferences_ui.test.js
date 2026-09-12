import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

function renderErrorCard() {
  document.body.innerHTML = `
    <div id="status" role="status" aria-live="polite"></div>
    <section id="errorDetails" hidden>
      <div id="errorAnnouncement">
        <div class="error-card-title"></div>
        <div class="error-card-summary"></div>
        <div class="error-card-recommendation"></div>
      </div>
      <pre></pre>
    </section>
  `;
}

describe("shared preferences UI", () => {
  beforeEach(() => {
    delete globalThis.Echo360PreferencesUi;
    globalThis.Echo360ExtensionApi = {
      toError(errorLike, code) {
        const error = errorLike instanceof Error ? errorLike : new Error(errorLike?.message || String(errorLike));
        error.code = errorLike?.error_detail?.code || errorLike?.code || code;
        return error;
      },
    };
    globalThis.Echo360Error = {
      normalizeError(error) {
        return {
          code: error.code,
          title: "测试错误",
          summary: error.message,
          recommendation: "重试",
          copyText: `copy:${error.code}`,
          details: [{ label: "错误码", value: error.code }],
        };
      },
    };
    renderErrorCard();
    evalModule("preferences_ui.js");
  });

  it("provides one immutable default configuration for popup and options", () => {
    const { DEFAULT_CONFIG, PROVIDER_DEFAULTS, createModelPresets } = globalThis.Echo360PreferencesUi;
    expect(DEFAULT_CONFIG).toMatchObject({
      provider: "google-web",
      concurrency: 96,
      rps: 0,
      fallbackMode: "immediate",
    });
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(PROVIDER_DEFAULTS.openai.model).toBe("gpt-5-nano");
    expect(createModelPresets().map((item) => item.provider)).toEqual([
      "google-web", "deepseek", "gemini", "openai", "deepl", "azure", "argos", "custom-backend",
    ]);
    expect(createModelPresets({ includeLocalOnly: false }).map((item) => item.provider)).not.toContain("argos");
    expect(createModelPresets({ includeLocalOnly: false }).map((item) => item.provider)).toContain("custom-backend");
  });

  it("uses the shared extension adapter to preserve a specific nested error code", () => {
    const presenter = globalThis.Echo360PreferencesUi.createErrorPresenter({ surface: "test" });
    const error = presenter.typed({
      code: "STORAGE_ERROR",
      message: "rate limited",
      error_detail: { code: "HTTP_429" },
    });
    expect(error).toMatchObject({ code: "HTTP_429", phase: "preferences" });
  });

  it("renders and clears the same accessible diagnostic card on both settings surfaces", () => {
    const presenter = globalThis.Echo360PreferencesUi.createErrorPresenter({ surface: "test" });
    presenter.show(Object.assign(new Error("boom"), { code: "HTTP_503" }));

    expect(document.getElementById("status").textContent).toBe("[HTTP_503] 测试错误");
    expect(document.getElementById("status").getAttribute("aria-live")).toBe("off");
    expect(document.getElementById("errorAnnouncement").getAttribute("role")).toBe("alert");
    expect(document.getElementById("errorDetails").hidden).toBe(false);
    expect(document.querySelector("#errorDetails pre").textContent).toBe("错误码: HTTP_503");

    presenter.clear();
    expect(document.getElementById("errorDetails").hidden).toBe(true);
    expect(document.getElementById("status").classList.contains("error")).toBe(false);
    expect(presenter.currentModel).toBeNull();
  });

  it("copies the currently rendered diagnostic through one shared implementation", async () => {
    const writeText = vi.fn(async () => {});
    const presenter = globalThis.Echo360PreferencesUi.createErrorPresenter({
      surface: "test",
      clipboard: { writeText },
      resetDelay: -1,
    });
    presenter.show(Object.assign(new Error("boom"), { code: "HTTP_429" }));
    const button = document.createElement("button");

    await expect(presenter.copyDiagnostics(button)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("copy:HTTP_429");
    expect(button.textContent).toBe("已复制");
  });
});
