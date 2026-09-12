import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs, makeStorageMock } from "../helpers/load-module.js";

const ORIG_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

`;

const TRANS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
你好世界

`;

const MANUAL_PACKAGE = {
  schema_version: "2.0",
  package_type: "echo360_manual_translation",
  session_id: "manual:source-hash:ZH",
  target_language: "ZH",
  target_label: "简体中文",
  cues: { c000001: "Hello world" },
};

const MANUAL_RESULT = JSON.stringify({
  schema_version: "2.0",
  package_type: "echo360_manual_translation_result",
  session_id: "manual:source-hash:ZH",
  translations: { c000001: "你好世界" },
});

function makeVideo() {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
  Object.defineProperty(video, "duration", { value: 2, configurable: true });
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "textTracks", { value: [], configurable: true });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 360,
    top: 0,
    left: 0,
    bottom: 360,
    right: 640,
  });
  return video;
}

function setupControllerWithRenderer() {
  Object.defineProperty(window, "location", {
    value: { hostname: "echo360.org", pathname: "/lesson/test-id", href: "https://echo360.org/lesson/test-id" },
    configurable: true,
    writable: true,
  });
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  let objectUrlId = 0;
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => `blob:echo360-test-${++objectUrlId}`),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
  });

  const video = makeVideo();
  document.body.appendChild(video);
  const localMock = makeStorageMock({});
  const prefs = {
    enabled: true,
    size: "medium",
    bilingual: true,
    reverseOrder: false,
    useNativeSubtitles: false,
  };
  const domMount = vi.fn(() => false);

  window.Echo360Translator = makeFullNs({
    browserApi: {
      storage: { local: localMock },
      runtime: { sendMessage: vi.fn() },
    },
    storage: {
      getPrefs: vi.fn(async () => prefs),
      getConfig: vi.fn(async () => ({ target: "ZH" })),
    },
    ui: {
      ensurePanel: vi.fn(),
      setStatusText: vi.fn(),
      updateActionButtons: vi.fn(),
      showTranslationFailureActions: vi.fn(),
      hideTranslationFailureActions: vi.fn(),
    },
    video: {
      installPageProbe: vi.fn(),
      waitForVideo: vi.fn(async () => video),
      getAllVideos: () => [video],
      getPrimaryVideo: () => video,
      querySelectorAllDeep: (selector) => Array.from(document.querySelectorAll(selector)),
      getVideoHintMediaIds: () => new Set(),
    },
    sourceFinder: {
      buildSourceMeta: () => ({ sourceId: "", mediaId: "", mapSource: "", stats: { maxEnd: 2 } }),
      pickBestMountVideoByVtt: () => video,
    },
    bilingualDomRenderer: {
      mount: domMount,
      unmount: vi.fn(),
      isMounted: () => false,
      ensureMounted: vi.fn(),
      setVisible: vi.fn(),
      applySize: vi.fn(),
    },
  });
  evalModule("vtt.js");
  evalModule("subtitle_strategy.js");
  evalModule("renderer.js");
  evalModule("controller.js");
  return { ns: window.Echo360Translator, video, domMount };
}

