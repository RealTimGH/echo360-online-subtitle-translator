(() => {
  const ns = window.Echo360Translator;

  function makeSourceError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
  }

  async function resolveSourceVtt(initialVideo) {
    let vttText = "";
    let sourceId = "";
    let sourceMeta = null;
    let sourceDiagnostics = null;
    const isInstructureMedia = (
      ns.hostSupport?.isInstructureMediaHost?.() ||
      ns.hostSupport?.isInstructureMediaDocument?.()
    ) === true;

    function addSourceDiagnostics(next) {
      if (!next) return;
      const previous = sourceDiagnostics || {};
      sourceDiagnostics = {
        ...previous,
        ...next,
        attempts: [
          ...(Array.isArray(previous.attempts) ? previous.attempts : []),
          ...(Array.isArray(next.attempts) ? next.attempts : []),
        ].slice(-30),
      };
    }

    const trackEl = ns.sourceFinder.findBestTrackElement(initialVideo);
    if (trackEl?.getAttribute("src")) {
      const rawTrackUrl = trackEl.getAttribute("src");
      try {
        const vttUrl = new URL(rawTrackUrl, location.href).toString();
        // Use the same narrowly allowlisted service-worker fallback as the
        // candidate scanner. A source-backed Instructure track can be the
        // best signal and still reject a content-script fetch because the
        // signed URL lives on another Instructure media subdomain.
        const fetched = ns.sourceFinder?.fetchTextResource
          ? await ns.sourceFinder.fetchTextResource(vttUrl)
          : await (async () => {
            const resp = await fetch(vttUrl, { credentials: "include" });
            return resp.ok
              ? { ok: true, text: await resp.text(), via: "content" }
              : { ok: false, code: `HTTP_${resp.status}`, status: resp.status, error: `HTTP ${resp.status}` };
          })();
        if (!fetched.ok) {
          addSourceDiagnostics({ attempts: [{ strategy: "track-src", url: vttUrl, outcome: "fetch-failed", code: fetched.code || "RESOURCE_FETCH_FAILED", status: Number(fetched.status) || null, error: fetched.error || "fetch failed" }] });
        } else {
          const rawText = fetched.text;
          const normalized = ns.vtt.normalizeTimedText ? ns.vtt.normalizeTimedText(rawText) : rawText;
          const stats = normalized ? ns.vtt.parseVttStats(normalized) : { cueCount: 0 };
          const hasCueText = ns.sourceFinder?.hasUsableCueText
            ? ns.sourceFinder.hasUsableCueText(normalized)
            : true;
          if (stats.cueCount > 0 && hasCueText) {
            vttText = normalized;
            sourceId = vttUrl;
            sourceMeta = ns.sourceFinder.buildSourceMeta(sourceId, vttText);
            addSourceDiagnostics({ attempts: [{ strategy: "track-src", url: vttUrl, outcome: "usable", code: "OK", cueCount: stats.cueCount }] });
          } else if (stats.cueCount > 0) {
            addSourceDiagnostics({ attempts: [{ strategy: "track-src", url: vttUrl, outcome: "empty-or-invalid", code: "INVALID_SOURCE_VTT", cueCount: stats.cueCount, error: "字幕轨道包含没有文字的时间轴条目" }] });
          } else {
            addSourceDiagnostics({ attempts: [{ strategy: "track-src", url: vttUrl, outcome: "no-cues", code: "EMPTY_VTT", error: "字幕轨道没有有效时间轴 cue" }] });
          }
        }
      } catch (error) {
        addSourceDiagnostics({ attempts: [{ strategy: "track-src", url: rawTrackUrl, outcome: "exception", code: error?.code || "RESOURCE_FETCH_FAILED", status: Number(error?.status) || null, error: error?.message || String(error) }] });
      }
    }

    // Instructure Media uses a Vidstack custom captions layer. Its mirrored
    // native <track> can have an empty src and no browser cues, while the
    // actual WebVTT request is already visible in the frame's resource timing
    // entries. Check that request before waiting on the empty native track.
    if (!vttText && isInstructureMedia) {
      const cand = await ns.sourceFinder.fetchBestVttFromCandidates(initialVideo);
      addSourceDiagnostics(cand.diagnostics);
      if (cand.text) {
        vttText = cand.text;
        sourceId = cand.sourceId;
        sourceMeta = cand.sourceMeta || ns.sourceFinder.buildSourceMeta(sourceId, vttText);
      }
    }

    if (!vttText) {
      try {
        vttText = await ns.sourceFinder.exportVttFromTextTracks(initialVideo, 8000);
        if (vttText && ns.vtt.parseVttStats(vttText).cueCount > 0 &&
          (!ns.sourceFinder.hasUsableCueText || ns.sourceFinder.hasUsableCueText(vttText))) {
          sourceMeta = ns.sourceFinder.buildSourceMeta("", vttText);
        }
        else if (vttText) {
          const hasCues = ns.vtt.parseVttStats(vttText).cueCount > 0;
          addSourceDiagnostics({ attempts: [{ strategy: "text-tracks", outcome: hasCues ? "empty-or-invalid" : "no-cues", code: hasCues ? "INVALID_SOURCE_VTT" : "EMPTY_VTT", error: hasCues ? "TextTrack 包含没有文字的时间轴条目" : "TextTrack 没有有效 cue" }] });
          vttText = "";
        }
      } catch (error) {
        addSourceDiagnostics({ attempts: [{ strategy: "text-tracks", outcome: "exception", code: error?.code || "RESOURCE_FETCH_FAILED", error: error?.message || String(error) }] });
      }
    }

    if (!vttText) {
      const started = Date.now();
      while (!vttText && Date.now() - started < 12000) {
        const currentVideo = ns.video.getPrimaryVideo() || initialVideo;

        // Try Echo360's own transcript-file API first: it works even when the
        // player exposes no native CC track at all (only a transcript side
        // panel), since it doesn't depend on spotting a "vtt"/"caption"-looking
        // network request.
        const transcriptCand = await ns.sourceFinder.fetchTranscriptFileVtt(currentVideo);
        addSourceDiagnostics(transcriptCand.diagnostics);
        if (transcriptCand.text) {
          vttText = transcriptCand.text;
          sourceId = transcriptCand.sourceId;
          sourceMeta = transcriptCand.sourceMeta;
          break;
        }

        const cand = await ns.sourceFinder.fetchBestVttFromCandidates(currentVideo);
        addSourceDiagnostics(cand.diagnostics);
        if (cand.text) {
          vttText = cand.text;
          sourceId = cand.sourceId;
          sourceMeta = cand.sourceMeta || ns.sourceFinder.buildSourceMeta(sourceId, vttText);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!vttText) {
      const cands = ns.sourceFinder.collectCandidateSubtitleUrls();
      const candidateUrls = cands.map((c) => c.url);
      const attempts = Array.isArray(sourceDiagnostics?.attempts) ? sourceDiagnostics.attempts : [];
      const httpAttempts = attempts
        .map((item) => ({
          item,
          code: String(item?.code || "").toUpperCase(),
          status: Number(item?.status),
        }))
        .filter(({ code, status }) =>
          (Number.isInteger(status) && status >= 100 && status <= 599) || /^HTTP_\d{3}$/.test(code)
        );
      const attemptedStatuses = httpAttempts
        .map(({ code, status }) => Number.isInteger(status) && status >= 100 && status <= 599 ? status : Number(code.slice(5)))
        .filter((status) => Number.isInteger(status) && status >= 100 && status <= 599);
      const networkCodes = new Set([
        "NETWORK_ERROR",
        "RESOURCE_NETWORK_ERROR",
        "RESOURCE_FETCH_FAILED",
        "NETWORK_REQUEST_FAILED",
      ]);
      const nonHttpTransportFailures = attempts.filter((item) => {
        const code = String(item?.code || "").toUpperCase();
        const status = Number(item?.status);
        return ["fetch-failed", "exception"].includes(String(item?.outcome || "").toLowerCase()) &&
          !(Number.isInteger(status) && status > 0) && !/^HTTP_\d{3}$/.test(code);
      });
      const contentFailureAttempts = attempts.filter((item) =>
        ["empty", "empty-or-invalid", "no-cues"].includes(String(item?.outcome || "").toLowerCase())
      );
      const allAccessDenied = attemptedStatuses.length > 0 &&
        attemptedStatuses.every((status) => status === 401 || status === 403) &&
        nonHttpTransportFailures.length === 0 && contentFailureAttempts.length === 0;
      const allNotFound = attemptedStatuses.length > 0 &&
        attemptedStatuses.every((status) => status === 404) &&
        nonHttpTransportFailures.length === 0 && contentFailureAttempts.length === 0;
      const statusIsServerError = (status) => Number.isInteger(status) && status >= 500 && status <= 599;
      const allServerErrors = attemptedStatuses.length > 0 &&
        attemptedStatuses.every(statusIsServerError) &&
        nonHttpTransportFailures.length === 0 && contentFailureAttempts.length === 0;
      // A specific transport diagnosis is safe only when every attempted
      // candidate failed for that same reason. Do not discard empty/invalid
      // candidates before this check: a mixture of network and content
      // failures is genuinely mixed and should remain SUBTITLE_FETCH_FAILED.
      const allNetworkErrors = attempts.length > 0 && attempts.every((item) =>
        networkCodes.has(String(item?.code || "").toUpperCase())
      );
      const allEmpty = attempts.length > 0 && attempts.every((item) =>
        ["EMPTY_VTT", "INVALID_SOURCE_VTT"].includes(String(item?.code || "").toUpperCase())
      );
      const code = allAccessDenied
        ? "SUBTITLE_ACCESS_DENIED"
        : allNotFound
          ? "SUBTITLE_FILE_NOT_FOUND"
          : allServerErrors
            ? "SUBTITLE_SERVER_ERROR"
            : allNetworkErrors
              ? "SUBTITLE_NETWORK_ERROR"
              : allEmpty
                ? "EMPTY_VTT"
                : attempts.length > 0 || candidateUrls.length > 0
                  ? "SUBTITLE_FETCH_FAILED"
                  : "NO_VTT_SOURCE";
      const message = code === "SUBTITLE_ACCESS_DENIED"
        ? "找到了字幕地址，但读取时被字幕服务器拒绝（HTTP 401/403）"
        : code === "SUBTITLE_FILE_NOT_FOUND"
          ? "找到了字幕地址，但字幕文件已不存在（HTTP 404）"
          : code === "SUBTITLE_SERVER_ERROR"
            ? "找到了字幕地址，但字幕服务器返回了 5xx 错误"
                : code === "SUBTITLE_NETWORK_ERROR"
                  ? "找到了字幕地址，但浏览器无法完成字幕文件请求"
                  : code === "EMPTY_VTT"
                    ? "找到了字幕地址，但内容为空或没有有效时间轴"
                    : code === "SUBTITLE_FETCH_FAILED"
                  ? "找到了字幕候选地址，但所有读取尝试都失败，没有得到可用的字幕文件"
                  : "未找到可用字幕源（没有抓到有效 VTT）";
      const error = makeSourceError(message, code, {
        phase: "source",
        candidateCount: candidateUrls.length,
        candidateUrls: candidateUrls.slice(0, 20),
        sourceStrategy: isInstructureMedia ? "instructure-candidate-scan" : "track/transcript-scan",
        sourceDiagnostics,
      });
      console.error("[echo360-translator][source] no usable VTT", {
        code: error.code,
        candidateCount: candidateUrls.length,
        candidates: candidateUrls.map((url) => ns.errorUtils?.redactUrl?.(url) || url),
        isInstructureMedia,
      });
      throw error;
    }

    // Validate the source before asking any provider to translate. Candidate
    // discovery only needs one timed cue to rank a URL; a source with an empty
    // cue must still be rejected here so the provider cannot produce a
    // misleading partial result.
    const validateSourceVtt = ns.backendClient?.validateSourceVtt;
    if (typeof validateSourceVtt !== "function") {
      throw makeSourceError(
        "扩展缺少统一字幕校验器，翻译尚未开始",
        "VALIDATION_UNAVAILABLE",
        { phase: "source" }
      );
    }
    validateSourceVtt(vttText, "source");

    const stats = sourceMeta?.stats || ns.vtt.parseVttStats(vttText);
    console.info("[echo360-translator][source] resolved subtitle source", {
      hostType: isInstructureMedia ? "instructure-media" : "echo360",
      sourceId: ns.errorUtils?.redactUrl?.(sourceId) || sourceId,
      stableSourceId: ns.errorUtils?.redactUrl?.(ns.sourceFinder?.canonicalizeSourceId?.(sourceId) || sourceId) ||
        (ns.sourceFinder?.canonicalizeSourceId?.(sourceId) || sourceId),
      mediaId: sourceMeta?.mediaId || "",
      mapSource: sourceMeta?.mapSource || "",
      strongMapped: sourceMeta?.strongMapped === true,
      cueCount: stats?.cueCount || 0,
      maxEnd: stats?.maxEnd || 0,
    });

    return {
      vttText,
      sourceId,
      sourceMeta: sourceMeta || ns.sourceFinder.buildSourceMeta(sourceId, vttText),
    };
  }

  function buildTranslatePayload(cfg, vttText, forceRefresh) {
    return {
      vtt_text: vttText,
      // api_key is intentionally omitted — the service worker injects it from
      // storage.local so content scripts never need to handle the raw key.
      provider: cfg.provider || "google-web",
      model: cfg.model,
      endpoint: cfg.endpoint || "",
      target: String(cfg.target || "ZH").trim().toUpperCase(),
      max_paragraphs: Number(cfg.maxParagraphs) || 6,
      max_chars: Number(cfg.maxChars) || 1200,
      // Match the 1.4.2 Google Web defaults. direct_translator.js applies the
      // provider-specific cap and keeps rps=0 as unlimited pacing.
      concurrency: Number(cfg.concurrency) || 96,
      rps: cfg.rps != null ? Number(cfg.rps) : 0,
      retries: cfg.retries != null ? Number(cfg.retries) : 1,
      bilingual: false,
      timeout: cfg.timeout != null ? (Number(cfg.timeout) || null) : null,
      reasoning_effort: cfg.reasoningEffort || null,
      fallback_mode: cfg.fallbackMode || "immediate",
      repair_concurrency: Number(cfg.repairConcurrency) || 1,
      slow_split_threshold: Number(cfg.slowSplitThreshold) || 0,
      deepseek_thinking_mode: cfg.deepseekThinkingMode || "disabled",
      deepl_formality: cfg.deeplFormality || "",
      force_refresh: !!forceRefresh,
    };
  }

  function validateCreatedJobResponse(data, phase = "backend") {
    const validator = ns.backendClient?.validateJobCreationResponse;
    if (typeof validator === "function") return validator(data, phase);
    // Legacy/custom test clients may not expose the shared validator. Keep the
    // same no-false-success contract in that compatibility path.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      const error = new Error("创建翻译任务的响应不是有效对象");
      error.code = "INVALID_BACKEND_RESPONSE";
      error.phase = phase;
      throw error;
    }
    const jobId = data.job_id ?? data.jobId;
    if (typeof jobId !== "string" || !jobId.trim()) {
      const error = new Error("创建翻译任务的响应缺少 job_id");
      error.code = data.error_code || data.errorCode || data.error_detail || data.error
        ? "INVALID_BACKEND_RESPONSE"
        : "JOB_ID_MISSING";
      error.phase = phase;
      throw error;
    }
    return { ...data, job_id: jobId.trim() };
  }

  async function translateWithBackend(backendUrl, payload, options = {}) {
    let create;
    try {
      create = await ns.backendClient.proxyRequest(backendUrl, "/translate-async", "POST", payload);
    } catch (asyncErr) {
      const status = Number(asyncErr?.status ?? asyncErr?.statusCode);
      const isCreate404 = status === 404 || asyncErr?.code === "HTTP_404";
      if (!isCreate404) throw asyncErr;
      if (options.onSyncFallback) options.onSyncFallback();
      const syncResult = await ns.backendClient.proxyTranslateSync(backendUrl, payload);
      const validateTranslationResult = ns.backendClient?.validateTranslationResult;
      if (typeof validateTranslationResult !== "function") {
        const error = new Error("扩展缺少统一结果校验器，后端结果没有被当作成功");
        error.code = "VALIDATION_UNAVAILABLE";
        error.phase = "backend";
        throw error;
      }
      return validateTranslationResult(syncResult, "backend", {
        sourceVtt: payload.vtt_text,
        target: payload.target,
        provider: payload.provider,
        bilingual: payload.bilingual === true,
      });
    }
    create = validateCreatedJobResponse(create, "backend");
    // Do not catch polling failures here. A missing/expired job is a real
    // failure and must not be silently converted into a second translation.
    const waitOptions = {
      isActive: options.isActive || (() => true),
      onProgress: options.onProgress || (() => {}),
      onPartialVtt: options.onPartialVtt || (() => {}),
      sourceVtt: payload.vtt_text || "",
      target: payload.target || "ZH",
      provider: payload.provider || "",
      bilingual: payload.bilingual === true,
    };
    return await ns.backendClient.waitJob(backendUrl, create.job_id, waitOptions);
  }

  async function translateInExtension(payload, options = {}) {
    let create = await ns.backendClient.createDirectTranslateJob(payload);
    create = validateCreatedJobResponse(create, "backend");
    const waitOptions = {
      isActive: options.isActive || (() => true),
      onProgress: options.onProgress || (() => {}),
      onPartialVtt: options.onPartialVtt || (() => {}),
      sourceVtt: payload.vtt_text || "",
      target: payload.target || "ZH",
      provider: payload.provider || "",
      bilingual: payload.bilingual === true,
    };
    return await ns.backendClient.waitDirectJob(create.job_id, waitOptions);
  }

  async function translateWithConfig(cfg, backendUrl, payload, options = {}) {
    if (cfg.useLocalBackend && ns.buildConfig?.enableLocalBackend !== false) {
      return await translateWithBackend(backendUrl, payload, options);
    }
    return await translateInExtension(payload, options);
  }

  async function buildCacheKey(cfg, sourceId, vttText) {
    const vttHash = await ns.storage.sha256Text(vttText);
    const stableSourceId = ns.sourceFinder?.canonicalizeSourceId?.(sourceId) || sourceId;
    const sourceKey = stableSourceId || `${location.href}#${vttHash}`;
    const configSig = ns.storage.buildConfigSignature(cfg);
    return {
      sourceKey,
      configSig,
      cacheKey: `${sourceKey}::${configSig}`,
    };
  }

  ns.translationService = {
    resolveSourceVtt,
    buildTranslatePayload,
    translateWithBackend,
    translateInExtension,
    translateWithConfig,
    buildCacheKey,
  };
})();
