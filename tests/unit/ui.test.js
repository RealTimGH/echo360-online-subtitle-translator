import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUiModules, makeFullNs } from "../helpers/load-module.js";

function setupUi(initialPrefs) {
  Object.defineProperty(window, "location", {
    value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
    configurable: true,
    writable: true,
  });
  document.body.innerHTML = "";
  document.head.innerHTML = "";

  window.Echo360Translator = makeFullNs({
    storage: {
      getPrefs: vi.fn(async () => initialPrefs),
      getConfig: vi.fn(async () => ({ target: "ZH" })),
      getOnboardingSeen: vi.fn(async () => false),
      setOnboardingSeen: vi.fn(async () => {}),
    },
  });
  loadUiModules();
  window.Echo360Translator.ui.ensurePanel({ onPrefsChanged: vi.fn() });
}

async function openSettings() {
  document.getElementById("echo360-translator-settings-btn").click();
  await Promise.resolve();
}

function changeCheckbox(id, checked) {
  const input = document.getElementById(id);
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}

describe("settings popover render mode controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an accessible warning icon beside the native CC Beta option", async () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });
    await openSettings();

    const noticeIcon = document.querySelector(".echo360-beta-notice-icon");
    const noticeTip = document.getElementById("echo360-beta-notice-tip");
    expect(noticeIcon).not.toBeNull();
    expect(noticeTip).not.toBeNull();
    expect(noticeIcon.getAttribute("role")).toBe("img");
    expect(noticeIcon.getAttribute("aria-label")).toContain("开启须知");
    expect(noticeIcon.getAttribute("aria-describedby")).toBe("echo360-beta-notice-tip");
    expect(noticeIcon.hasAttribute("title")).toBe(false);
    expect(noticeTip.getAttribute("role")).toBe("tooltip");
    expect(noticeTip.textContent).toContain("倍速播放时仍可能漏译");
  });

  it("moves focus into settings and supports close/Escape with focus restoration", async () => {
    setupUi({
      enabled: true,
      transcriptPanelEnabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    const trigger = document.getElementById("echo360-translator-settings-btn");
    trigger.focus();
    await openSettings();

    const dialog = document.getElementById("echo360-translator-popover");
    const close = dialog.querySelector(".echo360-popover-close");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("echo360-popover-title");
    expect(document.activeElement).toBe(close);

    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog.style.display).toBe("none");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    await openSettings();
    close.click();
    expect(dialog.style.display).toBe("none");
    expect(document.activeElement).toBe(trigger);
  });

  it("requires a second click before clearing cache and re-translating", () => {
    setupUi({
      enabled: true,
      transcriptPanelEnabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });
    const handler = vi.fn();
    window.Echo360Translator.ui.ensurePanel({ onForceTranslate: handler });
    const force = document.getElementById("echo360-translator-force-btn");

    force.click();
    expect(handler).not.toHaveBeenCalled();
    expect(force.textContent).toBe("再次点击确认");
    expect(document.getElementById("echo360-status-text").textContent).toContain("API 费用");

    force.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(force.textContent).toBe("重新翻译");
  });

  it("restores browser subtitle checkboxes after toggling into Echo360 native CC Beta and back", async () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: true,
      browserBilingual: false,
      browserReverseOrder: true,
      useNativeSubtitles: true,
      size: "medium",
    });
    await openSettings();

    const bilingual = document.getElementById("echo360-pref-bilingual");
    const reverseOrder = document.getElementById("echo360-pref-reverse");
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.disabled).toBe(false);
    expect(reverseOrder.disabled).toBe(false);

    // Check "使用原生 CC 注入（Beta）" → native CC mode; browser-mode controls
    // become disabled but keep showing their last known values.
    changeCheckbox("echo360-pref-echo360-native-cc", true);
    expect(bilingual.disabled).toBe(true);
    expect(reverseOrder.disabled).toBe(true);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.style.opacity).toBe("0.45");
    expect(reverseOrder.style.cursor).toBe("not-allowed");
    expect(document.getElementById("echo360-pref-size").style.filter).toBe("grayscale(1)");

    // Uncheck it → back to browser track; controls re-enabled with the same
    // restored values.
    changeCheckbox("echo360-pref-echo360-native-cc", false);
    expect(bilingual.disabled).toBe(false);
    expect(reverseOrder.disabled).toBe(false);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(true);
    expect(bilingual.style.opacity).toBe("");
    expect(reverseOrder.style.cursor).toBe("");
    expect(document.getElementById("echo360-pref-size").style.filter).toBe("");
  });

  it("readPanelPrefs saves native CC effective values separately from browser subtitle prefs", async () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: true,
      browserBilingual: false,
      browserReverseOrder: true,
      useNativeSubtitles: true,
      size: "medium",
    });
    await openSettings();

    // Check "使用原生 CC 注入（Beta）" → switch into native CC mode.
    changeCheckbox("echo360-pref-echo360-native-cc", true);
    const prefs = window.Echo360Translator.ui.readPanelPrefs();

    expect(prefs.useNativeSubtitles).toBe(false);
    expect(prefs.bilingual).toBe(true);
    expect(prefs.reverseOrder).toBe(false);
    expect(prefs.browserBilingual).toBe(false);
    expect(prefs.browserReverseOrder).toBe(true);
  });

  it("shows saved browser subtitle checkbox states and disables them when Echo360 native CC Beta is active", async () => {
    setupUi({
      enabled: true,
      bilingual: true,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: false,
      size: "large",
    });
    await openSettings();

    const nativeCcBeta = document.getElementById("echo360-pref-echo360-native-cc");
    const bilingual = document.getElementById("echo360-pref-bilingual");
    const reverseOrder = document.getElementById("echo360-pref-reverse");

    expect(nativeCcBeta.checked).toBe(true);
    expect(bilingual.disabled).toBe(true);
    expect(reverseOrder.disabled).toBe(true);
    expect(bilingual.checked).toBe(false);
    expect(reverseOrder.checked).toBe(false);
  });

  it("exposes an independent Transcript panel setting", async () => {
    setupUi({
      enabled: false,
      transcriptPanelEnabled: false,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });
    await openSettings();
    const control = document.getElementById("echo360-pref-transcript-panel");
    expect(control.checked).toBe(false);
    control.checked = true;
    expect(window.Echo360Translator.ui.readPanelPrefs().transcriptPanelEnabled).toBe(true);
  });
});