function setupManualController() {
  const setup = setupControllerWithRenderer();
  const ns = setup.ns;
  let callbacks = null;
  ns.storage.sha256Text = vi.fn(async () => "source-hash");
  ns.translationService = {
    resolveSourceVtt: vi.fn(async () => ({
      vttText: ORIG_VTT,
      sourceId: "source-vtt",
      sourceMeta: { sourceId: "source-vtt", stats: { cueCount: 1, maxEnd: 2 } },
    })),
  };
  ns.manualTranslation = {
    safeFilenamePart: vi.fn(() => "test-course"),
    createTranslationPackage: vi.fn(() => ({ translationPackage: MANUAL_PACKAGE })),
    buildPrompt: vi.fn(() => "translate this JSON"),
    downloadText: vi.fn(() => "test-course.translate.json"),
    copyText: vi.fn(async () => true),
    copyDeferredText: vi.fn((textPromise) => Promise.resolve(textPromise).then(() => true)),
    readClipboardText: vi.fn(async () => MANUAL_RESULT),
    inspectTranslation: vi.fn(() => ({ ok: true, type: "json" })),
    looksLikeVtt: vi.fn(() => true),
    normalizeVttText: vi.fn((value) => value),
    readVttFile: vi.fn(async () => TRANS_VTT),
    readTranslationFile: vi.fn(async () => MANUAL_RESULT),
    validateImportedTranslation: vi.fn(() => ({
      translatedVtt: TRANS_VTT,
      cueCount: 1,
      unchangedCues: 0,
      warning: "",
    })),
    validateImportedVtt: vi.fn((translatedVtt) => ({
      translatedVtt,
      cueCount: 1,
      unchangedCues: 0,
      warning: "",
    })),
  };
  ns.ui.setManualReady = vi.fn();
  ns.ui.setManualBusy = vi.fn();
  ns.ui.setManualMessage = vi.fn();
  ns.ui.clearError = vi.fn();
  ns.ui.showError = vi.fn();
  ns.ui.ensurePanel.mockImplementation((next) => { callbacks = next; });
  return { ...setup, callbacks: () => callbacks };
}

