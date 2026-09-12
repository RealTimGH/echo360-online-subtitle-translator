(() => {
  const ns = window.Echo360Translator;
  const { DEFAULT_SUBTITLE_SIZE } = ns.constants;
  const extensionApi = ns.browserApi;

  let activeRunId = null;
  let isTranslating = false;
  let loadedCacheKey = "";
  let trackSyncTimer = null;
  let trackSyncErrorShown = false;
  let lastKnownConfig = null;
  let manualSession = null;
  let manualPreparationPromise = null;
  let manualPreparationContext = null;
  let manualPrimeRetryAt = 0;
  let manualPrimeFailureKey = "";
  let manualGeneration = 0;
  let configWatcherInstalled = false;

  function manualVideoHint(video) {
    if (!video) return "";
    const trackSources = Array.from(video.querySelectorAll?.("track[src]") || [])
      .filter((track) => {
        if (ns.sourceFinder?.isExtensionTranslatedTrack?.(track)) return false;
        return !track.hasAttribute?.("data-echo360-translated") &&
          !/(?:翻译字幕|translated\s+subtitle)/i.test(String(track.label || track.getAttribute?.("label") || ""));
      })
      .map((track) => track.getAttribute("src") || "")
      .filter(Boolean)
      .join("|");
    return `${video.currentSrc || video.src || ""}::${trackSources}`;
  }

  function isManualContextCurrent(context) {
    if (!context || context.location !== location.href) return false;
    if (context.generation != null && context.generation !== manualGeneration) return false;
    const video = ns.video.getPrimaryVideo?.() || context.video;
    if (!video || video !== context.video || context.video?.isConnected === false) return false;
    return context.videoHint === manualVideoHint(video);
  }

  function currentManualSession(video = ns.video.getPrimaryVideo?.()) {
    if (!manualSession || !isManualContextCurrent({
      video: manualSession.sourceVideo,
      location: manualSession.sourceLocation,
      videoHint: manualSession.sourceVideoHint,
      generation: manualSession.generation,
    })) return null;
    if (video && manualSession.sourceVideo !== video) return null;
    const currentTarget = String(lastKnownConfig?.target || manualSession.target || "ZH").toUpperCase();
    return currentTarget === manualSession.target ? manualSession : null;
  }

  function invalidateManualSession() {
    manualGeneration += 1;
    manualSession = null;
    manualPreparationContext = null;
    // An in-flight resolver cannot be aborted safely by this layer, but its
    // generation check prevents it from committing stale state.
    manualPreparationPromise = null;
    manualPrimeRetryAt = 0;
    manualPrimeFailureKey = "";
  }

  function installConfigWatcher() {
    if (configWatcherInstalled || typeof extensionApi.storage?.onChanged?.addListener !== "function") return;
    extensionApi.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const next = changes[ns.constants.STORAGE_KEY]?.newValue;
      if (!next || typeof next !== "object") return;
      const provider = String(next.provider || "google-web").toLowerCase();
      const previousTarget = String(lastKnownConfig?.target || "").toUpperCase();
      lastKnownConfig = {
        ...(lastKnownConfig || {}),
        ...next,
        backendUrl: provider === "custom-backend"
          ? (next.customBackendUrl || next.backendUrl || "http://127.0.0.1:8765")
          : "http://127.0.0.1:8765",
      };
      delete lastKnownConfig.useLocalBackend;
      const nextTarget = String(lastKnownConfig.target || "ZH").toUpperCase();
      if (previousTarget && previousTarget !== nextTarget) {
        invalidateManualSession();
        const video = ns.video.getPrimaryVideo?.();
        if (video) void primeManualSession(video).catch(() => {});
      }
    });
    configWatcherInstalled = true;
  }

  function safeErrorForLog(error, context = {}) {
    return ns.errorUtils?.serializeError?.(error, context) || {
      code: error?.code || "ERROR_DETAILS_MISSING",
      status: Number(error?.status ?? error?.statusCode) || null,
      message: String(error?.message || error || "错误详情缺失").replace(/\s+/g, " ").slice(0, 320),
    };
  }

  function failedCuesFromItems(items, originalVtt = "") {
    const failedCues = new Set();
    const sourceLines = String(originalVtt || "").replace(/\r/g, "").split("\n");
    const lineToCue = new Map();
    let cueIndex = 0;
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
      if (!/-->/.test(sourceLines[lineIndex])) continue;
      cueIndex += 1;
      lineToCue.set(lineIndex + 1, cueIndex);
      for (let textIndex = lineIndex + 1; textIndex < sourceLines.length && sourceLines[textIndex].trim() !== ""; textIndex += 1) {
        if (/-->/.test(sourceLines[textIndex])) break;
        lineToCue.set(textIndex + 1, cueIndex);
      }
    }
    for (const item of Array.isArray(items) ? items : []) {
      const cue = Number(item?.cue);
      if (Number.isInteger(cue) && cue > 0) {
        failedCues.add(cue);
        continue;
      }
      const line = Number(item?.line);
      const cueFromLine = lineToCue.get(line);
      if (Number.isInteger(cueFromLine) && cueFromLine > 0) failedCues.add(cueFromLine);
    }
    return [...failedCues];
  }

  // Keep the browser video track and the Echo360 Transcript panel as separate
  // rendering surfaces.  A panel capability failure must never change the
  // mounted-track result used by the existing subtitle lifecycle.
  function renderTranslationSurfaces({
    translatedVtt,
    originalVtt,
    prefs,
    sourceMeta,
    options = {},
    onSurfaceWarning = null,
  }) {
    let resolvedSourceMeta;
    try {
      resolvedSourceMeta = {
        ...(sourceMeta || {}),
        target: String(prefs.target || sourceMeta?.target || "ZH").toUpperCase(),
      };
      const mounted = ns.renderer.renderTranslatedTrack(
        translatedVtt,
        originalVtt,
        prefs.bilingual,
        prefs.size,
        prefs.reverseOrder,
        resolvedSourceMeta,
        prefs.useNativeSubtitles,
        {
          ...options,
          browserBilingual: prefs.browserBilingual,
          browserReverseOrder: prefs.browserReverseOrder,
        }
      );
      // The video subtitle layer is the primary surface. A Transcript panel
      // capability/DOM failure must not turn a successfully mounted video
      // subtitle into a total render failure.
      try {
        if (ns.transcriptPanelRenderer) {
          if (prefs.transcriptPanelEnabled === false) {
            ns.transcriptPanelRenderer.setVisible(false);
          } else {
            const panelTranslatedVtt = options.previewPending && ns.vtt?.buildIncrementalPreviewVtt
              ? ns.vtt.buildIncrementalPreviewVtt(translatedVtt, originalVtt, {
                placeholder: options.pendingLabel,
                failureLabel: options.failureLabel,
                failedCues: options.failedCues,
                markPending: options.markPending,
              })
              : translatedVtt;
            ns.transcriptPanelRenderer.setVisible(true);
            ns.transcriptPanelRenderer.setTranslation({
              translatedVtt: panelTranslatedVtt,
              originalVtt,
              sourceMeta: resolvedSourceMeta,
              target: resolvedSourceMeta.target,
              sessionKey: resolvedSourceMeta.sessionKey,
              pendingLabel: options.pendingLabel,
              failureLabel: options.failureLabel || ns.constants.SUBTITLE_FAILURE_LABEL,
              failedCues: options.failedCues,
              failurePreview: options.pendingLabel === ns.constants.SUBTITLE_FAILURE_LABEL,
            });
          }
        }
      } catch (error) {
        const panelError = error instanceof Error ? error : new Error(String(error || "Transcript 面板同步失败"));
        const code = String(panelError.code || "").toUpperCase();
        if (!code || ["ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR", "FAILURE_DETAIL_MISSING"].includes(code)) {
          panelError.code = "TRANSCRIPT_PANEL_RENDER_FAILED";
        }
        panelError.phase = panelError.phase || "render";
        panelError.details = {
          ...(panelError.details && typeof panelError.details === "object" ? panelError.details : {}),
          surface: "transcript-panel",
        };
        console.error("[echo360-translator][controller] Transcript panel render failed; video surface preserved", safeErrorForLog(panelError, {
          phase: "render",
          sourceMeta: resolvedSourceMeta,
        }));
        try {
          (onSurfaceWarning || options.onSurfaceWarning)?.(panelError);
        } catch (callbackError) {
          console.error("[echo360-translator][controller] Transcript panel warning callback failed", safeErrorForLog(callbackError, { phase: "render" }));
        }
      }
      return mounted;
    } catch (error) {
      const typed = error instanceof Error ? error : new Error(String(error || "字幕显示失败"));
      const code = String(typed.code || "").toUpperCase();
      const generic = !code || ["ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR", "FAILURE_DETAIL_MISSING"].includes(code);
      if (generic) {
        typed.code = "RENDER_FAILED";
        typed.phase = "render";
      }
      typed.phase = typed.phase || "render";
      typed.details = {
        ...(typed.details && typeof typed.details === "object" ? typed.details : {}),
        surface: "video-track",
      };
      console.error("[echo360-translator][controller] subtitle surface render failed", {
        code: typed.code,
        phase: typed.phase,
        message: typed.message,
        details: typed.details,
      });
      throw typed;
    }
  }

  function failedCuesFromProgress(progress = {}, originalVtt = "") {
    return failedCuesFromItems(progress.failed_items, originalVtt);
  }

  function failedCuesFromManualIssues(issues = [], session = null) {
    const records = Array.isArray(session?.workflow?.records) ? session.workflow.records : [];
    const cueById = new Map(records.map((record, index) => [String(record.id), index + 1]));
    return [...new Set((Array.isArray(issues) ? issues : [])
      .map((item) => cueById.get(String(item?.id || "")))
      .filter((cue) => Number.isInteger(cue) && cue > 0))];
  }

  function warningCodeFromText(value) {
    const text = String(value || "").trim();
    const match = text.match(/^\[([A-Z][A-Z0-9_]{2,})\]/i) ||
      text.match(/^([A-Z][A-Z0-9_]{2,})\s*:/i);
    const code = match ? match[1].toUpperCase() : "TRANSLATION_WARNING";
    // Warning strings may come from an older backend or a provider. Do not
    // promote an arbitrary prefix into the app's machine-readable error
    // vocabulary; unknown warning prefixes are still shown verbatim as a
    // warning, but their stable UI code remains TRANSLATION_WARNING.
    const knownWarningCodes = new Set([
      "CACHE_INVALID_IGNORED",
      "CACHE_READ_FAILED",
      "CACHE_WRITE_FAILED",
      "PARTIAL_TRANSLATION",
      "SLOW_BATCH_RETRY",
      "TRANSLATION_WARNING",
      "UNSUPPORTED_TARGET_LANGUAGE",
    ]);
    if (!knownWarningCodes.has(code)) return "TRANSLATION_WARNING";
    return code === "CACHE_INVALID_IGNORED" ? "INVALID_TRANSLATION_CACHE" : code;
  }

  function withFallbackErrorCode(error, code, phase) {
    const inferredCode = String(ns.errorUtils?.getErrorCode?.(error) || "").toUpperCase();
    if (inferredCode && !["ERROR", "UNKNOWN", "UNKNOWN_ERROR", "TRANSLATION_ERROR", "FAILURE_DETAIL_MISSING"].includes(inferredCode)) return error;
    const typed = error instanceof Error ? error : new Error(String(error || "操作失败"));
    typed.code = code;
    typed.phase = typed.phase || phase;
    return typed;
  }

  async function onTargetChanged(event) {
    try {
      const cfg = await ns.storage.getConfig();
      cfg.target = (event.target.value || "ZH").toUpperCase();
      await ns.storage.saveConfig(cfg);
      lastKnownConfig = cfg;
      invalidateManualSession();
      const video = ns.video.getPrimaryVideo?.();
      if (video) void primeManualSession(video).catch(() => {});
      ns.ui.clearError?.();
      ns.ui.setStatusText(`目标语言已改为 ${cfg.target}`, "success");
    } catch (error) {
      console.error("[echo360-translator][controller] target preference failed", safeErrorForLog(error, { phase: "preferences" }));
      const typedError = withFallbackErrorCode(error, "PREFERENCES_ERROR", "preferences");
      ns.ui.showError?.(typedError, {
        phase: "preferences",
        title: "目标语言保存失败",
        recommendation: "检查浏览器扩展存储权限后重试。",
        onCancel: () => ns.ui.clearError?.(),
      });
    }
  }

  async function onPrefsChanged() {
    let renderWarning = null;
    try {
      const oldPrefs = await ns.storage.getPrefs();
      const prefs = ns.ui.readPanelPrefs();
      await ns.storage.savePrefs(prefs);
      ns.renderer.applySubtitleSize(prefs.size);

      const renderState = ns.renderer.getRenderState();
      if (
        renderState.lastRenderedVtt &&
        (
          oldPrefs.bilingual !== prefs.bilingual ||
          oldPrefs.reverseOrder !== prefs.reverseOrder ||
          oldPrefs.useNativeSubtitles !== prefs.useNativeSubtitles ||
          oldPrefs.size !== prefs.size ||
          oldPrefs.transcriptPanelEnabled !== prefs.transcriptPanelEnabled
        )
      ) {
        const mounted = renderTranslationSurfaces({
          translatedVtt: renderState.lastRenderedVtt,
          originalVtt: renderState.lastOriginalVtt,
          prefs,
          sourceMeta: renderState.lastRenderSourceMeta,
          onSurfaceWarning: (warning) => { renderWarning = warning; },
        });
        if (!mounted) {
          throw Object.assign(new Error("字幕设置已保存，但当前播放器字幕层没有挂载成功"), {
            code: "RENDER_MOUNT_FAILED",
            phase: "render",
          });
        }
      }
      ns.renderer.applySubtitleVisibility(prefs.enabled);
      if (ns.transcriptPanelRenderer && prefs.transcriptPanelEnabled === false) {
        ns.transcriptPanelRenderer.setVisible(false);
      }
      if (renderWarning) {
        ns.ui.showError?.(renderWarning, {
          context: { phase: "render", severity: "warning" },
          onCancel: () => ns.ui.clearError?.(),
        });
      } else {
        ns.ui.clearError?.();
      }
    } catch (error) {
      console.error("[echo360-translator][controller] subtitle preference failed", safeErrorForLog(error, { phase: "preferences" }));
      const typedError = withFallbackErrorCode(error, "PREFERENCES_ERROR", "preferences");
      ns.ui.showError?.(typedError, {
        phase: "preferences",
        onCancel: () => ns.ui.clearError?.(),
      });
    }
  }

  function manualWorkflowError(error, fallbackCode = "MANUAL_TRANSLATION_ERROR") {
    const typed = error instanceof Error ? error : new Error(String(error || "AI 手动翻译操作失败"));
    typed.code = typed.code || fallbackCode;
    typed.phase = typed.phase || "manual-import";
    console.error("[echo360-translator][manual] operation failed", safeErrorForLog(typed, { phase: typed.phase }));
    ns.ui.setManualMessage?.(`[${typed.code}] ${typed.message}`, "error");
    ns.ui.showError?.(typed, {
      context: { phase: typed.phase },
      onCancel: () => ns.ui.clearError?.(),
    });
    return typed;
  }

  function primeManualSession(video) {
    const ready = currentManualSession(video);
    if (ready) return Promise.resolve(ready);

    const context = {
      video,
      location: location.href,
      videoHint: manualVideoHint(video),
      generation: manualGeneration,
    };
    if (manualPreparationPromise && manualPreparationContext &&
      manualPreparationContext.video === context.video &&
      manualPreparationContext.location === context.location &&
      manualPreparationContext.videoHint === context.videoHint &&
      manualPreparationContext.generation === context.generation) {
      return manualPreparationPromise;
    }

    manualPreparationContext = context;
    const preparation = (async () => {
      const { vttText, sourceId, sourceMeta } = await ns.translationService.resolveSourceVtt(video);
      const cfg = await ns.storage.getConfig();
      lastKnownConfig = cfg;
      const target = String(cfg.target || "ZH").toUpperCase();
      const targetLabel = ns.constants.TARGET_LABELS[target] || target;
      const cueCount = ns.vtt.parseVttCues(vttText).length;
      if (!cueCount) {
        throw Object.assign(new Error("当前字幕没有可导出的 cue"), {
          code: "INVALID_SOURCE_VTT",
          phase: "source",
        });
      }

      const sourceHash = await ns.storage.sha256Text(vttText);
      const packageResult = ns.manualTranslation.createTranslationPackage({
        sourceVtt: vttText,
        sourceHash,
        target,
        targetLabel,
        title: document.title || "",
        vtt: ns.vtt,
      });
      let workflow = packageResult.workflow || null;
      if (workflow) {
        try { workflow = await ns.manualTranslation.restoreProgress(workflow); }
        catch (_) { /* Storage may be unavailable; an in-memory session still works. */ }
      }
      const translationPackage = workflow ? ns.manualTranslation.createFilePackage(workflow) : packageResult.translationPackage;
      const prompt = translationPackage ? ns.manualTranslation.buildPrompt({
        target, targetLabel, cueCount, translationPackage, fullCourse: !!workflow,
      }) : "";
      const base = ns.manualTranslation.safeFilenamePart(document.title || "echo360-course", "echo360-course").slice(0, 40);
      const session = {
        sourceVtt: vttText,
        sourceId,
        sourceMeta,
        sourceHash,
        sourceVideo: video,
        sourceVideoHint: context.videoHint,
        generation: context.generation,
        sourceLocation: context.location,
        target,
        targetLabel,
        cueCount,
        filenameBase: `${base}-${target}-${sourceHash.slice(0, 8)}`,
        translationPackage,
        workflow,
        exportMode: "file",
        // This file is model input, not a human-edited config file. Omitting
        // indentation saves context tokens on long lectures without changing
        // the JSON data or its deterministic cue order.
        packageJson: `${JSON.stringify(translationPackage)}\n`,
        prompt,
        createdAt: Date.now(),
      };
      if (!isManualContextCurrent(context)) {
        throw Object.assign(new Error("课程或播放器已切换，已丢弃旧字幕准备结果"), {
          code: "MANUAL_SESSION_SOURCE_CHANGED",
          phase: "source",
        });
      }
      manualSession = session;
      manualPrimeRetryAt = 0;
      manualPrimeFailureKey = "";
      setManualSessionReady(session);
      return session;
    })();
    manualPreparationPromise = preparation;
    preparation.finally(() => {
      if (manualPreparationPromise === preparation) manualPreparationPromise = null;
    }).catch(() => {});
    return preparation;
  }

  function setManualSessionReady(session, extra = {}) {
    ns.ui.setManualReady?.({ cueCount: session.cueCount, targetLabel: session.targetLabel,
      ...(session.workflow ? { progress: ns.manualTranslation.workflowProgress(session.workflow), mode: session.exportMode } : {}), ...extra });
  }

  function refreshManualMaterials(session) {
    session.translationPackage = session.exportMode === "file"
      ? ns.manualTranslation.createFilePackage(session.workflow) : ns.manualTranslation.currentPackage(session.workflow);
    session.packageJson = session.translationPackage ? `${JSON.stringify(session.translationPackage)}\n` : "";
    session.prompt = session.translationPackage ? ns.manualTranslation.buildPrompt({
      target: session.target, targetLabel: session.targetLabel, cueCount: session.cueCount,
      translationPackage: session.translationPackage, fullCourse: session.exportMode === "file",
    }) : "";
  }

  function toggleManualMode() {
    if (isTranslating) return null;
    try {
      const session = requireManualSession();
      if (!session.workflow || ns.manualTranslation.workflowProgress(session.workflow).complete) return null;
      session.exportMode = session.exportMode === "file" ? "batch" : "file";
      refreshManualMaterials(session);
      setManualSessionReady(session);
      return exportManualBundle(session, { copyOutcome: startPromptCopy(session) });
    } catch (error) { manualWorkflowError(error); return null; }
  }

  function manualExportFilename(session) {
    const request = session.translationPackage?.request_id;
    return `${session.filenameBase}${request ? `-${request}` : ""}.translate.json`;
  }

  async function loadCompletedManualSession(session) {
    const translatedVtt = ns.manualTranslation.buildWorkflowVtt(session.sourceVtt, session.workflow);
    const prefs = await ns.storage.getPrefs();
    if (currentManualSession() !== session) throw Object.assign(new Error("课程或目标语言已变化"), { code: "MANUAL_SESSION_SOURCE_CHANGED" });
    prefs.target = session.target;
    const mounted = renderTranslationSurfaces({ translatedVtt, originalVtt: session.sourceVtt, prefs,
      sourceMeta: { ...session.sourceMeta, manualImport: true, target: session.target, sessionKey: session.workflow.sessionId } });
    if (!mounted) throw Object.assign(new Error("没有找到可挂载的播放器字幕层"), { code: "RENDER_MOUNT_FAILED" });
    loadedCacheKey = "";
    ns.renderer.applySubtitleVisibility(prefs.enabled !== false);
    setManualSessionReady(session);
    ns.ui.setManualMessage?.("已恢复并加载全部手动译文；可下载完整 VTT 保存。", "success");
    return true;
  }

  function maybePrimeManualSession(video) {
    if (!video || typeof ns.translationService?.resolveSourceVtt !== "function" ||
      typeof ns.manualTranslation?.buildPrompt !== "function" ||
      typeof ns.manualTranslation?.createTranslationPackage !== "function" || currentManualSession(video)) return;
    const context = { video, location: location.href, videoHint: manualVideoHint(video), generation: manualGeneration };
    const key = `${context.location}::${context.videoHint}`;
    if (manualPrimeFailureKey === key && Date.now() < manualPrimeRetryAt) return;
    void primeManualSession(video).catch((error) => {
      if (isManualContextCurrent(context)) {
        manualPrimeFailureKey = key;
        manualPrimeRetryAt = Date.now() + 15000;
      }
      console.info("[echo360-translator][manual] source prefetch deferred", safeErrorForLog(error, { phase: "source" }));
    });
  }

  function makeCopyOutcome(copyPromise) {
    return Promise.resolve(copyPromise).then(
      () => ({ ok: true, error: null }),
      (error) => ({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error || "提示词复制失败")),
      })
    );
  }

  function startPromptCopy(session) {
    // Keep this call synchronous with the click handler. copyText() invokes
    // navigator.clipboard.writeText() before returning its promise.
    try {
      return makeCopyOutcome(ns.manualTranslation.copyText(session.prompt));
    } catch (error) {
      return makeCopyOutcome(Promise.reject(error));
    }
  }

  function prepareManualTranslation({ quick = false } = {}) {
    const ready = currentManualSession();
    if (ready) {
      setManualSessionReady(ready);
      if (ready.workflow && ns.manualTranslation.workflowProgress(ready.workflow).complete) {
        if (quick) return Promise.resolve(true);
        return loadCompletedManualSession(ready).catch((error) => manualWorkflowError(error));
      }
      return exportManualBundle(ready, { quick, copyOutcome: startPromptCopy(ready) });
    }

    ns.ui.clearError?.();
    ns.ui.setManualBusy?.("正在读取并校验当前课程字幕…");
    const immediateVideo = ns.video.getPrimaryVideo?.();
    const sessionPromise = immediateVideo
      ? primeManualSession(immediateVideo)
      : ns.video.waitForVideo(15000).then((video) => {
        if (!video) throw Object.assign(new Error("未找到当前播放器"), { code: "VIDEO_NOT_FOUND", phase: "video" });
        return primeManualSession(video);
      });

    // When preparation is cold, WebKit's supported pattern is to initiate
    // clipboard.write() now with a promised ClipboardItem payload. Older
    // browsers fall back to copyText after preparation and keep manual retry.
    const deferredCopy = typeof ns.manualTranslation.copyDeferredText === "function"
      ? makeCopyOutcome(ns.manualTranslation.copyDeferredText(sessionPromise.then((session) => {
        if (!session.prompt) throw Object.assign(new Error("已恢复完成的手动译文，无需复制新材料"), { code: "MANUAL_ALREADY_COMPLETE" });
        return session.prompt;
      })))
      : null;

    return sessionPromise
      .then((session) => {
        setManualSessionReady(session);
        if (session.workflow && ns.manualTranslation.workflowProgress(session.workflow).complete) return quick ? true : loadCompletedManualSession(session);
        return exportManualBundle(session, {
          quick,
          copyOutcome: deferredCopy || startPromptCopy(session),
        });
      })
      .catch((error) => {
        if (!currentManualSession()) manualSession = null;
        manualWorkflowError(error, "MANUAL_EXPORT_FAILED");
        return false;
      });
  }

  function requireManualSession() {
    const session = currentManualSession();
    if (session) return session;
    throw Object.assign(new Error("请先点击“AI 手动翻译”准备当前字幕"), {
      code: "MANUAL_SESSION_MISSING",
      phase: "manual-export",
    });
  }

  function downloadManualVtt() {
    try {
      const session = requireManualSession();
      if (session.workflow && ns.manualTranslation.workflowProgress(session.workflow).complete) {
        ns.manualTranslation.downloadText(ns.manualTranslation.buildWorkflowVtt(session.sourceVtt, session.workflow), `${session.filenameBase}.vtt`, "text/vtt;charset=utf-8");
        ns.ui.setManualMessage?.("完整手动译文 VTT 已下载。", "success");
        return;
      }
      ns.manualTranslation.downloadText(
        session.packageJson,
        manualExportFilename(session),
        "application/json;charset=utf-8"
      );
      ns.ui.setManualMessage?.("AI 翻译完整 JSON 文件已下载；现在把文件和提示词一起交给 AI。", "success");
    } catch (error) {
      manualWorkflowError(error, "MANUAL_EXPORT_FAILED");
    }
  }

  async function exportManualBundle(session = requireManualSession(), { quick = false, copyOutcome = null } = {}) {
    let downloadError = null;
    let copyError = null;
    // Invoke clipboard first, but do not await it before starting the download:
    // both browser APIs get the original user gesture and remain independently
    // recoverable. The result accounting happens only after both have started.
    const pendingCopy = copyOutcome || startPromptCopy(session);
    try {
      ns.manualTranslation.downloadText(
        session.packageJson,
        manualExportFilename(session),
        "application/json;charset=utf-8"
      );
    } catch (error) {
      downloadError = error instanceof Error ? error : new Error(String(error || "AI 翻译 JSON 下载失败"));
    }
    const copied = await pendingCopy;
    if (!copied.ok) copyError = copied.error;

    if (!downloadError && !copyError) {
      ns.ui.setManualMessage?.(session.workflow
        ? (session.exportMode === "file"
          ? `AI 翻译完整 JSON 已下载（${Object.keys(session.translationPackage.cues || {}).length} 条），任务说明已复制。把 JSON 和说明一次交给 AI，完成后返回一个完整结果文件。`
          : `第 ${session.translationPackage.part} 批材料已复制（含字幕），直接粘贴给 AI；返回后导入即可继续。JSON 文件也已下载备用。`)
        : "AI 翻译 JSON 包已自动下载，提示词已自动复制；把两者一起交给 AI。", "success");
      if (!quick) ns.ui.setStatusText("AI 手动翻译材料已自动导出", "success");
      return true;
    }

    const typed = downloadError || copyError || new Error("手动翻译材料导出失败");
    if (downloadError && copyError) {
      typed.message = "AI 翻译 JSON 和提示词都未能自动导出；请使用下方的手动导出/复制按钮重试。";
    } else if (downloadError) {
      typed.message = `提示词已复制，但 AI 翻译 JSON 文件未能自动下载；请点击“手动下载完整 JSON”重试。`;
    } else {
      typed.code = "CLIPBOARD_COPY_FAILED";
      typed.message = `AI 翻译 JSON 文件已自动下载，但浏览器未允许自动复制提示词；请点击“${session.exportMode === "file" ? "复制任务说明" : "复制本批材料"}”，或使用“手动下载提示词 .txt”。`;
    }
    ns.ui.setManualMessage?.(typed.message, "warning");
    if (quick) {
      ns.ui.showManualRecovery?.();
    } else {
      ns.ui.setStatusText(typed.message, "warning");
    }
    return false;
  }

  async function copyManualPrompt() {
    try {
      const session = requireManualSession();
      if (!session.prompt) return;
      await ns.manualTranslation.copyText(session.prompt);
      ns.ui.setManualMessage?.(session.workflow
        ? (session.exportMode === "file" ? "完整 JSON 的提示词已复制；请连同下载的 JSON 一次交给 AI。" : `第 ${session.translationPackage.part} 批材料已复制，直接粘贴给 AI。`)
        : "提示词已复制到剪贴板。", "success");
    } catch (error) {
      manualWorkflowError(error, "CLIPBOARD_COPY_FAILED");
    }
  }

  function downloadManualPrompt() {
    try {
      const session = requireManualSession();
      ns.manualTranslation.downloadText(
        `${session.prompt}\n`,
        `${session.filenameBase}-prompt.txt`,
        "text/plain;charset=utf-8"
      );
      ns.ui.setManualMessage?.("提示词文件已下载。", "success");
    } catch (error) {
      manualWorkflowError(error, "MANUAL_EXPORT_FAILED");
    }
  }

  const MANUAL_CLIPBOARD_FALLBACK_CODES = new Set([
    "CLIPBOARD_READ_UNAVAILABLE",
    "CLIPBOARD_READ_FAILED",
    "MANUAL_IMPORT_EMPTY",
    "MANUAL_IMPORT_FILE_TOO_LARGE",
    "MANUAL_IMPORT_MARKDOWN_WRAPPER",
    "INVALID_TRANSLATED_VTT",
    "INCOMPLETE_TRANSLATED_VTT",
    "MANUAL_IMPORT_METADATA_MISMATCH",
    "MANUAL_IMPORT_CUE_ID_MISMATCH",
    "MANUAL_IMPORT_CUE_TEXT_LINE_COUNT_MISMATCH",
    "TRANSLATION_TIMELINE_MISMATCH",
    "MANUAL_IMPORT_CUE_MARKUP_MISMATCH",
    "MANUAL_IMPORT_JSON_INVALID",
    "MANUAL_IMPORT_JSON_TYPE_INVALID",
    "MANUAL_IMPORT_JSON_SCHEMA_MISMATCH",
    "MANUAL_IMPORT_SCHEMA_VERSION_UNSUPPORTED",
    "MANUAL_IMPORT_SESSION_MISMATCH",
    "MANUAL_IMPORT_DUPLICATE_CUE_ID",
    "MANUAL_IMPORT_PROTECTED_TOKEN_MISMATCH",
    "MANUAL_IMPORT_SOURCE_LITERAL_MISMATCH",
    "INCOMPLETE_TRANSLATED_JSON",
    "INVALID_TRANSLATED_JSON",
  ]);

  function isClipboardFallbackError(error) {
    return MANUAL_CLIPBOARD_FALLBACK_CODES.has(String(error?.code || "").toUpperCase());
  }

  function manualImportWarning(error, source = "剪贴板") {
    const code = String(error?.code || "MANUAL_IMPORT_FAILED").toUpperCase();
    const message = String(error?.message || "翻译结果校验失败").replace(/\s+/g, " ").trim();
    return `${source}中的翻译结果不符合要求：[${code}] ${message}。请修正后重试，或点击“从文件导入”。`;
  }

  // Manual sessions intentionally use `sourceVtt` because that field is also
  // the immutable snapshot used by export/import. The normal translation
  // pipeline, however, consumes the source resolver contract (`vttText`).
  // Convert at this boundary instead of leaking the two field names into
  // callers. Returning null for a malformed/stale session makes the caller
  // resolve a fresh source rather than ever sending `vtt_text: undefined`.
  function manualSessionToSourceSnapshot(session) {
    if (!session || typeof session.sourceVtt !== "string" || !session.sourceVtt.trim()) return null;
    return {
      vttText: session.sourceVtt,
      sourceId: session.sourceId || "",
      sourceMeta: session.sourceMeta || null,
    };
  }

  async function importManualTranslation(file = null) {
    const fromClipboard = !file;
    let session = null;
    if (isTranslating) {
      ns.ui.setManualMessage?.("已有翻译或导入任务正在进行，请稍候。", "warning");
      return null;
    }
    isTranslating = true;
    ns.ui.clearError?.();
    ns.ui.setManualBusy?.(fromClipboard
      ? "正在读取剪贴板中的 AI JSON 译文…"
      : "正在验证文件、课程指纹和全部 cue ID…");
    try {
      session = requireManualSession();
      let importedText;
      if (fromClipboard) {
        let clipboardText;
        try {
          clipboardText = await ns.manualTranslation.readClipboardText();
        } catch (error) {
          if (session) setManualSessionReady(session);
          ns.ui.setManualMessage?.(manualImportWarning(error, "剪贴板"), "warning");
          return false;
        }
        const shape = ns.manualTranslation.inspectTranslation?.(clipboardText) || ns.manualTranslation.inspectVtt?.(clipboardText);
        if (shape && !shape.ok) {
          const shapeError = Object.assign(new Error(shape.message || "翻译结果校验失败"), {
            code: shape.code || "MANUAL_IMPORT_JSON_INVALID",
            details: shape.details || {},
            phase: "manual-import",
          });
          setManualSessionReady(session);
          ns.ui.setManualMessage?.(manualImportWarning(shapeError, "剪贴板"), "warning");
          return false;
        }
        if (!shape && !ns.manualTranslation.looksLikeVtt?.(clipboardText)) {
          setManualSessionReady(session);
          ns.ui.setManualMessage?.(manualImportWarning(Object.assign(new Error("内容既不是有效 JSON 译文，也不是完整 WebVTT"), {
            code: "MANUAL_IMPORT_JSON_INVALID",
          }), "剪贴板"), "warning");
          return false;
        }
        importedText = String(clipboardText || "").trim();
      } else {
        const readFile = ns.manualTranslation.readTranslationFile || ns.manualTranslation.readVttFile;
        importedText = await readFile(file);
      }
      const video = await ns.video.waitForVideo(15000);
      if (!video) throw Object.assign(new Error("未找到当前播放器"), { code: "VIDEO_NOT_FOUND", phase: "video" });
      const current = await ns.translationService.resolveSourceVtt(video);
      const currentHash = await ns.storage.sha256Text(current.vttText);
      if (video !== session.sourceVideo || currentHash !== session.sourceHash || location.href !== session.sourceLocation) {
        throw Object.assign(new Error("当前课程或原字幕已变化，请重新准备材料后再导入"), {
          code: "MANUAL_SESSION_SOURCE_CHANGED",
          phase: "manual-import",
        });
      }
      const cfg = await ns.storage.getConfig();
      lastKnownConfig = cfg;
      if (String(cfg.target || "ZH").toUpperCase() !== session.target) {
        throw Object.assign(new Error("目标语言已改变，请按当前目标语言重新准备提示词"), {
          code: "MANUAL_SESSION_TARGET_CHANGED",
          phase: "manual-import",
        });
      }
      let validation;
      try {
        validation = typeof ns.manualTranslation.validateImportedTranslation === "function"
          ? ns.manualTranslation.validateImportedTranslation(importedText, session, { vtt: ns.vtt })
          : ns.manualTranslation.validateImportedVtt(importedText, session.sourceVtt, { vtt: ns.vtt });
      } catch (error) {
        // A complete-file result can have one cue rejected by a local quality
        // heuristic even though the rest is usable. Retry only this manual
        // JSON import with the cue-level salvage validator; malformed JSON,
        // identity errors, extra IDs, and schema errors remain strict.
        const shape = ns.manualTranslation.inspectTranslation?.(importedText);
        if (shape?.type !== "json" || shape.parsed?.schema_version !== "2.0" ||
          typeof ns.manualTranslation.validateImportedJsonPartial !== "function") throw error;
        try {
          const packageForImport = session.workflow
            ? ns.manualTranslation.createFilePackage(session.workflow)
            : session.translationPackage;
          validation = ns.manualTranslation.validateImportedJsonPartial(
            importedText,
            packageForImport,
            session.sourceVtt,
            { vtt: ns.vtt, workflow: session.workflow },
          );
        } catch (_) {
          throw error;
        }
      }
      const prefs = await ns.storage.getPrefs();
      if (currentManualSession() !== session) {
        throw Object.assign(new Error("课程、字幕或目标语言已切换，请重新打开手动翻译"), { code: "MANUAL_SESSION_SOURCE_CHANGED" });
      }
      let progressWarning = "";
      if (validation.workflow) {
        session.workflow = validation.workflow;
        refreshManualMaterials(session);
        try {
          if (!await ns.manualTranslation.saveProgress(session.workflow)) progressWarning = "当前浏览器无法保存进度，关闭页面前请完成翻译。";
        } catch (_) { progressWarning = "进度保留在当前页面，但本地保存失败；关闭页面前请完成翻译。"; }
        if (currentManualSession() !== session) throw Object.assign(new Error("课程或目标语言已变化"), { code: "MANUAL_SESSION_SOURCE_CHANGED" });
        setManualSessionReady(session);
        if (!validation.complete) {
          const { completed, total, part } = validation.progress;
          const issues = validation.issues || [];
          const failedItems = issues.map((item) => ({
            id: item.id,
            code: item.code || "MANUAL_IMPORT_TRANSLATION_QUALITY",
            message: item.message || "译文校验失败",
          }));
          const partialDecision = validation.format === "json-partial" &&
            typeof ns.manualTranslation.evaluatePartialCacheability === "function"
            ? ns.manualTranslation.evaluatePartialCacheability({
              total,
              translated: completed,
              failed: failedItems.length,
            }, failedItems)
            : { cacheable: false, reason: "workflow_not_complete" };
          if (partialDecision.cacheable && typeof ns.manualTranslation.buildWorkflowPreviewVtt === "function") {
            try {
              const savedPartial = await ns.manualTranslation.saveProgress(session.workflow, undefined, {
                partialCache: {
                  failedIds: failedItems.map((item) => item.id),
                  metrics: {
                    total,
                    translated: completed,
                    failed: failedItems.length,
                  },
                  reason: partialDecision.reason,
                },
              });
              if (!savedPartial && !progressWarning) progressWarning = "当前浏览器无法保存手动翻译进度，关闭页面前请完成修复。";
            } catch (_) {
              if (!progressWarning) progressWarning = "部分结果已加载，但手动翻译进度保存失败；关闭页面前请完成修复。";
            }
            let previewVtt = validation.translatedVtt || "";
            try {
              if (!previewVtt) previewVtt = ns.manualTranslation.buildWorkflowPreviewVtt(session.sourceVtt, session.workflow, ns.vtt);
            } catch (error) {
              console.warn("[echo360-translator][manual] partial preview could not be rebuilt", safeErrorForLog(error, { phase: "manual-import" }));
              previewVtt = "";
            }
            if (previewVtt) {
              prefs.target = session.target;
              const failedCues = failedCuesFromManualIssues(issues, session);
              const mounted = renderTranslationSurfaces({
                translatedVtt: previewVtt,
                originalVtt: session.sourceVtt,
                prefs,
                sourceMeta: {
                  ...(current.sourceMeta || session.sourceMeta || {}),
                  target: session.target,
                  manualImport: true,
                  manualPartial: true,
                  sessionKey: `manual:${session.sourceHash}:${session.target}`,
                },
                options: {
                  previewPending: true,
                  markPending: false,
                  failedCues,
                  failureLabel: ns.constants.SUBTITLE_FAILURE_LABEL,
                },
              });
              loadedCacheKey = "";
              if (mounted) {
                ns.renderer.applySubtitleVisibility(prefs.enabled !== false);
                ns.ui.updateActionButtons("部分手动译文已加载", false);
              }
              const partialMessage = `已加载 ${completed}/${total} 条手动译文；${failedItems.length} 条待修复。其余译文已保存在本机进度中，点击“${session.exportMode === "file" ? "手动下载完整 JSON" : "复制本批材料"}”补译；需要整段重做时使用“重新翻译”。`;
              ns.ui.setManualReady?.({
                cueCount: validation.cueCount,
                targetLabel: session.targetLabel,
                progress: ns.manualTranslation.workflowProgress(session.workflow),
                mode: session.exportMode,
                warning: partialMessage,
              });
              ns.ui.setManualMessage?.(`${partialMessage}${progressWarning ? ` ${progressWarning}` : ""}`, "warning");
              ns.ui.setStatusText("部分手动译文已加载，待修复条目已标记", "warning");
              console.info("[echo360-translator][manual] partial import applied", {
                cueCount: validation.cueCount,
                completed,
                total,
                failedItems: failedItems.length,
                cacheable: true,
                cacheReason: partialDecision.reason,
                mounted,
              });
              return true;
            }
          }
          const message = issues.length
            ? `已保留 ${completed}/${total} 条合格译文；${issues.length} 条需修复（${issues.slice(0, 3).map((item) => item.id).join("、")}）：${issues[0].message}。${session.exportMode === "file" ? "请重新下载完整 JSON 交给 AI，修复后再导入。" : "点击“复制本批材料”交给 AI，只补译这些条目。"}`
            : `已保存 ${completed}/${total} 条，下一批 ${part} 已准备好。${session.exportMode === "file" ? "请重新下载完整 JSON 交给 AI。" : "点击“复制本批材料”继续；"}全部完成后自动加载。`;
          ns.ui.setManualMessage?.(`${message}${progressWarning ? ` ${progressWarning}` : ""}`, issues.length || progressWarning ? "warning" : "success");
          return true;
        }
      }

      // A complete manual result is a valid translation result too. Persist
      // it under the same cache identity used by the normal translation path
      // so a later subtitle sync cannot resurrect the older complete VTT.
      // Partial manual imports return above after saving the manual workflow
      // progress; they never change the direct-translation cache.
      let importedCacheKey = "";
      let importedCacheWarning = "";
      if (validation.translatedVtt) {
        if (typeof ns.translationService?.buildCacheKey !== "function" || typeof ns.storage?.setCacheStore !== "function") {
          importedCacheWarning = "AI 译文已加载，但当前版本无法更新本地缓存；请保持当前页面打开";
        } else {
          try {
            const cacheIdentity = await ns.translationService.buildCacheKey(cfg, current.sourceId, current.vttText);
            const cacheResult = await ns.storage.setCacheStore({
              cacheKey: cacheIdentity.cacheKey,
              sourceKey: cacheIdentity.sourceKey,
              configSig: cacheIdentity.configSig,
              translatedVtt: validation.translatedVtt,
              createdAt: Date.now(),
            });
            if (cacheResult?.ok === false) {
              const cacheError = cacheResult.error || new Error("本地缓存更新失败");
              importedCacheWarning = `AI 译文已加载，但本地缓存更新失败：${cacheError.message || "请保持当前页面打开"}`;
              console.warn("[echo360-translator][manual] imported translation cache update failed", safeErrorForLog(cacheError, { phase: "cache" }));
            } else {
              importedCacheKey = cacheIdentity.cacheKey;
            }
          } catch (error) {
            importedCacheWarning = `AI 译文已加载，但本地缓存更新失败：${error.message || "请保持当前页面打开"}`;
            console.warn("[echo360-translator][manual] imported translation cache update failed", safeErrorForLog(error, { phase: "cache" }));
          }
        }
      }
      if (currentManualSession() !== session) {
        throw Object.assign(new Error("课程、字幕或目标语言已切换，请重新打开手动翻译"), { code: "MANUAL_SESSION_SOURCE_CHANGED" });
      }
      prefs.target = session.target;
      const mounted = renderTranslationSurfaces({
        translatedVtt: validation.translatedVtt,
        originalVtt: session.sourceVtt,
        prefs,
        sourceMeta: {
          ...(current.sourceMeta || session.sourceMeta || {}),
          target: session.target,
          manualImport: true,
          sessionKey: importedCacheKey || `manual:${session.sourceHash}:${session.target}`,
        },
      });
      if (!mounted) {
        throw Object.assign(new Error("译文有效，但没有找到可挂载的播放器字幕层"), {
          code: "RENDER_MOUNT_FAILED",
          phase: "render",
        });
      }
      loadedCacheKey = mounted ? importedCacheKey : "";
      ns.renderer.applySubtitleVisibility(prefs.enabled !== false);
      ns.ui.updateActionButtons("翻译字幕已加载", false);
      const importWarnings = [progressWarning, importedCacheWarning, validation.warning]
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      ns.ui.setManualReady?.({
        cueCount: validation.cueCount,
        targetLabel: session.targetLabel,
        ...(validation.workflow ? { progress: ns.manualTranslation.workflowProgress(session.workflow), mode: session.exportMode } : {}),
        warning: importWarnings.join("；") || `外部 AI 译文已加载（${validation.cueCount} 个 cue）`,
      });
      ns.ui.setStatusText(
        importedCacheKey ? "外部 AI 翻译已加载，本地缓存已更新" : "外部 AI 翻译已加载",
        importWarnings.length ? "warning" : "success"
      );
      if (importWarnings.length) ns.ui.setManualMessage?.(importWarnings.join("；"), "warning");
      console.info("[echo360-translator][manual] imported translation applied", {
        cueCount: validation.cueCount,
        unchangedCues: validation.unchangedCues,
        cacheUpdated: !!importedCacheKey,
        sourceHash: session.sourceHash.slice(0, 12),
        target: session.target,
      });
      return true;
    } catch (error) {
      if (fromClipboard && isClipboardFallbackError(error)) {
        if (session) setManualSessionReady(session);
        ns.ui.setManualMessage?.(manualImportWarning(error, "剪贴板"), "warning");
        return false;
      }
      if (manualSession) {
        setManualSessionReady(manualSession);
      }
      manualWorkflowError(error, "MANUAL_IMPORT_FAILED");
      return null;
    } finally {
      isTranslating = false;
    }
  }

  async function preparedManualSource(video) {
    let session = currentManualSession(video);
    if (session) return manualSessionToSourceSnapshot(session);
    const context = manualPreparationContext;
    const pending = manualPreparationPromise;
    if (pending && context?.video === video && isManualContextCurrent(context)) {
      try {
        await pending;
      } catch (_) {
        return null;
      }
      session = currentManualSession(video);
    }
    return manualSessionToSourceSnapshot(session);
  }

  function hasExistingTranslation(video = ns.video.getPrimaryVideo?.()) {
    if (!video) return false;
    const renderState = ns.renderer?.getRenderState?.() || {};
    if (renderState.lastRenderedVideo === video &&
      typeof renderState.lastRenderedVtt === "string" && renderState.lastRenderedVtt.trim()) {
      return true;
    }
    if (ns.renderer?.hasRenderedTranslatedTrack?.() &&
      (!renderState.lastRenderedVideo || renderState.lastRenderedVideo === video)) {
      return true;
    }
    return Array.from(video.querySelectorAll?.('track[data-echo360-translated="1"], track[label*="翻译字幕"]') || [])
      .some((track) => !!String(track.getAttribute?.("src") || "").trim());
  }

  function confirmRetranslation() {
    const message = [
      "当前视频已经存在翻译字幕。",
      "是否清除当前结果并重新翻译？",
      "确认后会重新生成完整 JSON、复制 AI 提示词，并重新开始翻译。",
      "选择“取消”将保留当前字幕，也不会重复下载 AI 翻译材料。",
    ].join("\n");
    try {
      return typeof window.confirm === "function" && window.confirm(message);
    } catch (error) {
      console.warn("[echo360-translator][controller] retranslation confirmation unavailable", safeErrorForLog(error, { phase: "translation" }));
      return false;
    }
  }

  function runQuickWorkflow(forceRefresh = false) {
    // Keep the one-click action as one workflow even after the user confirms
    // a retranslation. The material export and provider request share the
    // same prefetched source snapshot; the force flag only controls
    // translation-cache/track invalidation.
    const manualRun = prepareManualTranslation({ quick: true });
    const translationRun = onClickTranslate(forceRefresh);
    return Promise.allSettled([manualRun, translationRun]);
  }

  async function quickTranslate() {
    const video = ns.video.getPrimaryVideo?.();
    if (hasExistingTranslation(video)) {
      if (!confirmRetranslation()) {
        ns.ui.setStatusText("当前翻译字幕已保留，未重新翻译，也未重复下载材料。", "info");
        return false;
      }
      return runQuickWorkflow(true);
    }

    // Start material export first so Clipboard API invocation is closest to
    // the user's click. The normal translation/cache path then runs in
    // parallel and reuses the same prepared source snapshot when available.
    return runQuickWorkflow(false);
  }

  async function onClickTranslate(forceRefresh = false) {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runStartedAt = performance.now();
    if (isTranslating) {
      ns.ui.setStatusText("已有翻译任务在进行中，请稍候...", "warning");
      return;
    }
    isTranslating = true;
    activeRunId = runId;

    // Start the native launch request at the beginning of the click handler.
    // Waiting for video/source discovery first can lose the browser's user
    // activation, which makes custom-protocol launches intermittent.
    const warmupConfig = lastKnownConfig;
    const argosWarmup = String(warmupConfig?.provider || "").toLowerCase() === "argos"
      ? ns.backendClient.ensureArgosBackend(warmupConfig.backendUrl || "http://127.0.0.1:8765")
      : null;
    // Mark the rejection handled immediately; translateWithConfig will await
    // the same keyed startup attempt and surface its structured diagnosis.
    argosWarmup?.catch(() => {});

    const diagnosticContext = {
      runId,
      phase: "prepare",
      forceRefresh,
    };

    let incrementalPreviewMounted = false;
    let translatedPreviewStarted = false;
    let lastPreviewVtt = "";
    let lastPreviewMeta = {};
    let previewRenderArgs = null;
    let lastProgressKey = "";
    let cacheWarningError = null;
    const surfaceWarnings = [];

    const collectSurfaceWarning = (warning) => {
      const candidate = warning instanceof Error
        ? warning
        : Object.assign(new Error(String(warning || "字幕显示表面同步失败")), {
          code: "TRANSCRIPT_PANEL_RENDER_FAILED",
          phase: "render",
        });
      const message = String(candidate.message || "字幕显示表面同步失败").replace(/\s+/g, " ").trim();
      const code = String(candidate.code || "TRANSCRIPT_PANEL_RENDER_FAILED").trim().toUpperCase();
      if (!surfaceWarnings.some((item) =>
        String(item?.code || "").toUpperCase() === code &&
        String(item?.message || item || "").replace(/\s+/g, " ").trim() === message
      )) {
        surfaceWarnings.push(candidate);
      }
    };

    const formatSurfaceWarning = (warning) => {
      const code = String(warning?.code || "TRANSCRIPT_PANEL_RENDER_FAILED").trim().toUpperCase();
      const message = String(warning?.message || warning || "字幕显示表面同步失败").replace(/\s+/g, " ").trim();
      return `[${code}] ${message}`;
    };

    const dismissFailedTranslation = () => {
      ns.ui.hideTranslationFailureActions();
      ns.renderer.cleanupTranslatedTracks();
      ns.transcriptPanelRenderer?.clear?.();
      incrementalPreviewMounted = false;
      previewRenderArgs = null;
      lastPreviewVtt = "";
      lastPreviewMeta = {};
      loadedCacheKey = "";
      ns.ui.clearError?.();
      ns.ui.setStatusText("");
      ns.ui.updateActionButtons("加载翻译字幕", false);
    };

    const showFailedTranslationPreview = (failureError = null) => {
      if (!incrementalPreviewMounted || !previewRenderArgs) return;
      const { vttText, prefs, sourceMeta } = previewRenderArgs;
      const failedCues = [
        ...failedCuesFromProgress(lastPreviewMeta, vttText),
        ...failedCuesFromItems(failureError?.failed_items, vttText),
      ];
      const mounted = renderTranslationSurfaces({
        // The initial preview also lives in lastPreviewVtt, so prefer the
        // failure snapshot supplied by the background job. Otherwise a run
        // that failed before the next progress callback could replace already
        // translated cues with the original VTT when showing the error state.
        translatedVtt: failureError?.partial_vtt || lastPreviewVtt || vttText,
        originalVtt: vttText,
        prefs,
        sourceMeta,
        options: {
          incremental: true,
          previewPending: true,
          pendingLabel: ns.constants.SUBTITLE_FAILURE_LABEL,
          failureLabel: ns.constants.SUBTITLE_FAILURE_LABEL,
          failedCues: [...new Set(failedCues)],
        },
        onSurfaceWarning: collectSurfaceWarning,
      });
      if (mounted) ns.renderer.applySubtitleVisibility(prefs.enabled);
    };

    try {
      ns.ui.clearError?.();
      ns.ui.hideTranslationFailureActions();
      ns.ui.updateActionButtons(forceRefresh ? "重新翻译中..." : "处理中...", true);
      ns.ui.setStatusText(forceRefresh ? "强制重新翻译..." : "准备翻译...");

      diagnosticContext.phase = "video";
      const video = await ns.video.waitForVideo(15000);
      if (!video) {
        const error = new Error("未找到播放器 video 元素（15s 超时）");
        error.code = "VIDEO_NOT_FOUND";
        throw error;
      }
      if (forceRefresh) {
        ns.renderer.cleanupTranslatedTracks();
        ns.transcriptPanelRenderer?.clear?.();
      }

      diagnosticContext.phase = "source";
      const prepared = forceRefresh ? null : await preparedManualSource(video);
      const resolvedSource = prepared || await ns.translationService.resolveSourceVtt(video);
      const vttText = resolvedSource?.vttText;
      const sourceId = resolvedSource?.sourceId || "";
      const sourceMeta = resolvedSource?.sourceMeta || null;
      diagnosticContext.sourceMeta = sourceMeta || null;
      diagnosticContext.sourceId = sourceId || "";
      diagnosticContext.sourceCueCount = sourceMeta?.stats?.cueCount || 0;
      diagnosticContext.sourceMaxEnd = sourceMeta?.stats?.maxEnd || 0;
      diagnosticContext.sourceTextLineCount = sourceMeta?.stats?.textLineCount || 0;
      diagnosticContext.sourceMultilineCueCount = sourceMeta?.stats?.multilineCueCount || 0;
      let cfg = await ns.storage.getConfig();
      lastKnownConfig = cfg;
      diagnosticContext.phase = "config";
      const configuredProvider = String(cfg?.provider || "当前 Provider").trim().toLowerCase();
      cfg = await ns.storage.askApiKeyIfNeeded(cfg);
      if (!cfg) {
        const error = new Error(`Provider ${configuredProvider} 缺少 API Key`);
        error.code = "PROVIDER_API_KEY_MISSING";
        error.provider = configuredProvider;
        error.phase = "config";
        throw error;
      }
      diagnosticContext.provider = cfg.provider || "";
      diagnosticContext.target = String(cfg.target || "ZH").toUpperCase();

      const prefs = await ns.storage.getPrefs();
      prefs.target = String(cfg.target || "ZH").toUpperCase();
      ns.renderer.applySubtitleSize(prefs.size);

      const { sourceKey, configSig, cacheKey } = await ns.translationService.buildCacheKey(cfg, sourceId, vttText);
      diagnosticContext.phase = "cache";
      const panelSourceMeta = { ...(sourceMeta || {}), sourceKey, configSig, sessionKey: cacheKey };
      let cacheEntry = null;
      try {
        cacheEntry = await ns.storage.getCacheStore();
      } catch (error) {
        cacheWarningError = Object.assign(new Error("本地翻译缓存读取失败，已跳过缓存"), {
          code: "CACHE_READ_FAILED",
          cause: error,
        });
        console.warn("[echo360-translator][controller] translation cache read failed; continuing without cache", safeErrorForLog(error, { phase: "cache" }));
      }

      if (forceRefresh) {
        if (cacheEntry) {
          const clearResult = await ns.storage.setCacheStore(null);
          if (clearResult?.ok === false) {
            cacheWarningError = clearResult.error || Object.assign(new Error("本地缓存清理失败"), { code: "CACHE_WRITE_FAILED" });
            console.warn("[echo360-translator][controller] old cache could not be cleared", safeErrorForLog(cacheWarningError, { phase: "cache" }));
          } else {
            console.log("[echo360-translator] cache cleared");
          }
        }
        loadedCacheKey = "";
      }

      const renderState = ns.renderer.getRenderState();
      const currentSurfaceReady = renderState.lastRenderedVideo === video &&
        !!renderState.lastTranslatedTrack &&
        (typeof ns.renderer.hasRenderedTranslatedTrack !== "function" || ns.renderer.hasRenderedTranslatedTrack());
      if (!forceRefresh && loadedCacheKey === cacheKey && currentSurfaceReady) {
        ns.renderer.applySubtitleVisibility(prefs.enabled !== false);
        ns.ui.updateActionButtons("翻译字幕已加载");
        ns.ui.setStatusText("已加载当前翻译字幕");
        return;
      }

      if (!forceRefresh && loadedCacheKey === cacheKey) {
        // The DOM can retain a translated <track> after a SPA/player
        // transition. Do not treat that remnant as a successful current
        // render; the renderer marker above is committed only after a live
        // surface was actually mounted.
        loadedCacheKey = "";
      }

      let usableCacheEntry = cacheEntry;
      if (!forceRefresh && cacheEntry?.translatedVtt && cacheEntry.cacheKey === cacheKey) {
        try {
          const validateTranslationResult = ns.backendClient?.validateTranslationResult;
          if (typeof validateTranslationResult !== "function") {
            const unavailable = new Error("扩展缺少统一结果校验器，缓存没有被当作成功");
            unavailable.code = "VALIDATION_UNAVAILABLE";
            unavailable.phase = "cache";
            throw unavailable;
          }
          validateTranslationResult({ translated_vtt: cacheEntry.translatedVtt }, "cache", {
            sourceVtt: vttText,
            target: diagnosticContext.target,
          });
        } catch (error) {
          usableCacheEntry = null;
          cacheWarningError = Object.assign(new Error("本地缓存不是有效的带时间轴 WebVTT，已忽略"), {
            code: "INVALID_TRANSLATION_CACHE",
            cause: error,
          });
          console.warn("[echo360-translator][controller] invalid translation cache ignored", safeErrorForLog(error, { phase: "cache" }));
        }
      }
      if (!forceRefresh && usableCacheEntry?.translatedVtt && usableCacheEntry.cacheKey === cacheKey) {
        const warningStart = surfaceWarnings.length;
        const mounted = renderTranslationSurfaces({
          translatedVtt: usableCacheEntry.translatedVtt,
          originalVtt: vttText,
          prefs,
          sourceMeta: panelSourceMeta,
          onSurfaceWarning: collectSurfaceWarning,
        });
        const cacheSurfaceWarnings = surfaceWarnings.slice(warningStart);
        loadedCacheKey = mounted ? (usableCacheEntry.cacheKey || "") : "";
        if (!mounted || cacheSurfaceWarnings.length > 0) {
          const cacheRenderError = !mounted
            ? Object.assign(new Error("缓存字幕有效，但没有找到可挂载的播放器字幕层"), {
              code: "RENDER_MOUNT_FAILED",
              phase: "render",
            })
            : cacheSurfaceWarnings[0];
          const warningText = cacheSurfaceWarnings.map(formatSurfaceWarning);
          const model = ns.errorUtils?.normalizeError?.(cacheRenderError, {
            ...diagnosticContext,
            phase: "render",
            severity: mounted ? "warning" : "error",
            warnings: warningText,
            sourceMeta: panelSourceMeta,
          }) || cacheRenderError;
          ns.ui.showError?.(model, {
            context: {
              ...diagnosticContext,
              phase: "render",
              severity: mounted ? "warning" : "error",
              warnings: warningText,
              sourceMeta: panelSourceMeta,
            },
            onRetry: () => { ns.ui.clearError?.(); void onClickTranslate(true); },
            onCancel: dismissFailedTranslation,
          });
        }
        if (mounted && cacheSurfaceWarnings.length === 0) {
          ns.renderer.applySubtitleVisibility(prefs.enabled !== false);
          ns.ui.updateActionButtons("翻译字幕已加载");
          ns.ui.setStatusText("命中本地缓存");
        } else if (mounted) {
          ns.renderer.applySubtitleVisibility(prefs.enabled !== false);
          ns.ui.updateActionButtons("翻译字幕已加载");
        } else {
          ns.ui.updateActionButtons("翻译已就绪");
        }
        return;
      }

      const backendUrl = (cfg.backendUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
      const payload = ns.translationService.buildTranslatePayload(cfg, vttText, forceRefresh);
      diagnosticContext.phase = "translation";
      diagnosticContext.provider = payload.provider || diagnosticContext.provider;
      diagnosticContext.target = String(payload.target || diagnosticContext.target || "ZH").toUpperCase();
      diagnosticContext.requestedConcurrency = payload.concurrency;
      diagnosticContext.requestedRps = payload.rps;
      diagnosticContext.retries = payload.retries;
      previewRenderArgs = { vttText, prefs, sourceMeta: panelSourceMeta };
      console.info("[echo360-translator][controller] translation started", {
        runId,
        provider: payload.provider,
        target: payload.target,
        totalChars: String(vttText || "").length,
        requestedConcurrency: payload.concurrency,
        requestedRps: payload.rps,
        retries: payload.retries,
        sourceId: ns.errorUtils?.redactUrl?.(sourceId) || sourceId,
        stableSourceId: ns.errorUtils?.redactUrl?.(panelSourceMeta.sourceKey) || panelSourceMeta.sourceKey,
        sourceMediaId: panelSourceMeta.mediaId || "",
        sourceMapSource: panelSourceMeta.mapSource || "",
        sourceCueCount: panelSourceMeta.stats?.cueCount || 0,
        sourceMaxEnd: panelSourceMeta.stats?.maxEnd || 0,
      });

      const mountTranslationPreview = (partialVtt, incremental = false, partialMeta = {}) => {
        lastPreviewVtt = partialVtt;
        lastPreviewMeta = partialMeta || {};
        const failedCues = failedCuesFromProgress(partialMeta, vttText);
        const mounted = renderTranslationSurfaces({
          translatedVtt: partialVtt,
          originalVtt: vttText,
          prefs,
          sourceMeta: panelSourceMeta,
          options: {
            incremental,
            previewPending: true,
            failedCues,
            failureLabel: ns.constants.SUBTITLE_FAILURE_LABEL,
          },
          onSurfaceWarning: collectSurfaceWarning,
        });
        console.debug("[echo360-translator][controller] partial preview applied", {
          runId,
          current: Number(partialMeta?.current || partialMeta?.completed || 0),
          total: Number(partialMeta?.total || 0),
          failedCues,
          translated: Number(partialMeta?.translated || 0),
          failed: Number(partialMeta?.failed || 0),
          recovery: partialMeta?.recovery === true || partialMeta?.metrics?.recoveryAttempted === true,
          partialChars: String(partialVtt || "").length,
          mounted,
          renderer: ns.playerCaptionRenderer?.getDebugState?.() || null,
        });
        if (!mounted) return false;
        incrementalPreviewMounted = true;
        ns.renderer.applySubtitleVisibility(prefs.enabled);
        return true;
      };

      if (mountTranslationPreview(vttText, false)) {
        ns.ui.updateActionButtons("翻译准备中...", true);
        ns.ui.setStatusText("正在准备翻译（字幕位置预览已显示）");
      }

      const result = await ns.translationService.translateWithConfig(cfg, backendUrl, payload, {
        isActive: () => activeRunId === runId,
        onProgress: (current, total, line = "", details = {}) => {
          const hasKnownTotal = Number(total) > 0;
          const statusLine = String(line || "").trim();
          const tip = hasKnownTotal
            ? translatedPreviewStarted
              ? `翻译中 ${current}/${total}（已开始显示）`
              : `翻译准备中 ${current}/${total}`
            : statusLine || "正在准备翻译…";
          ns.ui.updateActionButtons(tip, true);
          ns.ui.setStatusText(tip);
          const progressKey = `${current}/${total}/${details?.failed || 0}/${details?.retryCount || 0}`;
          if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            console.info("[echo360-translator][controller] translation progress", {
              runId,
              current,
              total,
              translated: Number(details?.translated || 0),
              failed: Number(details?.failed || 0),
              effectiveConcurrency: details?.effectiveConcurrency,
              effectiveRps: details?.effectiveRps,
              rateLimitCount: details?.rateLimitCount,
              elapsedMs: Math.round(performance.now() - runStartedAt),
              metrics: details,
            });
          }
          diagnosticContext.metrics = details || {};
          diagnosticContext.phase = details?.recovery
            ? "recovery"
            : String(details?.phase || "translation").startsWith("argos-")
              ? "backend"
              : details?.phase || "translation";
        },
        onPartialVtt: (partialVtt, progress) => {
          if (!mountTranslationPreview(partialVtt, true, progress)) return;
          const current = Number(progress?.current || 0);
          const total = Number(progress?.total || 0);
          translatedPreviewStarted = current > 0 || Number(progress?.translated || 0) > 0 || partialVtt !== vttText;
          if (total > 0) {
            const tip = translatedPreviewStarted
              ? `翻译中 ${current}/${total}（已开始显示）`
              : `翻译准备中 ${current}/${total}`;
            ns.ui.updateActionButtons(tip, true);
            ns.ui.setStatusText(tip);
          }
          diagnosticContext.metrics = progress?.metrics || progress || diagnosticContext.metrics;
          diagnosticContext.phase = progress?.recovery ? "recovery" : "translation";
        },
        onSyncFallback: () => {
          diagnosticContext.phase = "backend";
          ns.ui.setStatusText("后端不支持异步进度接口，回退到同步翻译...");
        },
      });
      if (activeRunId !== runId) return;
      if (typeof ns.backendClient?.validateTranslationResult === "function") {
        // Keep one final result gate at the controller boundary. Direct jobs,
        // local-backend jobs and test/custom integrations must all prove that
        // the returned value is a timed VTT before the UI announces success.
        ns.backendClient.validateTranslationResult(result, "translation", {
          sourceVtt: vttText,
          target: diagnosticContext.target,
          provider: diagnosticContext.provider,
          bilingual: payload?.bilingual === true,
        });
      } else {
        const error = new Error("扩展缺少统一结果校验器，翻译结果没有被当作成功");
        error.code = "VALIDATION_UNAVAILABLE";
        error.phase = "translation";
        throw error;
      }

      const failedItems = Array.isArray(result.failed_items) ? result.failed_items : [];
      const failedCount = Math.max(failedItems.length, Number(result.metrics?.failed) || 0);
      const finalFailedCues = failedCuesFromItems(result.failed_items, vttText);
      const mounted = renderTranslationSurfaces({
        translatedVtt: result.translated_vtt,
        originalVtt: vttText,
        prefs,
        sourceMeta: panelSourceMeta,
        options: failedCount > 0
          ? {
            incremental: incrementalPreviewMounted,
            // The result is complete even when some cues failed. Mark only
            // the known failed cues; do not turn legitimate source-equal
            // target text into a misleading "still translating" marker.
            previewPending: true,
            markPending: false,
            failedCues: finalFailedCues,
            failureLabel: ns.constants.SUBTITLE_FAILURE_LABEL,
          }
          : { incremental: incrementalPreviewMounted },
        onSurfaceWarning: collectSurfaceWarning,
      });
      if (failedCount === 0) {
        loadedCacheKey = mounted ? cacheKey : "";
        const cacheResult = await ns.storage.setCacheStore({
          cacheKey,
          sourceKey,
          configSig,
          translatedVtt: result.translated_vtt,
          createdAt: Date.now(),
        });
        if (cacheResult?.ok === false) {
          cacheWarningError = cacheResult.error || Object.assign(new Error("翻译完成，但本地缓存保存失败"), { code: "CACHE_WRITE_FAILED" });
          console.warn("[echo360-translator][controller] translated subtitle cache unavailable", safeErrorForLog(cacheWarningError, { phase: "cache" }));
        } else {
          // A successful overwrite resolves a stale force-refresh/read warning;
          // do not show a misleading cache error after a usable cache exists.
          cacheWarningError = null;
        }
      } else {
        loadedCacheKey = "";
      }

      const warningEntries = Array.from(new Set([
        ...(Array.isArray(result.warnings) ? result.warnings : []),
        ...surfaceWarnings.map(formatSurfaceWarning),
        ...(cacheWarningError && failedCount === 0
          ? [`[${cacheWarningError.code || "CACHE_WRITE_FAILED"}] ${cacheWarningError.message || "翻译完成，但缓存保存失败"}`]
          : []),
      ].map((item) => String(item || "").trim()).filter(Boolean)));

      const retryActions = {
        onRetry: () => { ns.ui.clearError?.(); void onClickTranslate(true); },
        onCancel: () => ns.ui.clearError?.(),
      };
      if (failedCount > 0) {
        console.error("[echo360-translator][controller] translation completed with partial failures", {
          runId,
          elapsedMs: Math.round(performance.now() - runStartedAt),
          failedItems: failedCount,
          warnings: warningEntries.length,
          metrics: result.metrics || null,
          failures: failedItems.slice(0, 20),
        });
        const partialError = ns.errorUtils?.normalizeError?.({
          code: "PARTIAL_TRANSLATION",
          message: `翻译完成，但有 ${failedCount} 条字幕失败`,
          metrics: result.metrics || null,
          failed_items: failedItems,
          failure_codes: result.failure_codes || result.failureCodes || result.metrics?.failureCodes || result.metrics?.failure_codes || null,
          warnings: warningEntries,
        }, {
          ...diagnosticContext,
          phase: "translation",
          severity: "warning",
          sourceMeta: panelSourceMeta,
        });
        ns.ui.showError?.(partialError, {
          context: { ...diagnosticContext, phase: "translation", severity: "warning", sourceMeta: panelSourceMeta },
          ...retryActions,
        });
      } else if (!mounted) {
        // A valid translation without a mounted video subtitle layer is not a
        // success from the user's perspective. Keep any panel/cache warnings
        // attached to the same diagnostic card instead of showing two errors.
        const renderError = Object.assign(new Error("翻译完成，但没有找到可挂载的播放器字幕层"), {
          code: "RENDER_MOUNT_FAILED",
          phase: "render",
          warnings: warningEntries,
          sourceMeta: panelSourceMeta,
        });
        ns.ui.showError?.(renderError, {
          context: { ...diagnosticContext, phase: "render", sourceMeta: panelSourceMeta },
          ...retryActions,
        });
      } else if (warningEntries.length > 0) {
        const warningCode = surfaceWarnings[0]?.code || warningCodeFromText(warningEntries[0]);
        console.warn("[echo360-translator][controller] translation completed with warnings", {
          runId,
          elapsedMs: Math.round(performance.now() - runStartedAt),
          warnings: warningEntries,
          metrics: result.metrics || null,
        });
        const warning = ns.errorUtils?.normalizeError?.({
          code: warningCode,
          message: warningEntries[0],
          metrics: result.metrics || null,
          warnings: warningEntries,
        }, { ...diagnosticContext, severity: "warning", warning: warningEntries[0], code: warningCode });
        ns.ui.showError?.(warning, {
          context: { ...diagnosticContext, severity: "warning", warning: warningEntries[0], code: warningCode },
          ...retryActions,
        });
      } else {
        console.info("[echo360-translator][controller] translation completed", {
          runId,
          elapsedMs: Math.round(performance.now() - runStartedAt),
          metrics: result.metrics || null,
        });
        ns.ui.clearError?.();
        ns.ui.setStatusText(result.cache_hit ? "缓存命中" : "翻译完成", "success");
      }

      if (mounted) {
        ns.ui.updateActionButtons(failedCount > 0 ? "部分翻译已加载" : "翻译字幕已加载");
        ns.renderer.applySubtitleVisibility(prefs.enabled);
      } else {
        ns.ui.updateActionButtons("翻译已就绪");
      }
    } catch (err) {
      try {
        showFailedTranslationPreview(err);
      } catch (previewError) {
        console.error("[echo360-translator][controller] failed to render failure preview", safeErrorForLog(previewError, { phase: "render" }));
      }
      const errorContext = {
        ...diagnosticContext,
        metrics: err?.metrics || diagnosticContext.metrics || null,
        sourceMeta: diagnosticContext.sourceMeta || null,
        phase: err?.metrics?.recoveryAttempted ? "recovery" : diagnosticContext.phase,
        warnings: surfaceWarnings.map(formatSurfaceWarning),
      };
      const errorModel = ns.errorUtils?.normalizeError?.(err, errorContext) || err;
      console.error("[echo360-translator][controller] translation failed", {
        runId,
        elapsedMs: Math.round(performance.now() - runStartedAt),
        code: errorModel?.code || "ERROR_DETAILS_MISSING",
        status: Number(errorModel?.status ?? err?.status ?? err?.statusCode) || null,
        message: String(errorModel?.message || err?.message || err || "错误详情缺失").replace(/\s+/g, " ").slice(0, 320),
        metrics: errorModel?.metrics || err?.metrics || null,
        failedItems: Array.isArray(errorModel?.failedItems)
          ? errorModel.failedItems.length
          : Array.isArray(err?.failed_items) ? err.failed_items.length : 0,
        failureSample: Array.isArray(errorModel?.failedItems)
          ? errorModel.failedItems.slice(0, 10)
          : Array.isArray(err?.failed_items) ? err.failed_items.slice(0, 10) : [],
        failureCodes: errorModel?.failureCodes || err?.failure_codes || null,
      });
      ns.ui.showError?.(errorModel || err, {
        context: errorContext,
        onRetry: () => {
          ns.ui.clearError?.();
          void onClickTranslate(true);
        },
        onCancel: dismissFailedTranslation,
      });
      ns.ui.updateActionButtons("加载翻译字幕");
    } finally {
      if (activeRunId === runId) {
        isTranslating = false;
        activeRunId = null;
      }
      const btn = document.getElementById("echo360-translator-btn");
      if (btn && !btn.textContent.includes("已加载") && !btn.textContent.includes("已就绪")) {
        ns.ui.updateActionButtons("加载翻译字幕", false);
      } else {
        ns.ui.updateActionButtons(btn?.textContent || "翻译字幕已加载", false);
      }
    }
  }

  async function init() {
    const supportedPlayerDocument = ns.hostSupport?.isSupportedPlayerDocument?.() ||
      location.hostname.includes("echo360.");
    if (!supportedPlayerDocument) {
      console.log("[echo360-translator] skip unsupported frame:", location.href);
      return;
    }

    ns.video.installPageProbe();
    installConfigWatcher();

    ns.transcriptPanelRenderer?.start?.();

    const video = await ns.video.waitForVideo(30000);
    if (!video) {
      const error = new Error("初始化等待 30 秒后仍未找到播放器 video 元素");
      error.code = "VIDEO_NOT_FOUND";
      console.error("[echo360-translator][controller] video not found during init", {
        code: error.code,
        href: location.href,
      });
      ns.ui.ensurePanel({
        onTranslate: () => onClickTranslate(false),
        onQuickTranslate: quickTranslate,
        onForceTranslate: () => onClickTranslate(true),
        onPrefsChanged,
        onTargetChanged,
        onManualPrepare: prepareManualTranslation,
        onManualDownloadVtt: downloadManualVtt,
        onManualCopyPrompt: copyManualPrompt,
        onManualDownloadPrompt: downloadManualPrompt,
        onManualImport: importManualTranslation,
        onManualToggleMode: toggleManualMode,
      });
      ns.ui.showError?.(error, {
        phase: "video",
        onRetry: () => {
          ns.ui.clearError?.();
          void init();
        },
        onCancel: () => ns.ui.clearError?.(),
      });
      return;
    }

    ns.ui.ensurePanel({
      onTranslate: () => onClickTranslate(false),
      onQuickTranslate: quickTranslate,
      onForceTranslate: () => onClickTranslate(true),
      onPrefsChanged,
      onTargetChanged,
      onManualPrepare: prepareManualTranslation,
      onManualDownloadVtt: downloadManualVtt,
      onManualCopyPrompt: copyManualPrompt,
      onManualDownloadPrompt: downloadManualPrompt,
      onManualImport: importManualTranslation,
      onManualToggleMode: toggleManualMode,
    });

    // Resolve and fingerprint the source as soon as the video exists. This is
    // deliberately non-blocking: the player/UI remain usable, while the usual
    // click path gets a synchronously available prompt in the common case.
    maybePrimeManualSession(video);

    const existing = Array.from(video.querySelectorAll('track[data-echo360-translated="1"]'));
    if (existing.length > 0) {
      ns.renderer.setLastTranslatedTrack(existing[existing.length - 1]);
    }

    const prefs = await ns.storage.getPrefs();
    try {
      lastKnownConfig = await ns.storage.getConfig();
    } catch (error) {
      console.warn("[echo360-translator][controller] could not prime config for backend startup", safeErrorForLog(error, { phase: "preferences" }));
    }
    ns.renderer.applySubtitleSize(prefs.size || DEFAULT_SUBTITLE_SIZE);
    ns.renderer.applySubtitleVisibility(prefs.enabled !== false);

    if (!trackSyncTimer) {
      trackSyncTimer = setInterval(async () => {
        try {
          const p = await ns.storage.getPrefs();
          maybePrimeManualSession(ns.video.getPrimaryVideo?.());
          if (p.enabled === false) return;
          ns.renderer.ensureTrackOnPrimaryVideo();
          ns.renderer.applySubtitleVisibility(true);
          } catch (error) {
            console.error("[echo360-translator][controller] subtitle sync failed", safeErrorForLog(error, { phase: "render" }));
            if (!trackSyncErrorShown) {
              trackSyncErrorShown = true;
              const typedError = withFallbackErrorCode(error, "RENDER_SYNC_ERROR", "render");
              ns.ui.showError?.(typedError, {
                phase: typedError.phase || "render",
                onCancel: () => ns.ui.clearError?.(),
            });
          }
        }
      }, 1200);
    }

    const firstRunKey = "echo360TranslatorFirstRunShown";
    const firstRun = await extensionApi.storage.local.get(firstRunKey);
    if (!firstRun[firstRunKey]) {
      ns.ui.setStatusText("首次使用：默认 Google Translate 可免费试用；若重视质量，请在扩展设置中配置 AI/API 模型。");
      await extensionApi.storage.local.set({ [firstRunKey]: true });
    }
  }

  ns.controller = {
    init,
    renderTranslationSurfaces,
  };
})();