describe("settings popover translation service display", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates the displayed translation service in real time when the config changes elsewhere", async () => {
    let changeListener;
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
      configurable: true,
      writable: true,
    });
    document.body.innerHTML = "";
    document.head.innerHTML = "";

    window.Echo360Translator = makeFullNs({
      storage: {
        getPrefs: vi.fn(async () => ({
          enabled: true,
          bilingual: false,
          reverseOrder: false,
          browserBilingual: false,
          browserReverseOrder: false,
          useNativeSubtitles: true,
          size: "medium",
        })),
        getConfig: vi.fn(async () => ({ target: "ZH", provider: "google-web" })),
      },
      browserApi: {
        storage: {
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
          onChanged: {
            addListener: vi.fn((listener) => { changeListener = listener; }),
            removeListener: vi.fn(),
          },
        },
      },
    });
    loadUiModules();
    window.Echo360Translator.ui.ensurePanel({ onPrefsChanged: vi.fn() });
    await openSettings();

    const providerLabel = document.getElementById("echo360-current-provider");
    expect(providerLabel.textContent).toBe("Google Translate");

    // Simulate the options page (or popup) writing a new provider while this
    // popover stays open — no re-open needed for the label to refresh.
    changeListener(
      { echo360TranslatorConfig: { newValue: { target: "ZH", provider: "deepseek" } } },
      "local"
    );

    expect(providerLabel.textContent).toBe("DeepSeek");
  });

  it("ignores storage changes outside the local area or unrelated keys", async () => {
    let changeListener;
    Object.defineProperty(window, "location", {
      value: { hostname: "echo360.org", pathname: "/lesson/test-id" },
      configurable: true,
      writable: true,
    });
    document.body.innerHTML = "";
    document.head.innerHTML = "";

    window.Echo360Translator = makeFullNs({
      storage: {
        getPrefs: vi.fn(async () => ({ enabled: true, size: "medium", useNativeSubtitles: true })),
        getConfig: vi.fn(async () => ({ target: "ZH", provider: "google-web" })),
      },
      browserApi: {
        storage: {
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
            remove: vi.fn(async () => {}),
          },
          onChanged: {
            addListener: vi.fn((listener) => { changeListener = listener; }),
            removeListener: vi.fn(),
          },
        },
      },
    });
    loadUiModules();
    window.Echo360Translator.ui.ensurePanel({ onPrefsChanged: vi.fn() });
    await openSettings();

    const providerLabel = document.getElementById("echo360-current-provider");
    expect(providerLabel.textContent).toBe("Google Translate");

    changeListener({ echo360TranslatorConfig: { newValue: { provider: "deepseek" } } }, "sync");
    expect(providerLabel.textContent).toBe("Google Translate");

    changeListener({ someOtherKey: { newValue: {} } }, "local");
    expect(providerLabel.textContent).toBe("Google Translate");
  });
});