describe("controller track sync in Echo360 native CC mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to a browser track when native CC DOM mounting fails, and periodic sync does not re-attempt native CC mounting afterwards", async () => {
    const { ns, video, domMount } = setupControllerWithRenderer();

    const mounted = ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    expect(mounted).toBe(true);
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);

    await ns.controller.init();
    await vi.advanceTimersByTimeAsync(2400);

    // A browser track is already showing (the automatic fallback), so
    // periodic sync should not keep re-attempting the failed native CC mount.
    expect(domMount).toHaveBeenCalledOnce();
    expect(video.querySelectorAll('track[data-echo360-translated="1"]').length).toBe(1);
  });

  it("renders the Transcript panel as an independent surface without changing track mounting", () => {
    const { ns } = setupControllerWithRenderer();
    const panel = {
      setVisible: vi.fn(),
      setTranslation: vi.fn(),
    };
    ns.transcriptPanelRenderer = panel;
    const mounted = ns.controller.renderTranslationSurfaces({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      prefs: { enabled: false, transcriptPanelEnabled: true, bilingual: false, reverseOrder: false, size: "medium", useNativeSubtitles: true, target: "ZH" },
      sourceMeta: { sourceId: "source", sessionKey: "source::cfg" },
    });
    expect(mounted).toBe(true);
    expect(panel.setVisible).toHaveBeenCalledWith(true);
    expect(panel.setTranslation).toHaveBeenCalledWith(expect.objectContaining({ target: "ZH" }));
  });

  it("reports a Transcript panel failure as a warning without hiding a mounted video track", () => {
    const { ns, video } = setupControllerWithRenderer();
    const warning = [];
    ns.transcriptPanelRenderer = {
      setVisible: vi.fn(),
      setTranslation: vi.fn(() => { throw Object.assign(new Error("panel bridge failed"), { code: "TRANSCRIPT_BRIDGE_FAILED" }); }),
    };

    const mounted = ns.controller.renderTranslationSurfaces({
      translatedVtt: TRANS_VTT,
      originalVtt: ORIG_VTT,
      prefs: { enabled: true, transcriptPanelEnabled: true, bilingual: false, reverseOrder: false, size: "medium", useNativeSubtitles: true, target: "ZH" },
      sourceMeta: { sourceId: "source", sessionKey: "source::cfg" },
      onSurfaceWarning: (error) => warning.push(error),
    });

    expect(mounted).toBe(true);
    expect(video.querySelector('track[data-echo360-translated="1"]')).not.toBeNull();
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({ code: "TRANSCRIPT_BRIDGE_FAILED", phase: "render" });
  });

  it("does not trust a DOM-only translated track and revalidates the current source", async () => {
    const { ns } = setupControllerWithRenderer();
    ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    const resolveSourceVtt = vi.fn();
    ns.translationService = { resolveSourceVtt };
    ns.renderer.hasRenderedTranslatedTrack = vi.fn(() => true);
    ns.transcriptPanelRenderer = {
      start: vi.fn(),
      getDebugState: vi.fn(() => ({ modelCueCount: 0 })),
    };
    ns.storage.getPrefs.mockResolvedValue({
      enabled: true,
      transcriptPanelEnabled: false,
      size: "medium",
      bilingual: true,
      reverseOrder: false,
      useNativeSubtitles: false,
    });
    let callbacks = null;
    ns.ui.ensurePanel.mockImplementation((next) => { callbacks = next; });
    await ns.controller.init();
    expect(callbacks?.onTranslate).toEqual(expect.any(Function));
    await callbacks.onTranslate();
    // Source prefetch now starts at video load. A failed/empty preload must
    // not make the explicit translation trust a DOM-only translated track.
    expect(resolveSourceVtt.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("automatically prepares the manual session, downloads the JSON package, and copies the prompt", async () => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();

    await callbacks().onManualPrepare();

    expect(ns.manualTranslation.downloadText).toHaveBeenCalledWith(
      expect.stringContaining("echo360_manual_translation"),
      expect.stringContaining(".translate.json"),
      "application/json;charset=utf-8"
    );
    expect(ns.manualTranslation.downloadText.mock.calls[0][0]).toBe(`${JSON.stringify(MANUAL_PACKAGE)}\n`);
    expect(ns.manualTranslation.copyText).toHaveBeenCalledWith("translate this JSON");
    expect(ns.manualTranslation.copyText.mock.invocationCallOrder[0])
      .toBeLessThan(ns.manualTranslation.downloadText.mock.invocationCallOrder[0]);
    expect(ns.ui.setManualReady).toHaveBeenCalledWith({ cueCount: 1, targetLabel: "简体中文" });
    expect(ns.ui.setManualMessage).toHaveBeenCalledWith(
      expect.stringContaining("已自动下载"),
      "success"
    );
  });

  it("runs cached translation and AI material export together from the quick action", async () => {
    const { ns, callbacks } = setupManualController();
    ns.storage.askApiKeyIfNeeded = vi.fn(async (cfg) => cfg);
    ns.storage.getCacheStore = vi.fn(async () => ({
      cacheKey: "source::config",
      translatedVtt: TRANS_VTT,
    }));
    ns.translationService.buildCacheKey = vi.fn(async () => ({
      sourceKey: "source",
      configSig: "config",
      cacheKey: "source::config",
    }));
    ns.backendClient = { validateTranslationResult: vi.fn() };
    await ns.controller.init();
    ns.manualTranslation.copyText.mockClear();
    ns.manualTranslation.downloadText.mockClear();

    const result = callbacks().onQuickTranslate();
    expect(ns.manualTranslation.copyText).toHaveBeenCalledOnce();
    expect(ns.manualTranslation.downloadText).toHaveBeenCalledOnce();
    expect(ns.manualTranslation.copyText.mock.invocationCallOrder[0])
      .toBeLessThan(ns.manualTranslation.downloadText.mock.invocationCallOrder[0]);
    await result;

    expect(ns.storage.getCacheStore).toHaveBeenCalledOnce();
    expect(ns.translationService.buildCacheKey).toHaveBeenCalledWith(
      expect.any(Object),
      "source-vtt",
      ORIG_VTT
    );
    expect(ns.ui.setStatusText).toHaveBeenCalledWith("命中本地缓存");
  });

  it("asks before retranslation and does not export duplicate AI materials when cancelled", async () => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();
    ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    ns.manualTranslation.copyText.mockClear();
    ns.manualTranslation.downloadText.mockClear();

    const result = await callbacks().onQuickTranslate();

    expect(result).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("是否清除当前结果并重新翻译"));
    expect(ns.manualTranslation.copyText).not.toHaveBeenCalled();
    expect(ns.manualTranslation.downloadText).not.toHaveBeenCalled();
    expect(ns.ui.setStatusText).toHaveBeenCalledWith(
      "当前翻译字幕已保留，未重新翻译，也未重复下载材料。",
      "info"
    );
  });

  it("uses the same material-export workflow after confirming retranslation", async () => {
    const { ns, callbacks } = setupManualController();
    ns.storage.askApiKeyIfNeeded = vi.fn(async (cfg) => cfg);
    ns.storage.getCacheStore = vi.fn(async () => null);
    ns.storage.setCacheStore = vi.fn(async () => ({ ok: true }));
    ns.translationService.buildCacheKey = vi.fn(async () => ({
      sourceKey: "source",
      configSig: "config",
      cacheKey: "source::config",
    }));
    ns.translationService.buildTranslatePayload = vi.fn((cfg, vttText, forceRefresh) => ({
      vtt_text: vttText,
      provider: "argos",
      target: "ZH",
      force_refresh: forceRefresh,
      bilingual: false,
    }));
    ns.translationService.translateWithConfig = vi.fn(async () => ({
      translated_vtt: TRANS_VTT,
      warnings: [],
      failed_items: [],
      failure_codes: {},
      metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
    }));
    ns.backendClient = { validateTranslationResult: vi.fn() };

    await ns.controller.init();
    ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    ns.manualTranslation.copyText.mockClear();
    ns.manualTranslation.downloadText.mockClear();

    await callbacks().onQuickTranslate();

    expect(ns.manualTranslation.copyText).toHaveBeenCalledOnce();
    expect(ns.manualTranslation.downloadText).toHaveBeenCalledOnce();
    expect(ns.translationService.buildTranslatePayload).toHaveBeenCalledWith(
      expect.any(Object),
      ORIG_VTT,
      true
    );
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
  });

  it("reuses the prefetched manual source as vtt_text for a fresh backend translation", async () => {
    const { ns, callbacks } = setupManualController();
    ns.storage.askApiKeyIfNeeded = vi.fn(async (cfg) => cfg);
    ns.storage.getCacheStore = vi.fn(async () => null);
    ns.storage.setCacheStore = vi.fn(async () => ({ ok: true }));
    ns.translationService.buildCacheKey = vi.fn(async () => ({
      sourceKey: "source",
      configSig: "config",
      cacheKey: "source::config",
    }));
    ns.translationService.buildTranslatePayload = vi.fn((cfg, vttText, forceRefresh) => ({
      vtt_text: vttText,
      provider: "argos",
      target: "ZH",
      force_refresh: forceRefresh,
      bilingual: false,
    }));
    ns.translationService.translateWithConfig = vi.fn(async (_cfg, _backendUrl, payload) => ({
      translated_vtt: TRANS_VTT,
      warnings: [],
      failed_items: [],
      failure_codes: {},
      metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
    }));
    ns.backendClient = { validateTranslationResult: vi.fn() };

    await ns.controller.init();
    await callbacks().onQuickTranslate();

    expect(ns.translationService.buildTranslatePayload).toHaveBeenCalledWith(
      expect.any(Object),
      ORIG_VTT,
      false
    );
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({ vtt_text: ORIG_VTT }),
      expect.any(Object)
    );
  });

  it("shows backend startup and 0/N preparation without claiming 0/0 translated output", async () => {
    const { ns, callbacks } = setupManualController();
    ns.storage.askApiKeyIfNeeded = vi.fn(async (cfg) => cfg);
    ns.storage.getCacheStore = vi.fn(async () => null);
    ns.storage.setCacheStore = vi.fn(async () => ({ ok: true }));
    ns.translationService.buildCacheKey = vi.fn(async () => ({
      sourceKey: "source",
      configSig: "config",
      cacheKey: "source::config",
    }));
    ns.translationService.buildTranslatePayload = vi.fn(() => ({
      vtt_text: ORIG_VTT,
      provider: "argos",
      target: "ZH",
      bilingual: false,
    }));
    ns.translationService.translateWithConfig = vi.fn(async (_cfg, _backendUrl, _payload, options) => {
      options.onProgress(0, 0, "正在启动 Argos 离线翻译后端…", { phase: "argos-startup" });
      options.onProgress(0, 1, "正在准备本地翻译…", { stage: "preparing" });
      options.onPartialVtt(TRANS_VTT, { current: 1, total: 1, translated: 1 });
      return {
        translated_vtt: TRANS_VTT,
        warnings: [],
        failed_items: [],
        failure_codes: {},
        metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
      };
    });
    ns.backendClient = { validateTranslationResult: vi.fn() };

    await ns.controller.init();
    await callbacks().onTranslate();

    const messages = ns.ui.setStatusText.mock.calls.map(([message]) => String(message));
    expect(messages).toContain("正在启动 Argos 离线翻译后端…");
    expect(messages).toContain("翻译准备中 0/1");
    expect(messages).toContain("翻译中 1/1（已开始显示）");
    expect(messages.some((message) => message.includes("0/0"))).toBe(false);
  });

  it.each([
    { copyFails: false, downloadFails: false, expected: "已自动下载" },
    { copyFails: true, downloadFails: false, expected: "浏览器未允许" },
    { copyFails: false, downloadFails: true, expected: "未能自动下载" },
    { copyFails: true, downloadFails: true, expected: "都未能自动导出" },
  ])("keeps clipboard and download outcomes independent: $expected", async ({ copyFails, downloadFails, expected }) => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();
    ns.ui.setManualMessage.mockClear();
    ns.manualTranslation.copyText.mockImplementation(async () => {
      if (copyFails) throw Object.assign(new Error("copy blocked"), { code: "CLIPBOARD_COPY_FAILED" });
      return true;
    });
    ns.manualTranslation.downloadText.mockImplementation(() => {
      if (downloadFails) throw Object.assign(new Error("download blocked"), { code: "MANUAL_EXPORT_UNAVAILABLE" });
      return "course.translate.json";
    });

    const result = await callbacks().onManualPrepare();

    expect(result).toBe(!copyFails && !downloadFails);
    expect(ns.manualTranslation.copyText).toHaveBeenCalledOnce();
    expect(ns.manualTranslation.downloadText).toHaveBeenCalledOnce();
    expect(ns.manualTranslation.copyText.mock.invocationCallOrder[0])
      .toBeLessThan(ns.manualTranslation.downloadText.mock.invocationCallOrder[0]);
    expect(ns.ui.setManualMessage).toHaveBeenLastCalledWith(
      expect.stringContaining(expected),
      copyFails || downloadFails ? "warning" : "success"
    );
  });

  it("keeps a complete session after automatic clipboard failure and allows a real-click retry", async () => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();
    ns.manualTranslation.copyText.mockRejectedValueOnce(
      Object.assign(new Error("copy blocked"), { code: "CLIPBOARD_COPY_FAILED" })
    );

    await callbacks().onManualPrepare();
    ns.manualTranslation.copyText.mockResolvedValueOnce(true);
    await callbacks().onManualCopyPrompt();

    expect(ns.manualTranslation.copyText).toHaveBeenCalledTimes(2);
    expect(ns.ui.setManualMessage).toHaveBeenLastCalledWith("提示词已复制到剪贴板。", "success");
    expect(ns.manualTranslation.downloadText).toHaveBeenCalledWith(
      expect.stringContaining("echo360_manual_translation"),
      expect.stringContaining("source-h.translate.json"),
      "application/json;charset=utf-8"
    );
  });

  it("binds the prompt to the source hash and finalizes session metadata for import", async () => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();
    await callbacks().onManualPrepare();

    expect(ns.storage.sha256Text.mock.invocationCallOrder[0])
      .toBeLessThan(ns.manualTranslation.buildPrompt.mock.invocationCallOrder[0]);
    expect(ns.manualTranslation.createTranslationPackage).toHaveBeenCalledWith(expect.objectContaining({
      sourceVtt: ORIG_VTT,
      sourceHash: "source-hash",
      target: "ZH",
    }));
    await callbacks().onManualImport();
    expect(ns.renderer.getRenderState().lastRenderSourceMeta).toMatchObject({
      target: "ZH",
      manualImport: true,
      sessionKey: "manual:source-hash:ZH",
    });
  });

  it("imports a matching clipboard JSON result without reading a file", async () => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();
    await callbacks().onManualPrepare();

    const result = await callbacks().onManualImport();

    expect(result).toBe(true);
    expect(ns.manualTranslation.readClipboardText).toHaveBeenCalledOnce();
    expect(ns.manualTranslation.readTranslationFile).not.toHaveBeenCalled();
    expect(ns.manualTranslation.validateImportedTranslation).toHaveBeenCalledWith(
      MANUAL_RESULT,
      expect.objectContaining({ sourceVtt: ORIG_VTT, translationPackage: MANUAL_PACKAGE }),
      { vtt: ns.vtt }
    );
  });

  it("returns the file-fallback signal when clipboard text is not a usable VTT", async () => {
    const { ns, callbacks } = setupManualController();
    await ns.controller.init();
    await callbacks().onManualPrepare();
    ns.manualTranslation.readClipboardText.mockResolvedValue("not a subtitle");
    ns.manualTranslation.inspectTranslation.mockReturnValue({
      ok: false,
      code: "MANUAL_IMPORT_JSON_INVALID",
      message: "not JSON or VTT",
    });

    const result = await callbacks().onManualImport();

    expect(result).toBe(false);
    expect(ns.manualTranslation.readTranslationFile).not.toHaveBeenCalled();
    expect(ns.translationService.resolveSourceVtt).toHaveBeenCalledOnce();
    expect(ns.ui.setManualMessage).toHaveBeenCalledWith(
      expect.stringContaining("从文件导入"),
      "warning"
    );
  });

  it("saves real v3 batches, repairs only missing cues, and mounts only after completion", async () => {
    const { ns, callbacks } = setupManualController();
    evalModule("manual_translation.js");
    const manual = ns.manualTranslation;
    const stamp = (i) => new Date(i * 1000).toISOString().slice(11, 23);
    const source = "WEBVTT\n\n" + Array.from({ length: 82 }, (_, i) =>
      `${stamp(i)} --> ${stamp(i + 1)}\n<v Lecturer>Hello world.`).join("\n\n");
    ns.translationService.resolveSourceVtt.mockResolvedValue({ vttText: source, sourceId: "source-vtt", sourceMeta: {} });
    const copy = vi.spyOn(manual, "copyText").mockResolvedValue(true);
    vi.spyOn(manual, "copyDeferredText").mockImplementation(async (promise) => { await promise; return true; });
    const download = vi.spyOn(manual, "downloadText").mockReturnValue("batch.json");
    await ns.controller.init();
    await callbacks().onManualPrepare();
    expect(JSON.parse(download.mock.calls[0][0]).mode).toBe("file_job");
    await callbacks().onManualToggleMode();
    const first = JSON.parse(download.mock.calls.at(-1)[0]);
    const result = (pkg, ids = Object.keys(pkg.cues)) => JSON.stringify({
      schema_version: "3.0", package_type: manual.RESULT_TYPE, session_id: pkg.session_id,
      request_id: pkg.request_id, translations: Object.fromEntries(ids.map((id) => [id, "你好，世界。"])),
    });
    const clipboard = vi.spyOn(manual, "readClipboardText").mockResolvedValue(result(first, Object.keys(first.cues).slice(1)));
    expect(await callbacks().onManualImport()).toBe(true);
    expect(document.querySelector('track[data-echo360-translated="1"]')).toBeNull();
    await callbacks().onManualCopyPrompt();
    const repair = JSON.parse(copy.mock.calls.at(-1)[0].split("以下是本批全部数据，无需其他附件：\n\n")[1]);
    expect(Object.keys(repair.cues)).toEqual(["c000001"]);
    // A stale response cannot replace the accepted 79 rows or advance progress.
    clipboard.mockResolvedValue(result(first));
    expect(await callbacks().onManualImport()).toBeNull();
    clipboard.mockResolvedValue(result(repair));
    expect(await callbacks().onManualImport()).toBe(true);
    await callbacks().onManualCopyPrompt();
    const next = JSON.parse(copy.mock.calls.at(-1)[0].split("以下是本批全部数据，无需其他附件：\n\n")[1]);
    expect(Object.keys(next.cues)).toHaveLength(2);
    clipboard.mockResolvedValue(result(next));
    expect(await callbacks().onManualImport()).toBe(true);
    expect(document.querySelector('track[data-echo360-translated="1"]')).not.toBeNull();
    const saved = await ns.browserApi.storage.local.get("echo360_manual_progress_v3");
    expect(Object.keys(saved.echo360_manual_progress_v3.accepted)).toHaveLength(82);
    expect(ns.ui.setManualReady).toHaveBeenCalledWith(expect.objectContaining({ progress: expect.objectContaining({ complete: true }) }));
    await callbacks().onManualDownloadVtt();
    expect(download.mock.calls.at(-1)[0]).toContain("<v Lecturer>你好，世界。");
    expect(download.mock.calls.at(-1)[1]).toMatch(/\.vtt$/);
    const callCount = download.mock.calls.length;
    await callbacks().onManualPrepare();
    expect(download).toHaveBeenCalledTimes(callCount);
  });

  it("exports the whole course once by default and accepts one complete result file", async () => {
    const { ns, callbacks } = setupManualController();
    evalModule("manual_translation.js");
    const manual = ns.manualTranslation;
    const stamp = (i) => new Date(i * 1000).toISOString().slice(11, 23);
    const sourceVtt = "WEBVTT\n\n" + Array.from({ length: 161 }, (_, i) =>
      `${stamp(i)} --> ${stamp(i + 1)}\n<v Lecturer>Welcome to class.`).join("\n\n");
    ns.translationService.resolveSourceVtt.mockResolvedValue({ vttText: sourceVtt, sourceId: "source-vtt", sourceMeta: {} });
    const copy = vi.spyOn(manual, "copyText").mockResolvedValue(true);
    vi.spyOn(manual, "copyDeferredText").mockImplementation(async (promise) => { await promise; return true; });
    const download = vi.spyOn(manual, "downloadText").mockReturnValue("job.translate.json");
    await ns.controller.init();
    await callbacks().onManualPrepare();
    const job = JSON.parse(download.mock.calls.at(-1)[0]);
    expect(job.mode).toBe("file_job");
    expect(Object.keys(job.cues)).toHaveLength(161);
    await callbacks().onManualCopyPrompt();
    expect(copy.mock.calls.at(-1)[0]).toContain("不要让我逐批操作");
    expect(copy.mock.calls.at(-1)[0]).not.toContain("c000161");
    const file = { name: "job.translated.json", size: 100, text: async () => JSON.stringify({
      schema_version: "3.0", package_type: manual.RESULT_TYPE, session_id: job.session_id,
      request_id: job.request_id, translations: Object.fromEntries(Object.keys(job.cues).map((id) => [id, "欢迎来到课堂。"])),
    }) };
    expect(await callbacks().onManualImport(file)).toBe(true);
    expect(ns.ui.setManualReady).toHaveBeenCalledWith(expect.objectContaining({ mode: "file", progress: expect.objectContaining({ completed: 161, complete: true }) }));
    expect(document.querySelector('track[data-echo360-translated="1"]')).not.toBeNull();
  });

  it("does not apply a manual result after the video context changes during import", async () => {
    const { ns, callbacks, video } = setupManualController();
    await ns.controller.init();
    await callbacks().onManualPrepare();
    const oldGet = ns.storage.getPrefs;
    ns.storage.getPrefs = vi.fn(async () => {
      video.setAttribute("src", "https://example.test/different-video.mp4");
      return oldGet();
    });
    expect(await callbacks().onManualImport()).toBeNull();
    expect(document.querySelector('track[data-echo360-translated="1"]')).toBeNull();
  });
});
