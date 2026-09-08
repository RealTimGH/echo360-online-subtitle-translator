(() => {
  const ns = window.Echo360Translator;
  const { DEFAULT_SUBTITLE_SIZE } = ns.constants;
  const extensionApi = ns.browserApi;

  let activeRunId = null;
  let isTranslating = false;
  let loadedCacheKey = "";
  let trackSyncTimer = null;
  let trackSyncErrorShown = false;

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

  async function onClickTranslate(forceRefresh = false) {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runStartedAt = performance.now();
    if (isTranslating) {
      ns.ui.setStatusText("已有翻译任务在进行中，请稍候...", "warning");
      return;
    }
    isTranslating = true;
    activeRunId = runId;

    const diagnosticContext = {
      runId,
      phase: "prepare",
      forceRefresh,
    };

    let incrementalPreviewMounted = false;
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
      const { vttText, sourceId, sourceMeta } = await ns.translationService.resolveSourceVtt(video);
      diagnosticContext.sourceMeta = sourceMeta || null;
      diagnosticContext.sourceId = sourceId || "";
      diagnosticContext.sourceCueCount = sourceMeta?.stats?.cueCount || 0;
      diagnosticContext.sourceMaxEnd = sourceMeta?.stats?.maxEnd || 0;
      let cfg = await ns.storage.getConfig();
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
        ns.ui.updateActionButtons("翻译中...", true);
        ns.ui.setStatusText("翻译中...（已开始显示）");
      }

      const result = await ns.translationService.translateWithConfig(cfg, backendUrl, payload, {
        isActive: () => activeRunId === runId,
        onProgress: (current, total, _line = "", details = {}) => {
          const tip = incrementalPreviewMounted
            ? `翻译中 ${current}/${total}（已开始显示）`
            : `翻译中 ${current}/${total}`;
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
          diagnosticContext.phase = details?.recovery ? "recovery" : "translation";
        },
        onPartialVtt: (partialVtt, progress) => {
          if (!mountTranslationPreview(partialVtt, true, progress)) return;
          const current = Number(progress?.current || 0);
          const total = Number(progress?.total || 0);
          if (total > 0) {
            const tip = `翻译中 ${current}/${total}（已开始显示）`;
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
        onForceTranslate: () => onClickTranslate(true),
        onPrefsChanged,
        onTargetChanged,
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
      onForceTranslate: () => onClickTranslate(true),
      onPrefsChanged,
      onTargetChanged,
    });

    const existing = Array.from(video.querySelectorAll('track[data-echo360-translated="1"]'));
    if (existing.length > 0) {
      ns.renderer.setLastTranslatedTrack(existing[existing.length - 1]);
    }

    const prefs = await ns.storage.getPrefs();
    ns.renderer.applySubtitleSize(prefs.size || DEFAULT_SUBTITLE_SIZE);
    ns.renderer.applySubtitleVisibility(prefs.enabled !== false);

    if (!trackSyncTimer) {
      trackSyncTimer = setInterval(async () => {
        try {
          const p = await ns.storage.getPrefs();
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