describe("translation failure actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an explicit missing-details diagnosis when a failure has no error object", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    const onRetry = vi.fn();
    const onCancel = vi.fn();
    window.Echo360Translator.ui.showTranslationFailureActions({ onRetry, onCancel });

    const toggle = document.getElementById("echo360-translator-failure-toggle");
    const bar = document.getElementById("echo360-translator-failure-actions");
    const extension = document.getElementById("echo360-translator-diagnostics-extension");
    expect(toggle.hidden).toBe(false);
    expect(toggle.textContent).toBe("查看失败详情");
    expect(extension.hidden).toBe(true);
    expect(bar.style.display).toBe("none");

    toggle.click();
    expect(extension.hidden).toBe(false);
    expect(bar.style.display).toBe("flex");
    expect(bar.textContent).toContain("错误详情缺失");
    expect(bar.textContent).toContain("ERROR_DETAILS_MISSING");
    expect(bar.textContent).toContain("重试");
    expect(bar.textContent).toContain("取消");

    bar.querySelector('[data-action="retry"]').click();
    bar.querySelector('[data-action="cancel"]').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics collapsed until the floating-panel button is activated", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    window.Echo360Translator.ui.showTranslationFailureActions({ onRetry: vi.fn(), onCancel: vi.fn() });
    const toggle = document.getElementById("echo360-translator-failure-toggle");
    const extension = document.getElementById("echo360-translator-diagnostics-extension");
    window.Echo360Translator.ui.hideTranslationFailureActions();
    const panel = document.getElementById("echo360-translator-failure-actions");
    expect(toggle.hidden).toBe(false);
    expect(toggle.textContent).toBe("查看错误历史");
    expect(extension.hidden).toBe(true);
    expect(panel.style.display).toBe("none");

    toggle.click();
    expect(extension.hidden).toBe(false);
    expect(panel.style.display).toBe("flex");
    expect(panel.textContent).toContain("运行诊断");
    expect(panel.querySelector('[data-action="retry"]').hidden).toBe(true);

    toggle.click();
    expect(extension.hidden).toBe(true);
  });

  it("keeps a neutral diagnostics extension collapsed while retaining normal debug logs", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    const panel = document.getElementById("echo360-translator-failure-actions");
    const extension = document.getElementById("echo360-translator-diagnostics-extension");
    const toggle = document.getElementById("echo360-translator-failure-toggle");
    const logs = document.getElementById("echo360-translator-runtime-logs");
    expect(extension.hidden).toBe(true);
    expect(panel.style.display).toBe("none");
    expect(toggle.textContent).toBe("运行诊断");
    window.Echo360Translator.ui.clearLogs();
    expect(logs.querySelector(".echo360-runtime-logs-empty").textContent).toContain("暂无运行日志");

    window.Echo360Translator.ui.appendLog("debug", "partial preview applied", {
      runId: "run-debug-1",
      api_key: "should-not-be-visible",
    });
    window.Echo360Translator.ui.appendLog("info", "translation completed", { translated: 3 });

    expect(logs.querySelectorAll(".echo360-runtime-log-item")).toHaveLength(2);
    expect(logs.querySelector(".echo360-runtime-logs-overview").textContent).toContain("调试 1");
    expect(logs.querySelector(".echo360-runtime-logs-overview").textContent).toContain("信息 1");
    expect(logs.textContent).toContain("partial preview applied");
    expect(logs.textContent).toContain("run-debug-1");
    expect(logs.textContent).not.toContain("should-not-be-visible");

    toggle.click();
    expect(extension.hidden).toBe(false);
    expect(panel.textContent).toContain("运行诊断");
    expect(logs.hidden).toBe(false);

    window.Echo360Translator.ui.showError({ code: "HTTP_503", status: 503, message: "temporarily unavailable" }, {
      phase: "translation",
    });
    window.Echo360Translator.ui.clearError();
    expect(extension.hidden).toBe(true);
    expect(panel.style.display).toBe("none");
    expect(logs.querySelectorAll(".echo360-runtime-log-item")).toHaveLength(2);
  });

  it("captures extension-prefixed console diagnostics without capturing page noise", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    console.info("[echo360-translator][test] normal debug event", { runId: "console-run-1" });
    console.info("page noise that should stay in the browser console");

    const logs = document.getElementById("echo360-translator-runtime-logs");
    expect(logs.textContent).toContain("normal debug event");
    expect(logs.textContent).toContain("console-run-1");
    expect(logs.textContent).not.toContain("page noise that should stay");
  });

  it("filters, copies, and clears the persistent runtime log list", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    window.Echo360Translator.ui.clearLogs();
    window.Echo360Translator.ui.appendLog("debug", "source scan started");
    window.Echo360Translator.ui.appendLog("info", "translation completed");
    window.Echo360Translator.ui.appendLog("error", "render failed", { code: "RENDER_FAILED" });

    const logs = document.getElementById("echo360-translator-runtime-logs");
    logs.querySelector('[data-log-filter="error"]').click();
    expect(logs.querySelectorAll(".echo360-runtime-log-item")).toHaveLength(1);
    expect(logs.querySelector(".echo360-runtime-log-message").textContent).toContain("render failed");

    logs.querySelector(".echo360-runtime-logs-copy").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("筛选结果: 1/3");
    expect(writeText.mock.calls[0][0]).toContain("render failed");
    expect(writeText.mock.calls[0][0]).not.toContain("source scan started");

    logs.querySelector(".echo360-runtime-logs-clear").click();
    logs.querySelector(".echo360-runtime-logs-clear").click();
    expect(logs.querySelectorAll(".echo360-runtime-log-item")).toHaveLength(0);
    expect(logs.querySelector(".echo360-runtime-logs-empty").textContent).toContain("暂无运行日志");
  });

  it("renders structured provider diagnostics instead of a generic failure label", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    window.Echo360Translator.ui.showError({
      code: "GOOGLE_WEB_ALL_REQUESTS_FAILED",
      message: "Google Web 全部请求失败",
      metrics: { total: 3, processed: 3, translated: 0, failed: 3, rateLimitCount: 6 },
      failure_codes: { HTTP_429: 3 },
    }, {
      phase: "recovery",
      provider: "google-web",
      target: "ZH",
      onCancel: vi.fn(),
    });

    const bar = document.getElementById("echo360-translator-failure-actions");
    expect(bar.textContent).toContain("Google 网页翻译被限流");
    expect(bar.textContent).toContain("HTTP 429");
    expect(bar.textContent).toContain("失败原因统计");
    expect(bar.textContent).toContain("HTTP_429 × 3");
    expect(document.getElementById("echo360-status-text").textContent).toContain("GOOGLE_WEB_ALL_REQUESTS_FAILED");
  });

  it("keeps current diagnostics and session history inside the three-button control panel", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    const first = { code: "HTTP_429", status: 429, message: "rate limited" };
    const second = { code: "HTTP_503", status: 503, message: "service unavailable" };
    window.Echo360Translator.ui.showError(first, { phase: "translation" });
    window.Echo360Translator.ui.showError(first, { phase: "translation" });
    window.Echo360Translator.ui.showError(second, { phase: "translation" });

    const controlPanel = document.getElementById("echo360-translator-panel");
    const history = document.getElementById("echo360-translator-error-history");
    expect(controlPanel.contains(document.getElementById("echo360-translator-btn"))).toBe(true);
    expect(controlPanel.contains(document.getElementById("echo360-translator-force-btn"))).toBe(true);
    expect(controlPanel.contains(document.getElementById("echo360-translator-settings-btn"))).toBe(true);
    expect(controlPanel.contains(document.getElementById("echo360-translator-failure-actions"))).toBe(true);
    expect(controlPanel.contains(history)).toBe(true);
    expect(history.style.display).toBe("block");
    expect(history.querySelectorAll(".echo360-error-history-item")).toHaveLength(2);

    const clear = history.querySelector(".echo360-error-history-clear");
    clear.click();
    expect(clear.textContent).toBe("确认清空");
    expect(history.querySelectorAll(".echo360-error-history-item")).toHaveLength(2);
    clear.click();
    expect(history.querySelectorAll(".echo360-error-history-item")).toHaveLength(0);
    expect(history.style.display).toBe("none");
  });

  it("provides counts, severity filters, search, and a clear no-results state", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    window.Echo360Translator.ui.showError(
      { code: "HTTP_429", status: 429, message: "rate limited" },
      { phase: "translation", provider: "google-web" }
    );
    window.Echo360Translator.ui.showError(
      { code: "CACHE_WRITE_FAILED", severity: "warning", message: "cache unavailable" },
      { phase: "cache", severity: "warning" }
    );
    window.Echo360Translator.ui.showError(
      { code: "VIDEO_NOT_FOUND", message: "video missing" },
      { phase: "source" }
    );

    const history = document.getElementById("echo360-translator-error-history");
    expect(history.querySelector(".echo360-error-history-overview").textContent)
      .toBe("3 条记录 · 2 个错误 · 1 个警告");
    expect(history.querySelector('[data-count="all"]').textContent).toBe("3");
    expect(history.querySelector('[data-count="error"]').textContent).toBe("2");
    expect(history.querySelector('[data-count="warning"]').textContent).toBe("1");

    history.querySelector('[data-filter="warning"]').click();
    expect(history.querySelector('[data-filter="warning"]').getAttribute("aria-pressed")).toBe("true");
    expect(history.querySelectorAll(".echo360-error-history-item")).toHaveLength(1);
    expect(history.querySelector(".echo360-error-history-code").textContent).toBe("CACHE_WRITE_FAILED");

    history.querySelector('[data-filter="all"]').click();
    const search = history.querySelector(".echo360-error-history-search");
    search.value = "http_429";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(history.querySelectorAll(".echo360-error-history-item")).toHaveLength(1);
    expect(history.querySelector(".echo360-error-history-code").textContent).toBe("HTTP_429");

    search.value = "definitely-no-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(history.querySelectorAll(".echo360-error-history-item")).toHaveLength(0);
    expect(history.querySelector(".echo360-error-history-empty").hidden).toBe(false);
    expect(history.querySelector(".echo360-error-history-empty").textContent).toContain("没有符合");
    expect(history.querySelector(".echo360-error-history-copy").disabled).toBe(true);
  });

  it("coalesces duplicate callbacks, separates retries by run ID, and marks historical detail views", () => {
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    const failure = { code: "HTTP_503", status: 503, message: "service unavailable" };
    window.Echo360Translator.ui.showError(failure, { phase: "translation", runId: "run-one" });
    window.Echo360Translator.ui.showError(failure, { phase: "translation", runId: "run-one" });
    window.Echo360Translator.ui.showError(failure, { phase: "translation", runId: "run-two" });

    const history = document.getElementById("echo360-translator-error-history");
    const rows = history.querySelectorAll(".echo360-error-history-item");
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector(".echo360-error-history-repeats").textContent).toBe("×2");
    expect(rows[1].querySelector(".echo360-error-history-repeats").hidden).toBe(false);

    rows[1].querySelector(".echo360-error-history-view").click();
    const current = document.getElementById("echo360-translator-failure-actions");
    expect(current.querySelector(".echo360-error-context").textContent).toContain("历史记录");
    expect(current.querySelector(".echo360-error-context").textContent).toContain("重复 2 次");
    expect(current.classList.contains("echo360-error-historical")).toBe(true);
    expect(current.querySelector(".echo360-error-announcement").getAttribute("role")).toBe("status");
    expect(current.querySelector(".echo360-error-announcement").getAttribute("aria-live")).toBe("polite");
    expect(current.querySelector(".echo360-error-close").getAttribute("aria-label")).toBe("返回当前问题");
    expect(current.querySelector('[data-action="retry"]').hidden).toBe(true);
    expect(history.querySelector(".echo360-error-history-item.is-selected")).not.toBeNull();

    current.querySelector(".echo360-error-close").click();
    expect(current.querySelector(".echo360-error-context").textContent).toBe("当前问题");
    expect(current.querySelector(".echo360-error-announcement").getAttribute("role")).toBe("alert");
    expect(current.classList.contains("echo360-error-historical")).toBe(false);
    expect(history.querySelector(".echo360-error-history-item.is-selected")).toBeNull();

    const toggle = history.querySelector(".echo360-error-history-toggle");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(history.querySelector(".echo360-error-history-content").hidden).toBe(true);
  });

  it("copies the filtered diagnostic report without mixing in hidden records", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setupUi({
      enabled: true,
      bilingual: false,
      reverseOrder: false,
      browserBilingual: false,
      browserReverseOrder: false,
      useNativeSubtitles: true,
      size: "medium",
    });

    window.Echo360Translator.ui.showError(
      { code: "HTTP_429", status: 429, message: "rate limited" },
      { phase: "translation" }
    );
    window.Echo360Translator.ui.showError(
      { code: "CACHE_WRITE_FAILED", severity: "warning", message: "cache unavailable" },
      { phase: "cache", severity: "warning" }
    );

    const history = document.getElementById("echo360-translator-error-history");
    history.querySelector('[data-filter="warning"]').click();
    history.querySelector(".echo360-error-history-copy").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const report = writeText.mock.calls[0][0];
    expect(report).toContain("筛选结果: 1/2");
    expect(report).toContain("CACHE_WRITE_FAILED");
    expect(report).not.toContain("HTTP_429");
    expect(history.querySelector(".echo360-error-history-feedback").textContent).toContain("已复制 1 条");
  });
});
