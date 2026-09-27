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

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, maxTurns = 60) {
  for (let turn = 0; turn < maxTurns && !predicate(); turn += 1) {
    await Promise.resolve();
  }
}

function configureDeferredTranslation(ns, deferredResults) {
  ns.storage.askApiKeyIfNeeded = vi.fn(async (cfg) => cfg);
  ns.storage.getCacheStore = vi.fn(async () => null);
  ns.storage.setCacheStore = vi.fn(async () => ({ ok: true }));
  ns.translationService.buildCacheKey = vi.fn(async () => ({
    sourceKey: "source",
    configSig: "config",
    cacheKey: "source::config",
  }));
  ns.translationService.buildTranslatePayload = vi.fn((_cfg, vttText) => ({
    vtt_text: vttText,
    provider: "google-web",
    target: "ZH",
    bilingual: false,
  }));
  ns.translationService.translateWithConfig = vi.fn(() => deferredResults.shift().promise);
  ns.backendClient = { validateTranslationResult: vi.fn() };
}

const DEFERRED_TRANSLATION_RESULT = {
  translated_vtt: TRANS_VTT,
  warnings: [],
  failed_items: [],
  metrics: { total: 1, translated: 1, failed: 0 },
};

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
  evalModule("shared_storage.js");
  const storageOwner = globalThis.Echo360SharedStorage.createOwner(localMock);
  const prefs = {
    enabled: true,
    size: "medium",
    bilingual: true,
    reverseOrder: false,
    useNativeSubtitles: false,
  };
  const domMount = vi.fn(() => false);
  let videoChangeListener = null;

  window.Echo360Translator = makeFullNs({
    browserApi: {
      storage: { local: localMock },
      runtime: { sendMessage: vi.fn(message => storageOwner.handle(message)) },
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
      setQuickImportVisible: vi.fn(),
    },
    video: {
      installPageProbe: vi.fn(),
      waitForVideo: vi.fn(async () => video),
      getAllVideos: () => [video],
      getPrimaryVideo: () => video,
      subscribeToChanges: vi.fn((listener) => {
        videoChangeListener = listener;
        return () => {
          if (videoChangeListener === listener) videoChangeListener = null;
        };
      }),
      destroy: vi.fn(),
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
  return {
    ns: window.Echo360Translator,
    video,
    domMount,
    emitVideoChange: (change = {}) => videoChangeListener?.(change),
  };
}

function setupManualController({ quickTranslateAutoExport = true } = {}) {
  const setup = setupControllerWithRenderer();
  const ns = setup.ns;
  let callbacks = null;
  ns.storage.getConfig.mockResolvedValue({ target: "ZH", quickTranslateAutoExport });
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
    window.Echo360Translator?.controller?.destroy?.();
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

  it("coalesces video changes into a prompt sync and keeps only a low-frequency safety pass", async () => {
    const { ns, emitVideoChange } = setupControllerWithRenderer();
    const ensureTrack = vi.spyOn(ns.renderer, "ensureTrackOnPrimaryVideo");
    await ns.controller.init();
    await vi.advanceTimersByTimeAsync(1200);
    ensureTrack.mockClear();

    // Repeated media/DOM signals must keep the first 100 ms deadline rather
    // than turning into a trailing debounce.
    emitVideoChange({ type: "media" });
    await vi.advanceTimersByTimeAsync(50);
    emitVideoChange({ type: "dom" });
    emitVideoChange({ type: "media" });
    await vi.advanceTimersByTimeAsync(49);
    expect(ensureTrack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureTrack).toHaveBeenCalledOnce();

    ensureTrack.mockClear();
    await vi.advanceTimersByTimeAsync(14999);
    expect(ensureTrack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureTrack).toHaveBeenCalledOnce();
  });

  it("reuses preferences during maintenance and refreshes only after a storage change", async () => {
    const { ns } = setupControllerWithRenderer();
    let onChanged;
    ns.browserApi.storage.onChanged = {
      addListener: vi.fn((listener) => { onChanged = listener; }),
      removeListener: vi.fn(),
    };
    await ns.controller.init();
    await vi.advanceTimersByTimeAsync(12000);
    expect(ns.storage.getPrefs).toHaveBeenCalledTimes(1);
    onChanged({ [ns.constants.PREFS_KEY_PREFIX + "global"]: { newValue: { enabled: false } } }, "local");
    await vi.advanceTimersByTimeAsync(1200);
    expect(ns.storage.getPrefs).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(12000);
    expect(ns.storage.getPrefs).toHaveBeenCalledTimes(2);
  });

  it("hides the dock quick-import button unless one-click AI export is enabled", async () => {
    const { ns } = setupControllerWithRenderer();
    ns.storage.getConfig.mockResolvedValue({ target: "ZH" });
    await ns.controller.init();
    expect(ns.ui.setQuickImportVisible).toHaveBeenCalledWith(false);
  });

  it("shows the dock quick-import button when one-click AI export is enabled", async () => {
    const { ns } = setupControllerWithRenderer();
    ns.storage.getConfig.mockResolvedValue({ target: "ZH", quickTranslateAutoExport: true });
    await ns.controller.init();
    expect(ns.ui.setQuickImportVisible).toHaveBeenCalledWith(true);
  });

  it("toggles the dock quick-import button when the one-click export setting changes", async () => {
    const { ns } = setupControllerWithRenderer();
    let onChanged;
    ns.browserApi.storage.onChanged = {
      addListener: vi.fn((listener) => { onChanged = listener; }),
      removeListener: vi.fn(),
    };
    ns.storage.getConfig.mockResolvedValue({ target: "ZH", quickTranslateAutoExport: false });
    await ns.controller.init();
    ns.ui.setQuickImportVisible.mockClear();

    onChanged({
      [ns.constants.STORAGE_KEY]: { newValue: { target: "ZH", quickTranslateAutoExport: true } },
    }, "local");
    expect(ns.ui.setQuickImportVisible).toHaveBeenCalledWith(true);

    onChanged({
      [ns.constants.STORAGE_KEY]: { newValue: { target: "ZH", quickTranslateAutoExport: false } },
    }, "local");
    expect(ns.ui.setQuickImportVisible).toHaveBeenLastCalledWith(false);
  });

  it("does not stack asynchronous maintenance jobs when extension storage stalls", async () => {
    const { ns } = setupControllerWithRenderer();
    let onChanged;
    ns.browserApi.storage.onChanged = { addListener: (listener) => { onChanged = listener; } };
    await ns.controller.init();
    let resolvePrefs;
    ns.storage.getPrefs.mockImplementationOnce(() => new Promise((resolve) => { resolvePrefs = resolve; }));
    onChanged({ [ns.constants.PREFS_KEY_PREFIX + "global"]: {} }, "local");
    await vi.advanceTimersByTimeAsync(12000);
    expect(ns.storage.getPrefs).toHaveBeenCalledTimes(2);
    resolvePrefs({ enabled: false });
    await vi.advanceTimersByTimeAsync(1200);
    expect(ns.storage.getPrefs).toHaveBeenCalledTimes(2);
  });

  it("stops maintenance in hidden pages and during page-cache suspension, then resumes", async () => {
    const { ns } = setupControllerWithRenderer();
    const ensureTrack = vi.spyOn(ns.renderer, "ensureTrackOnPrimaryVideo");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await ns.controller.init();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(12000);
    expect(ensureTrack).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1200);
    expect(ensureTrack).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(12000);
    expect(ensureTrack).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(1200);
    expect(ensureTrack).toHaveBeenCalledTimes(2);
    ns.controller.destroy();
    await vi.advanceTimersByTimeAsync(12000);
    expect(ensureTrack).toHaveBeenCalledTimes(2);
  });

  it("keeps track maintenance available to a visible picture-in-picture video", async () => {
    const { ns, video } = setupControllerWithRenderer();
    const ensureTrack = vi.spyOn(ns.renderer, "ensureTrackOnPrimaryVideo");
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await ns.controller.init();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "pictureInPictureElement", { configurable: true, value: video });
    try {
      video.dispatchEvent(new Event("enterpictureinpicture"));
      await vi.advanceTimersByTimeAsync(1200);
      expect(ensureTrack).toHaveBeenCalledTimes(1);
    } finally {
      delete document.pictureInPictureElement;
    }
    video.dispatchEvent(new Event("leavepictureinpicture"));
    await vi.advanceTimersByTimeAsync(12000);
    expect(ensureTrack).toHaveBeenCalledTimes(1);
  });

  it("bounds automatic failed-source prefetch retries while allowing an explicit retry", async () => {
    const { ns, callbacks } = setupManualController();
    ns.translationService.resolveSourceVtt.mockRejectedValue(Object.assign(new Error("No captions"), { code: "SOURCE_NOT_FOUND" }));
    await ns.controller.init();
    await vi.advanceTimersByTimeAsync(180000);
    expect(ns.translationService.resolveSourceVtt).toHaveBeenCalledTimes(3);
    await callbacks().onManualPrepare();
    expect(ns.translationService.resolveSourceVtt).toHaveBeenCalledTimes(4);
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
    expect(ns.ui.setStatusText).toHaveBeenCalledWith(
      expect.stringContaining("命中本地缓存。共 1 条字幕，已翻译 1 条，失败 0 条。"),
      "cache"
    );
    expect(ns.ui.setStatusText.mock.calls.at(-1)[0])
      .toContain("翻译服务：Google Translate 网页端点 1 条。");
  });

  it("skips automatic AI material export when the quick-action setting is disabled, including cache hits", async () => {
    const { ns, callbacks } = setupManualController({ quickTranslateAutoExport: false });
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

    await callbacks().onQuickTranslate();

    expect(ns.manualTranslation.copyText).not.toHaveBeenCalled();
    expect(ns.manualTranslation.downloadText).not.toHaveBeenCalled();
    expect(ns.storage.getCacheStore).toHaveBeenCalledOnce();
    expect(ns.ui.setStatusText).toHaveBeenCalledWith(
      expect.stringContaining("命中本地缓存。共 1 条字幕，已翻译 1 条，失败 0 条。"),
      "cache"
    );
    expect(ns.ui.setStatusText.mock.calls.at(-1)[0])
      .toContain("翻译服务：Google Translate 网页端点 1 条。");
  });

  it("asks before retranslation and does not export duplicate AI materials when cancelled", async () => {
    const { ns, video, callbacks } = setupManualController();
    await ns.controller.init();
    ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    ns.ui.clearTranslationSummary = vi.fn();
    const previousOverview = "翻译完成。共 1 条字幕，已翻译 1 条，失败 0 条。 翻译服务：Argos Translate（本地） 1 条。";
    ns.ui.setStatusText(previousOverview, "success");
    ns.ui.setStatusText.mockClear();
    ns.manualTranslation.copyText.mockClear();
    ns.manualTranslation.downloadText.mockClear();

    const result = await callbacks().onQuickTranslate();

    expect(result).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("是否清除当前结果并重新翻译"));
    expect(ns.manualTranslation.copyText).not.toHaveBeenCalled();
    expect(ns.manualTranslation.downloadText).not.toHaveBeenCalled();
    expect(ns.ui.setStatusText).not.toHaveBeenCalled();
    expect(ns.ui.clearTranslationSummary).not.toHaveBeenCalled();
    expect(video.querySelector('track[data-echo360-translated="1"]')).not.toBeNull();
  });

  it("does not promise AI material regeneration in the retranslation confirmation when disabled", async () => {
    const { ns, callbacks } = setupManualController({ quickTranslateAutoExport: false });
    await ns.controller.init();
    ns.renderer.renderTranslatedTrack(TRANS_VTT, ORIG_VTT, true, "medium", false, null, false);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await callbacks().onQuickTranslate();

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("确认后会清除当前结果并重新开始翻译"));
    expect(confirm.mock.calls[0][0]).not.toContain("重新生成完整 JSON");
    expect(confirm.mock.calls[0][0]).not.toContain("复制 AI 提示词");
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
    expect(messages.some((message) => message.includes("翻译完成。共 1 条字幕，已翻译 1 条，失败 0 条。"))).toBe(true);
  });

  it("includes the actual provider cue counts in the compact completion status", async () => {
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
      provider: "mixed",
      target: "ZH",
      bilingual: false,
    }));
    ns.translationService.translateWithConfig = vi.fn(async () => ({
      translated_vtt: TRANS_VTT,
      warnings: [],
      failed_items: [],
      failure_codes: {},
      metrics: {
        total: 1,
        totalCues: 1,
        translated: 1,
        translatedCues: 1,
        failed: 0,
        providerBreakdown: {
          "google-web": { assignedCues: 1, completedCues: 0, failures: 1 },
          deepl: { assignedCues: 0, completedCues: 1, failures: 0 },
        },
      },
    }));
    ns.backendClient = { validateTranslationResult: vi.fn() };

    await ns.controller.init();
    await callbacks().onTranslate();

    const messages = ns.ui.setStatusText.mock.calls.map(([message]) => String(message));
    const completed = messages.find((message) => message.startsWith("翻译完成。"));
    expect(completed).toContain("DeepL 1 条");
    expect(completed).not.toContain("Google Translate 网页端点 0 条");
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

  it("starts a new lesson translation while the old request is pending and ignores its late result", async () => {
    const { ns, callbacks, video, emitVideoChange } = setupManualController();
    const oldResult = makeDeferred();
    const newResult = makeDeferred();
    configureDeferredTranslation(ns, [oldResult, newResult]);
    let currentVideo = video;
    ns.video.getPrimaryVideo = () => currentVideo;
    ns.video.getAllVideos = () => [currentVideo];
    ns.video.waitForVideo = vi.fn(async () => currentVideo);
    ns.sourceFinder.pickBestMountVideoByVtt = () => currentVideo;

    await ns.controller.init();
    const oldRun = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledTimes(1);

    const newVideo = makeVideo();
    document.body.appendChild(newVideo);
    currentVideo = newVideo;
    emitVideoChange({ type: "media" });
    const newRun = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 2);
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledTimes(2);

    const renderTrack = vi.spyOn(ns.renderer, "renderTranslatedTrack");
    const rendersBeforeOldResult = renderTrack.mock.calls.length;
    const buttonUpdatesBeforeOldResult = ns.ui.updateActionButtons.mock.calls.length;
    oldResult.resolve(DEFERRED_TRANSLATION_RESULT);
    await oldRun;

    expect(renderTrack).toHaveBeenCalledTimes(rendersBeforeOldResult);
    expect(ns.ui.updateActionButtons).toHaveBeenCalledTimes(buttonUpdatesBeforeOldResult);
    expect(ns.storage.setCacheStore).not.toHaveBeenCalled();
    expect(ns.renderer.getRenderState().lastRenderedVideo).toBe(newVideo);

    newResult.resolve(DEFERRED_TRANSLATION_RESULT);
    await newRun;
    expect(ns.storage.setCacheStore).toHaveBeenCalledOnce();
    expect(video.querySelector('track[data-echo360-translated="1"]')).toBeNull();
    expect(newVideo.querySelector('track[data-echo360-translated="1"]')).not.toBeNull();
  });

  it.each(["media source", "lesson route"])("abandons a delayed result after the %s changes", async (contextChange) => {
    const { ns, callbacks, video, emitVideoChange } = setupManualController();
    const delayedResult = makeDeferred();
    configureDeferredTranslation(ns, [delayedResult]);
    const renderTrack = vi.spyOn(ns.renderer, "renderTranslatedTrack");

    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
    const rendersBeforeChange = renderTrack.mock.calls.length;

    if (contextChange === "media source") {
      video.setAttribute("src", "https://example.test/new-lesson.mp4");
      emitVideoChange({ type: "media" });
    } else {
      window.location.href = "https://echo360.org/lesson/new-lesson";
    }

    delayedResult.resolve(DEFERRED_TRANSLATION_RESULT);
    await run;

    expect(renderTrack).toHaveBeenCalledTimes(rendersBeforeChange);
    expect(video.querySelector('track[data-echo360-translated="1"]')).toBeNull();
    expect(ns.storage.setCacheStore).not.toHaveBeenCalled();
    expect(ns.ui.showError).not.toHaveBeenCalled();
  });

  it("does not render or report a translation that resolves after controller destruction", async () => {
    const { ns, callbacks } = setupManualController();
    const result = makeDeferred();
    configureDeferredTranslation(ns, [result]);
    const renderTrack = vi.spyOn(ns.renderer, "renderTranslatedTrack");

    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledOnce();

    const rendersBeforeDestroy = renderTrack.mock.calls.length;
    const buttonUpdatesBeforeDestroy = ns.ui.updateActionButtons.mock.calls.length;
    ns.controller.destroy();
    result.resolve(DEFERRED_TRANSLATION_RESULT);
    await run;

    expect(renderTrack).toHaveBeenCalledTimes(rendersBeforeDestroy);
    expect(ns.ui.updateActionButtons).toHaveBeenCalledTimes(buttonUpdatesBeforeDestroy);
    expect(ns.ui.showError).not.toHaveBeenCalled();
    expect(ns.storage.setCacheStore).not.toHaveBeenCalled();
  });

  it("marks every failed cue for rendering when diagnostic details are sampled", async () => {
    const { ns, callbacks } = setupManualController();
    const source = "WEBVTT\n\n" + Array.from({ length: 61 }, (_, i) => (
      `${ns.vtt.formatVttTime(i * 2)} --> ${ns.vtt.formatVttTime(i * 2 + 1)}\nSource ${i}\n`
    )).join("\n");
    const translated = source.replace("Source 60", "已翻译");
    ns.translationService.resolveSourceVtt.mockResolvedValue({
      vttText: source,
      sourceId: "source",
      sourceMeta: { stats: { cueCount: 61 } },
    });
    ns.storage.askApiKeyIfNeeded = vi.fn(async (cfg) => cfg);
    ns.storage.getCacheStore = vi.fn(async () => null);
    ns.storage.setCacheStore = vi.fn(async () => ({ ok: true }));
    ns.translationService.buildCacheKey = vi.fn(async () => ({
      sourceKey: "s",
      configSig: "c",
      cacheKey: "k",
    }));
    ns.translationService.buildTranslatePayload = vi.fn(() => ({
      vtt_text: source,
      provider: "google-web",
      target: "ZH",
      bilingual: false,
    }));
    ns.translationService.translateWithConfig = vi.fn(async () => ({
      translated_vtt: translated,
      warnings: [],
      failed_items: Array.from({ length: 50 }, (_, i) => ({
        cue: i + 1,
        code: "HTTP_503",
        message: "HTTP 503",
      })),
      failed_cues: Array.from({ length: 60 }, (_, i) => i + 1),
      failure_codes: { HTTP_503: 60 },
      metrics: {
        total: 61,
        processed: 61,
        translated: 1,
        failed: 60,
        providerResults: 1,
        targetResults: 1,
      },
    }));
    ns.backendClient = { validateTranslationResult: vi.fn() };
    const render = vi.spyOn(ns.renderer, "renderTranslatedTrack");

    await ns.controller.init();
    await callbacks().onTranslate();

    const finalOptions = render.mock.calls.at(-1)[7];
    expect(finalOptions.failedCues).toHaveLength(60);
    expect(finalOptions.failedCues.at(-1)).toBe(60);
  });
});

describe("sentence merging integration", () => {
  const source = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nThis is\n\n2\n00:00:01.000 --> 00:00:02.000\na sentence.\n\n3\n00:00:02.000 --> 00:00:03.000\nNext.\n";
  const translation = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n这是一个句子。\n\n2\n00:00:02.000 --> 00:00:03.000\n下一句。\n";
  beforeEach(() => { vi.useFakeTimers(); vi.restoreAllMocks(); });
  afterEach(() => {
    window.Echo360Translator?.controller?.destroy?.();
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  });

  function setup(enabled = true) {
    const state = setupManualController({ quickTranslateAutoExport: false });
    const { ns } = state;
    evalModule("sentence_merge.js");
    let prefs = { enabled: true, size: "medium", bilingual: true, browserBilingual: true,
      useNativeSubtitles: true, sentenceMergeEnabled: enabled, sentenceMergeEnglish: false };
    ns.storage.getPrefs.mockImplementation(async () => ({ ...prefs }));
    ns.storage.savePrefs = vi.fn(async value => { prefs = { ...value }; });
    ns.storage.askApiKeyIfNeeded = vi.fn(async cfg => cfg);
    ns.storage.getCacheStore = vi.fn(async () => null);
    ns.storage.setCacheStore = vi.fn(async () => ({ ok: true }));
    ns.translationService.resolveSourceVtt.mockResolvedValue({ vttText: source, sourceId: "sentence-source", sourceMeta: { stats: { cueCount: 3 } } });
    ns.translationService.buildCacheKey = vi.fn(async (_cfg, _id, _vtt, options) => ({ sourceKey: "source", configSig: "config", cacheKey: `source:${options?.sentenceMergeEnabled}` }));
    ns.translationService.buildTranslatePayload = vi.fn((_cfg, vtt) => ({ vtt_text: vtt, provider: "google-web", target: "ZH", bilingual: false }));
    ns.translationService.translateWithConfig = vi.fn(async (_cfg, _url, payload, options) => {
      const out = prefs.sentenceMergeEnabled ? translation : source.replace("This is", "这是").replace("a sentence.", "一个句子。").replace("Next.", "下一句。");
      options.onPartialVtt(out, { current: 2, total: 2, translated: 2 });
      return { translated_vtt: out, warnings: [], failed_items: [], metrics: { total: 2, translated: 2, failed: 0 } };
    });
    ns.backendClient = { validateTranslationResult: vi.fn() };
    return { ...state, prefs: () => prefs };
  }

  it("sends grouped sentences through the selected service and stores grouped results while rendering original timings", async () => {
    const { ns, callbacks } = setup();
    await ns.controller.init();
    await callbacks().onTranslate();
    const payload = ns.translationService.translateWithConfig.mock.calls[0][2];
    expect(ns.vtt.parseVttCues(payload.vtt_text).map(c => c.text)).toEqual(["This is a sentence.", "Next."]);
    expect(ns.translationService.buildCacheKey.mock.calls[0][3]).toEqual({ sentenceMergeEnabled: true, originalVtt: source });
    const rendered = ns.renderer.getRenderState();
    expect(ns.vtt.parseVttCues(rendered.lastRenderedVtt).map(c => c.text)).toEqual(["这是一个句子。", "这是一个句子。", "下一句。"]);
    expect(rendered.lastOriginalVtt).toBe(source);
    expect(ns.storage.setCacheStore.mock.calls[0][0].translatedVtt).toBe(translation);
    expect(ns.ui.showError).not.toHaveBeenCalled();
  });

  it("keeps disabled translation input and cache invocation unchanged", async () => {
    const { ns, callbacks } = setup(false);
    await ns.controller.init();
    await callbacks().onTranslate();
    expect(ns.translationService.translateWithConfig.mock.calls[0][2].vtt_text).toBe(source);
    expect(ns.translationService.buildCacheKey.mock.calls[0]).toHaveLength(3);
    expect(ns.renderer.getRenderState().lastOriginalVtt).toBe(source);
  });

  it("changes merged English without another service call, then retranslates when merging is disabled", async () => {
    const { ns, callbacks, prefs } = setup();
    await ns.controller.init();
    await callbacks().onTranslate();
    ns.ui.readPanelPrefs = vi.fn(() => ({ ...prefs(), sentenceMergeEnglish: true }));
    await callbacks().onPrefsChanged();
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledTimes(1);
    expect(ns.vtt.parseVttCues(ns.renderer.getRenderState().lastOriginalVtt).map(c => c.text)).toEqual(["This is a sentence.", "Next."]);
    ns.ui.readPanelPrefs.mockImplementation(() => ({ ...prefs(), sentenceMergeEnabled: false }));
    await callbacks().onPrefsChanged();
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledTimes(2);
    expect(ns.translationService.translateWithConfig.mock.calls[1][2].vtt_text).toBe(source);
  });

  it("defers a merge-mode change during an active request, then starts one replacement run", async () => {
    const { ns, callbacks, prefs } = setup();
    await ns.controller.init();
    const translate = ns.translationService.translateWithConfig.getMockImplementation();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    ns.translationService.translateWithConfig.mockImplementationOnce(async () => pending);
    const first = callbacks().onTranslate();
    await vi.waitFor(() => expect(ns.translationService.translateWithConfig).toHaveBeenCalledOnce());
    ns.ui.readPanelPrefs = vi.fn(() => ({ ...prefs(), sentenceMergeEnabled: false }));
    await callbacks().onPrefsChanged();
    expect(ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
    ns.translationService.translateWithConfig.mockImplementation(translate);
    release({ translated_vtt: translation, warnings: [], failed_items: [], metrics: { translated: 2, failed: 0 } });
    await first;
    await vi.waitFor(() => expect(ns.translationService.translateWithConfig).toHaveBeenCalledTimes(2));
    expect(ns.translationService.translateWithConfig.mock.calls[1][2].vtt_text).toBe(source);
  });

  it.each([
    [true, true, true], [false, true, false], [true, false, false],
  ])("gates merged English by plugin ownership and bilingual display (%s, %s)", (useNativeSubtitles, bilingual, merged) => {
    const { ns } = setup();
    ns.transcriptPanelRenderer = { setVisible: vi.fn(), setTranslation: vi.fn() };
    const plan = ns.sentenceMerge.build(source);
    const render = vi.spyOn(ns.renderer, "renderTranslatedTrack");
    ns.controller.renderTranslationSurfaces({ translatedVtt: translation, originalVtt: plan.vtt,
      prefs: { sentenceMergeEnabled: true, sentenceMergeEnglish: true, useNativeSubtitles, bilingual, browserBilingual: bilingual, transcriptPanelEnabled: true },
      sourceMeta: { sentenceMerge: { originalVtt: source, plan } } });
    expect(ns.transcriptPanelRenderer.setTranslation.mock.calls[0][0].originalVtt).toBe(source);
    expect(ns.vtt.parseVttCues(ns.transcriptPanelRenderer.setTranslation.mock.calls[0][0].translatedVtt)).toHaveLength(3);
    const overlayOriginal = ns.vtt.parseVttCues(render.mock.calls[0][1]).map(c => c.text);
    if (merged) expect(overlayOriginal[0]).toBe("This is a sentence.");
    else expect(overlayOriginal[0]).toBe("This is");
  });

  it("translates sentence fragments separately and splits a straddling source cue for overlay display", async () => {
    const { ns, callbacks } = setup();
    const original = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n<v Speaker 1>This is\n\n2\n00:00:01.000 --> 00:00:02.000\n<v Speaker 1>a sentence. The next\n\n3\n00:00:02.000 --> 00:00:03.000\n<v Speaker 1>one continues.\n";
    ns.translationService.resolveSourceVtt.mockResolvedValue({ vttText: original, sourceId: "split-source" });
    ns.translationService.translateWithConfig.mockImplementation(async (_cfg, _url, payload, options) => {
      expect(ns.vtt.parseVttCues(payload.vtt_text).map(c => c.text)).toEqual(["This is a sentence.", "The next one continues."]);
      const out = payload.vtt_text.replace("This is a sentence.", "这是一个句子。").replace("The next one continues.", "下一句继续。");
      options.onPartialVtt(out, { current: 2, total: 2, translated: 2 });
      return { translated_vtt: out, warnings: [], failed_items: [], metrics: { total: 2, translated: 2, failed: 0 } };
    });
    await ns.controller.init();
    await callbacks().onTranslate();
    const rendered = ns.renderer.getRenderState();
    const cues = ns.vtt.parseVttCues(rendered.lastRenderedVtt);
    expect(cues.map(c => c.text)).toEqual(["这是一个句子。", "这是一个句子。", "下一句继续。", "下一句继续。"]);
    expect(cues).toHaveLength(4);
    expect(cues[0].startMs).toBe(0);
    expect(cues[3].endMs).toBe(3000);
    expect(cues[1].startMs).toBe(1000);
    expect(cues[2].endMs).toBe(2000);
    expect(ns.vtt.parseVttCues(rendered.lastOriginalVtt).map(c => c.text)).toEqual([
      "<v Speaker 1>This is", "<v Speaker 1>a sentence. The next", "<v Speaker 1>a sentence. The next", "<v Speaker 1>one continues.",
    ]);
    expect(ns.ui.showError).not.toHaveBeenCalled();
  });

  it("maps sparse preview and group failure labels to every original cue without shifting", () => {
    const { ns } = setup();
    const plan = ns.sentenceMerge.build(source);
    const render = vi.spyOn(ns.renderer, "renderTranslatedTrack");
    ns.controller.renderTranslationSurfaces({
      translatedVtt: "WEBVTT\n\n2\n00:00:02.000 --> 00:00:03.000\n下一句。\n", originalVtt: plan.vtt,
      prefs: { sentenceMergeEnabled: true, useNativeSubtitles: true },
      sourceMeta: { sentenceMerge: { originalVtt: source, plan } },
      options: { previewPending: true, failedCues: [1] },
    });
    expect(ns.vtt.parseVttCues(render.mock.calls[0][0]).map(c => c.text)).toEqual(["[翻译失败]", "[翻译失败]", "下一句。"]);
    expect(render.mock.calls[0][7].failedCues).toEqual([1, 2]);
  });
});

describe("partial translation persistence and retry", () => {
  const source = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\nWorld\n";
  const partial = source.replace("Hello", "你好");
  const complete = partial.replace("World", "世界");
  const result = { translated_vtt: partial, failed_items: [{ cue: 2, code: "HTTP_503", message: "HTTP 503" }],
    failed_cues: [2], failure_codes: { HTTP_503: 1 }, metrics: { total: 2, translated: 1, failed: 1 } };
  const checkpoint = { sourceVtt: source, translatedVtt: partial, result };
  beforeEach(() => { vi.useFakeTimers(); vi.restoreAllMocks(); });
  afterEach(() => { window.Echo360Translator?.controller?.destroy?.(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  function setup(store, { writeFails = false } = {}) {
    const setup = setupManualController({ quickTranslateAutoExport: false });
    const { ns } = setup;
    ns.translationService.resolveSourceVtt.mockResolvedValue({ vttText: source, sourceId: "source", sourceMeta: {} });
    ns.storage.askApiKeyIfNeeded = vi.fn(async cfg => cfg);
    ns.storage.getCacheStore = vi.fn(async () => store.entry);
    ns.storage.setCacheStore = vi.fn(async entry => {
      if (writeFails) return { ok: false, error: Object.assign(new Error("disk full"), { code: "CACHE_WRITE_FAILED" }) };
      store.entry = entry;
      return { ok: true };
    });
    ns.translationService.buildCacheKey = vi.fn(async () => ({ sourceKey: "source", configSig: "config", cacheKey: "key" }));
    ns.translationService.buildTranslatePayload = vi.fn((_cfg, vtt, force) => ({ vtt_text: vtt, provider: "google-web", target: "ZH", force }));
    ns.translationService.buildTranslationCheckpoint = vi.fn(() => checkpoint);
    ns.translationService.validateTranslationCheckpoint = vi.fn((value, vtt) => value.sourceVtt === vtt ? value : null);
    ns.translationService.translateWithConfig = vi.fn(async () => result);
    ns.backendClient = { validateTranslationResult: vi.fn() };
    return setup;
  }

  it("persists partial results and resumes them after a new page controller", async () => {
    const store = { entry: null };
    const first = setup(store);
    await first.ns.controller.init();
    await first.callbacks().onTranslate();
    expect(store.entry.resumeCheckpoint).toEqual(checkpoint);
    first.ns.controller.destroy();

    const next = setup(store);
    next.ns.translationService.translateWithConfig.mockResolvedValue({ translated_vtt: complete, failed_items: [], metrics: { total: 2, translated: 2, failed: 0 } });
    await next.ns.controller.init();
    await next.callbacks().onQuickTranslate();
    expect(next.ns.translationService.translateWithConfig.mock.calls[0][3].resumeCheckpoint).toEqual(checkpoint);
    expect(store.entry.translatedVtt).toBe(complete);
    expect(store.entry.resumeCheckpoint).toBeUndefined();
  });

  it("keeps the partial result in memory when storage fails and the quick action retries without a full-reset confirmation", async () => {
    const current = setup({ entry: null }, { writeFails: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    await current.callbacks().onQuickTranslate();
    expect(confirm).not.toHaveBeenCalled();
    expect(current.ns.translationService.translateWithConfig.mock.calls[1][3].resumeCheckpoint).toEqual(checkpoint);
    expect(current.ns.ui.showError.mock.calls.at(-1)[1]).toHaveProperty("onRetry");
  });

  it("explicit full retranslation deletes the checkpoint and sends no resume data", async () => {
    const store = { entry: { cacheKey: "key", translatedVtt: partial, resumeCheckpoint: checkpoint } };
    const current = setup(store);
    await current.ns.controller.init();
    await current.callbacks().onForceTranslate();
    expect(current.ns.storage.setCacheStore).toHaveBeenCalledWith(null, "key", { clearManualOverride: { sourceKey: "source", configSig: "config" } });
    expect(current.ns.translationService.translateWithConfig.mock.calls[0][3].resumeCheckpoint).toBeNull();
  });

  it("the partial-error retry action reuses progress without deleting the cache", async () => {
    const current = setup({ entry: null });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    const retry = current.ns.ui.showError.mock.calls.at(-1)[1].onRetry;
    retry();
    await vi.waitFor(() => expect(current.ns.translationService.translateWithConfig).toHaveBeenCalledTimes(2));
    expect(current.ns.translationService.translateWithConfig.mock.calls[1][3].resumeCheckpoint).toEqual(checkpoint);
    expect(current.ns.storage.setCacheStore.mock.calls.every(([entry]) => entry !== null)).toBe(true);
  });

  it("does not mistake an obsolete partial checkpoint for a complete cache hit", async () => {
    const store = { entry: { cacheKey: "key", translatedVtt: partial, resumeCheckpoint: { ...checkpoint, sourceVtt: "changed" } } };
    const current = setup(store);
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    expect(current.ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
    expect(current.ns.translationService.translateWithConfig.mock.calls[0][3].resumeCheckpoint).toBeNull();
  });

  it("lets a newer persisted complete cache supersede an older in-memory partial checkpoint", async () => {
    const store = { entry: null };
    const current = setup(store, { writeFails: true });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    store.entry = {
      cacheKey: "key",
      sourceKey: "source",
      configSig: "config",
      translatedVtt: complete,
      createdAt: Date.now() + 1,
    };
    await current.callbacks().onTranslate();
    expect(current.ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
    expect(store.entry.translatedVtt).toBe(complete);
  });

  it("prefers a newer persisted partial checkpoint over an older in-memory partial", async () => {
    const store = { entry: null };
    const current = setup(store, { writeFails: true });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    const newerCheckpoint = { ...checkpoint, translatedVtt: complete };
    store.entry = {
      cacheKey: "key",
      sourceKey: "source",
      configSig: "config",
      translatedVtt: complete,
      resumeCheckpoint: newerCheckpoint,
      createdAt: Date.now() + 1,
    };
    await current.callbacks().onTranslate();
    expect(current.ns.translationService.translateWithConfig.mock.calls[1][3].resumeCheckpoint).toEqual(newerCheckpoint);
  });

  it("keeps the full retranslation path free of stale resume data", async () => {
    const store = { entry: { cacheKey: "key", translatedVtt: partial, resumeCheckpoint: checkpoint } };
    const current = setup(store);
    await current.ns.controller.init();
    await current.callbacks().onForceTranslate();
    expect(current.ns.storage.setCacheStore).toHaveBeenCalledWith(null, "key", { clearManualOverride: { sourceKey: "source", configSig: "config" } });
    expect(current.ns.translationService.buildTranslatePayload.mock.calls[0][2]).toBe(true);
    expect(current.ns.translationService.translateWithConfig.mock.calls[0][3].resumeCheckpoint).toBeNull();
  });

  it("asks for confirmation when a stale partial belongs to another source or config", async () => {
    const store = { entry: null };
    const current = setup(store, { writeFails: true });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    current.ns.translationService.resolveSourceVtt.mockResolvedValue({
      vttText: source.replace("Hello", "Other source"),
      sourceId: "other-source",
      sourceMeta: {},
    });
    current.ns.translationService.buildCacheKey.mockImplementation(async (cfg, sourceId) => ({
      sourceKey: sourceId,
      configSig: cfg.provider === "other" ? "other-config" : "config",
      cacheKey: String(sourceId) + "::" + (cfg.provider === "other" ? "other-config" : "config"),
    }));
    current.ns.storage.getConfig.mockResolvedValue({ target: "ZH", provider: "other", quickTranslateAutoExport: false });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const result = await current.callbacks().onQuickTranslate();
    expect(result).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(current.ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
  });

  it("asks for confirmation when stable source identity hides changed subtitle bytes", async () => {
    const store = { entry: null };
    const current = setup(store, { writeFails: true });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    current.ns.translationService.resolveSourceVtt.mockResolvedValue({
      vttText: source.replace("Hello", "Changed source bytes"),
      sourceId: "source",
      sourceMeta: {},
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await current.callbacks().onQuickTranslate()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(current.ns.translationService.translateWithConfig).toHaveBeenCalledOnce();
  });

  it("invalidates a matching partial checkpoint after a complete manual import", async () => {
    const store = { entry: null };
    const current = setup(store, { writeFails: true });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    await current.callbacks().onManualPrepare();
    expect(await current.callbacks().onManualImport()).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const result = await current.callbacks().onQuickTranslate();
    expect(result).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("invalidates a merged checkpoint when a complete manual import uses the plain cache identity", async () => {
    const store = { entry: null };
    const current = setup(store, { writeFails: true });
    current.ns.storage.getPrefs.mockResolvedValue({
      enabled: true,
      size: "medium",
      bilingual: true,
      reverseOrder: false,
      useNativeSubtitles: false,
      sentenceMergeEnabled: true,
    });
    current.ns.translationService.buildCacheKey.mockResolvedValue({
      sourceKey: "source",
      configSig: "config::sentence-merge-v2",
      cacheKey: "source::config::sentence-merge-v2",
    });
    await current.ns.controller.init();
    await current.callbacks().onTranslate();
    current.ns.translationService.buildCacheKey.mockResolvedValue({
      sourceKey: "source",
      configSig: "config",
      cacheKey: "source::config",
    });
    await current.callbacks().onManualPrepare();
    expect(await current.callbacks().onManualImport()).toBe(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(await current.callbacks().onQuickTranslate()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});


describe("translation display and manual-cache race regressions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.restoreAllMocks(); });
  afterEach(() => { window.Echo360Translator?.controller?.destroy(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it("retains the latest visibility and renderer preferences for partial and final results", async () => {
    const {ns, callbacks} = setupManualController();
    const delayed = makeDeferred();
    configureDeferredTranslation(ns, [delayed]);
    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    const initial = await ns.storage.getPrefs();
    const next = {...initial, enabled:false, bilingual:false, browserBilingual:false, useNativeSubtitles:true, size:"large"};
    ns.storage.savePrefs = vi.fn(async () => {});
    ns.ui.readPanelPrefs = vi.fn(() => next);
    await callbacks().onPrefsChanged();
    const render = vi.spyOn(ns.renderer, "renderTranslatedTrack");
    const visibility = vi.spyOn(ns.renderer, "applySubtitleVisibility");
    ns.translationService.translateWithConfig.mock.calls[0][3].onPartialVtt(TRANS_VTT, {current:1,total:1,translated:1});
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(render.mock.calls.at(-1)[2]).toBe(false);
    delayed.resolve(DEFERRED_TRANSLATION_RESULT);
    await run;
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(render.mock.calls.at(-1)[2]).toBe(false);
    expect(render.mock.calls.at(-1)[3]).toBe("large");
    expect(render.mock.calls.at(-1)[6]).toBe(true);
  });
  it("aborts the provider signal immediately on a source change or destruction", async () => {
    const {ns, callbacks, video, emitVideoChange} = setupManualController();
    const first = makeDeferred(), second = makeDeferred();
    configureDeferredTranslation(ns, [first, second]);
    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    const signal = ns.translationService.translateWithConfig.mock.calls[0][3].signal;
    expect(signal.aborted).toBe(false);
    video.src = "https://example.test/new.mp4";
    emitVideoChange({type:"media"});
    expect(signal.aborted).toBe(true);
    const next = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 2);
    const nextSignal = ns.translationService.translateWithConfig.mock.calls[1][3].signal;
    ns.controller.destroy();
    expect(nextSignal.aborted).toBe(true);
    first.resolve(DEFERRED_TRANSLATION_RESULT); second.resolve(DEFERRED_TRANSLATION_RESULT);
    await Promise.all([run, next]);
    expect(ns.storage.setCacheStore).not.toHaveBeenCalled();
  });
  it("does not resurrect a controller destroyed while init waits for video", async () => {
    const {ns, video} = setupManualController();
    const delayed = makeDeferred();
    ns.video.waitForVideo.mockReturnValue(delayed.promise);
    const init = ns.controller.init();
    ns.controller.destroy();
    delayed.resolve(video);
    await init;
    expect(ns.ui.ensurePanel).not.toHaveBeenCalled();
    expect(ns.video.subscribeToChanges).not.toHaveBeenCalled();
  });
  it("uses a different tab's latest preferences when a pending result finishes", async () => {
    const {ns, callbacks} = setupManualController();
    let changed;
    ns.browserApi.storage.onChanged = {addListener:vi.fn(fn=>{changed=fn;}), removeListener:vi.fn()};
    const delayed = makeDeferred();
    configureDeferredTranslation(ns, [delayed]);
    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    changed({[ns.constants.PREFS_KEY_PREFIX + "global"]:{newValue:{enabled:false,bilingual:false,browserBilingual:false,useNativeSubtitles:true,size:"large"}}}, "local");
    const visibility = vi.spyOn(ns.renderer,"applySubtitleVisibility");
    const render = vi.spyOn(ns.renderer,"renderTranslatedTrack");
    delayed.resolve(DEFERRED_TRANSLATION_RESULT); await run;
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(render.mock.calls.at(-1)[3]).toBe("large");
  });
  it("cancels an active job on pagehide and ignores its late completion", async () => {
    const {ns, callbacks} = setupManualController();
    const delayed = makeDeferred();
    configureDeferredTranslation(ns, [delayed]);
    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    const signal = ns.translationService.translateWithConfig.mock.calls[0][3].signal;
    window.dispatchEvent(new Event("pagehide"));
    expect(signal.aborted).toBe(true);
    delayed.resolve(DEFERRED_TRANSLATION_RESULT);
    await run;
    expect(ns.storage.setCacheStore).not.toHaveBeenCalled();
  });
  it("does not save or render an older preference edit after a newer edit finishes", async () => {
    const {ns, callbacks} = setupManualController();
    await ns.controller.init();
    const initial = await ns.storage.getPrefs();
    const oldRead = makeDeferred();
    ns.storage.getPrefs.mockReturnValueOnce(oldRead.promise).mockResolvedValue(initial);
    ns.storage.savePrefs = vi.fn(async () => {});
    ns.ui.readPanelPrefs = vi.fn().mockReturnValueOnce({...initial, size:"large"})
      .mockReturnValueOnce({...initial, size:"small"});
    const older = callbacks().onPrefsChanged();
    await callbacks().onPrefsChanged();
    oldRead.resolve(initial);
    await older;
    expect(ns.storage.savePrefs).toHaveBeenCalledTimes(1);
    expect(ns.storage.savePrefs).toHaveBeenLastCalledWith(expect.objectContaining({size:"small"}));
  });
  it("keeps a newer local edit visible while an older save emits its storage event", async () => {
    const { ns, callbacks } = setupManualController();
    let changed;
    ns.browserApi.storage.onChanged = { addListener: vi.fn(fn => { changed = fn; }), removeListener: vi.fn() };
    const translation = makeDeferred(), firstSave = makeDeferred(), secondSave = makeDeferred();
    configureDeferredTranslation(ns, [translation]);
    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    const initial = await ns.storage.getPrefs();
    ns.storage.savePrefs = vi.fn().mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(secondSave.promise);
    ns.ui.readPanelPrefs = vi.fn().mockReturnValueOnce({ ...initial, enabled: true, size: "large" })
      .mockReturnValueOnce({ ...initial, enabled: false, size: "small" });
    const older = callbacks().onPrefsChanged();
    await flushUntil(() => ns.storage.savePrefs.mock.calls.length === 1);
    const newer = callbacks().onPrefsChanged();
    changed({ [ns.constants.PREFS_KEY_PREFIX + "global"]: { newValue: { ...initial, enabled: true, size: "large" } } }, "local");
    firstSave.resolve();
    await flushUntil(() => ns.storage.savePrefs.mock.calls.length === 2);
    const visibility = vi.spyOn(ns.renderer, "applySubtitleVisibility");
    const render = vi.spyOn(ns.renderer, "renderTranslatedTrack");
    ns.translationService.translateWithConfig.mock.calls[0][3].onPartialVtt(TRANS_VTT, { current: 1, total: 1, translated: 1 });
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(render.mock.calls.at(-1)[3]).toBe("small");
    secondSave.resolve();
    await Promise.all([older, newer]);
    translation.resolve(DEFERRED_TRANSLATION_RESULT);
    await run;
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(render.mock.calls.at(-1)[3]).toBe("small");
  });
  it("does not let a maintenance preference read restore visibility after a storage change", async () => {
    const { ns } = setupManualController();
    let changed;
    ns.browserApi.storage.onChanged = { addListener: vi.fn(fn => { changed = fn; }), removeListener: vi.fn() };
    await ns.controller.init();
    const initial = await ns.storage.getPrefs();
    const read = makeDeferred();
    ns.storage.getPrefs.mockReturnValue(read.promise);
    changed({ [ns.constants.PREFS_KEY_PREFIX + "global"]: { newValue: initial } }, "local");
    await vi.advanceTimersByTimeAsync(100);
    changed({ [ns.constants.PREFS_KEY_PREFIX + "global"]: { newValue: { ...initial, enabled: false } } }, "local");
    const visibility = vi.spyOn(ns.renderer, "applySubtitleVisibility");
    read.resolve(initial);
    await flushUntil(() => visibility.mock.calls.length > 0);
    expect(visibility).toHaveBeenLastCalledWith(false);
  });
  it("renders the authority's manual result when a late machine cache commit is superseded", async () => {
    const {ns, callbacks} = setupManualController();
    evalModule("error_utils.js"); evalModule("backend_client.js");
    const delayed = makeDeferred();
    configureDeferredTranslation(ns, [delayed]);
    const manual = TRANS_VTT.replace("你好世界", "最新手动译文");
    ns.storage.setCacheStore.mockResolvedValue({ok:true, superseded:true, entry:{
      cacheKey:"manual-key", sourceKey:"source", configSig:"config", manualImport:true, translatedVtt:manual,
    }});
    await ns.controller.init();
    const run = callbacks().onTranslate();
    await flushUntil(() => ns.translationService.translateWithConfig.mock.calls.length === 1);
    delayed.resolve(DEFERRED_TRANSLATION_RESULT);
    await run;
    expect(ns.renderer.getRenderState().lastRenderedVtt).toContain("最新手动译文");
    expect(ns.ui.setStatusText).toHaveBeenLastCalledWith("已加载最新手动译文", "cache");
  });
  it("keeps a full manual import authoritative when merged cache exists", async () => {
    const { ns, callbacks } = setupManualController();
    evalModule("sentence_merge.js");
    evalModule("error_utils.js"); evalModule("backend_client.js");
    const prefs = await ns.storage.getPrefs();
    ns.storage.getPrefs.mockResolvedValue({...prefs, sentenceMergeEnabled:true});
    const older = TRANS_VTT.replace("你好世界","旧的机器译文");
    const entries = {merged:{cacheKey:"merged", sourceKey:"source", configSig:"config::sentence-merge-v2", translatedVtt:older}};
    ns.storage.askApiKeyIfNeeded = vi.fn(async x=>x);
    ns.translationService.buildCacheKey = vi.fn(async (_cfg,_id,_text,opts)=>({sourceKey:"source",configSig:opts?.sentenceMergeEnabled?"config::sentence-merge-v2":"config",cacheKey:opts?.sentenceMergeEnabled?"merged":"plain"}));
    ns.storage.getCacheStore = vi.fn(async key=>entries[key]||null);
    ns.storage.setCacheStore = vi.fn(async (entry,key)=>{if(entry) entries[entry.cacheKey]=entry; else delete entries[key]; return {ok:true};});
    await ns.controller.init(); await callbacks().onManualPrepare();
    expect(await callbacks().onManualImport()).toBe(true);
    expect(ns.renderer.getRenderState().lastRenderedVtt).toContain("你好世界");
    await callbacks().onTranslate();
    expect(ns.renderer.getRenderState().lastRenderedVtt).toContain("你好世界");
    expect(ns.renderer.getRenderState().lastRenderedVtt).not.toContain("旧的机器译文");
  });
});
