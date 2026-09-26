(() => {
  const ns = window.Echo360Translator;
  const MIXABLE_PROVIDER_CODES = new Set(["google-web", "deepl", "azure","openai", "deepseek", "gemini", "argos", "custom-backend"]);
  const LOCAL_ARGOS_BACKEND_URL = "http://127.0.0.1:8765";
  const MIXED_PROVIDER_DEFAULTS = {
    "google-web": { model: "", endpoint: "" },
    openai: { model: "gpt-5-nano", endpoint: "" },
    deepseek: { model: "deepseek-v4-flash", endpoint: "" },
    gemini: { model: "gemini-3.1-flash-lite", endpoint: "" },
    deepl: { model: "", endpoint: "" },
    azure: { model: "", endpoint: "" },
    argos: { model: "", endpoint: "" },
    "custom-backend": { model: "", endpoint: "" },
  };

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
    // One shared budget covers candidate scans and transcript-file probes.
    // Individual requests may use less of it, but none may reset the clock.
    const sourceDeadlineAt = Date.now() + 12_000;
    // Keep request results scoped to this resolution attempt. Candidate scans
    // repeat while the player is still loading, so sharing this map prevents
    // the same failed URL from creating another network request every 500 ms
    // without retaining anything after the attempt settles.
    const sourceOptions = { deadlineAt: sourceDeadlineAt, resourceRequests: new Map() };
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
          ? await ns.sourceFinder.fetchTextResource(vttUrl, sourceOptions)
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
      const cand = await ns.sourceFinder.fetchBestVttFromCandidates(initialVideo, sourceOptions);
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
      while (!vttText && Date.now() < sourceDeadlineAt) {
        const currentVideo = ns.video.getPrimaryVideo() || initialVideo;

        // Try Echo360's own transcript-file API first: it works even when the
        // player exposes no native CC track at all (only a transcript side
        // panel), since it doesn't depend on spotting a "vtt"/"caption"-looking
        // network request.
        const transcriptCand = await ns.sourceFinder.fetchTranscriptFileVtt(currentVideo, sourceOptions);
        addSourceDiagnostics(transcriptCand.diagnostics);
        if (transcriptCand.text) {
          vttText = transcriptCand.text;
          sourceId = transcriptCand.sourceId;
          sourceMeta = transcriptCand.sourceMeta;
          break;
        }

        const cand = await ns.sourceFinder.fetchBestVttFromCandidates(currentVideo, sourceOptions);
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
    // Normalize at the shared boundary too: cached sources and future source
    // adapters may return the original SRT rather than candidate-normalized VTT.
    vttText = ns.vtt.normalizeTimedText?.(vttText) || vttText;
    validateSourceVtt(vttText, "source");

    // A translated browser track is syntactically valid WebVTT, so the normal
    // header/cue checks cannot catch a source-selection loop. Reject the
    // high-confidence bilingual shape defensively at the source boundary. The
    // primary fix is still source_finder's explicit exclusion of extension
    // tracks; this guard protects old DOM remnants, cached player state, and
    // future source adapters from feeding output back into translation.
    const bilingualShape = ns.vtt.inspectProbableBilingualVtt?.(vttText);
    if (bilingualShape?.probable) {
      const error = makeSourceError(
        `检测到字幕源已经包含成对的中英文/目标语言文字（${bilingualShape.mixedCueCount}/${bilingualShape.cueCount} 个 cue），已阻止重复翻译`,
        "SOURCE_ALREADY_TRANSLATED",
        {
          phase: "source",
          sourceMeta,
          details: {
            sourceStructure: bilingualShape,
            action: "remove-translated-track-and-resolve-original-source",
          },
        }
      );
      console.error("[echo360-translator][source] rejected probable translated source", {
        sourceId: ns.errorUtils?.redactUrl?.(sourceId) || sourceId,
        sourceStructure: bilingualShape,
      });
      throw error;
    }

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
    if (typeof vttText !== "string" || !vttText.trim()) {
      const error = new Error("翻译请求缺少有效的带时间轴字幕 vtt_text");
      error.code = "INVALID_SOURCE_VTT";
      error.phase = "source";
      error.details = { field: "vtt_text", reason: "required_non_empty_string" };
      throw error;
    }
    return {
      vtt_text: ns.vtt.normalizeTimedText?.(vttText) || vttText,
      // api_key is intentionally omitted — the service worker injects it from
      // storage.local so content scripts never need to handle the raw key.
      provider: cfg.provider || "google-web",
      mixed_providers: Array.isArray(cfg.mixedProviders) ? cfg.mixedProviders : [],
      mixed_priority_enabled: cfg.mixedPriorityEnabled === true,
      mixed_priority_groups: Array.isArray(cfg.mixedPriorityGroups)
        ? cfg.mixedPriorityGroups.map((group) => ({ ...group }))
        : [],
      provider_configs: cfg.providerConfigs && typeof cfg.providerConfigs === "object" ? cfg.providerConfigs : {},
      model: cfg.model,
      endpoint: cfg.endpoint || "",
      target: String(cfg.target || "ZH").trim().toUpperCase(),
      max_paragraphs: Number(cfg.maxParagraphs) || 6,
      max_chars: Number(cfg.maxChars) || 1200,
      // Keep the stored/shared tuning fields in the payload. The provider
      // adapter clamps Google Web to its conservative 6 RPS / 3-worker profile.
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
      azure_region: cfg.azureRegion || "",
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
      signal: options.signal,
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
      signal: options.signal,
      onProgress: options.onProgress || (() => {}),
      onPartialVtt: options.onPartialVtt || (() => {}),
      sourceVtt: payload.vtt_text || "",
      target: payload.target || "ZH",
      provider: payload.provider || "",
      bilingual: payload.bilingual === true,
    };
    return await ns.backendClient.waitDirectJob(create.job_id, waitOptions);
  }

  function shouldFallbackGoogleToArgos(error, payload) {
    if (String(payload?.provider || "").toLowerCase() !== "google-web") return false;
    const target = String(payload?.target || "ZH").toUpperCase();
    if (["YUE", "CANTONESE", "EN"].includes(target)) return false;
    const code = String(error?.code || error?.error_code || "").toUpperCase();
    const rateLimitCount = Number(
      error?.google429Responses ??
      error?.metrics?.google429Responses ??
      error?.failure_codes?.HTTP_429 ??
      error?.failureCodes?.HTTP_429 ??
      0
    );
    return code === "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN" ||
      error?.googleCircuitTripped === true ||
      error?.metrics?.googleCircuitTripped === true ||
      rateLimitCount >= 5;
  }

  function buildArgosFallbackPayload(payload) {
    return {
      ...payload,
      provider: "argos",
      model: "",
      endpoint: "",
      concurrency: 1,
      rps: 0,
      retries: 0,
      max_paragraphs: 6,
      force_refresh: true,
    };
  }

  async function translateWithArgosFallback(backendUrl, payload, options, googleError) {
    const rateLimitCount = Number(
      googleError?.google429Responses ??
      googleError?.metrics?.google429Responses ??
      googleError?.failure_codes?.HTTP_429 ??
      googleError?.failureCodes?.HTTP_429 ??
      0
    );
    options.onProgress?.(
      0,
      0,
      "Google Translate 触发大量 429，正在启动 Argos 离线翻译…",
      { phase: "argos-fallback", fallbackProvider: "argos", google429Responses: rateLimitCount }
    );
    if (typeof ns.backendClient?.ensureArgosBackend !== "function") {
      const error = new Error("扩展缺少 Argos 后端启动器，无法执行 Google 429 自动备份");
      error.code = "ARGOS_BACKEND_START_UNAVAILABLE";
      error.phase = "backend";
      error.cause = googleError;
      throw error;
    }
    const ready = await ns.backendClient.ensureArgosBackend(backendUrl);
    const result = await translateWithBackend(
      ready?.backendUrl || backendUrl,
      buildArgosFallbackPayload(payload),
      options
    );
    const warning = `Google Translate 在短时间内返回 ${rateLimitCount || "多"} 次 HTTP 429，已停止 Google 重试并改用本机 Argos 完成翻译。`;
    return {
      ...result,
      // The returned VTT was produced by the fallback backend. Keep the
      // provider field truthful so compact translation summaries report the
      // service that actually completed the cues.
      provider: "argos",
      warnings: [warning, ...(Array.isArray(result?.warnings) ? result.warnings : [])],
      metrics: {
        ...(result?.metrics || {}),
        initialProvider: "google-web",
        fallbackProvider: "argos",
        google429Responses: rateLimitCount,
        googleCircuitTripped: true,
      },
    };
  }

  function providerSupportsTarget(provider, target) {
    const code = String(target || "ZH").toUpperCase();
    if (provider === "deepl" && ["YUE", "CANTONESE"].includes(code)) return false;
    if (provider === "argos" && ["YUE", "CANTONESE", "EN"].includes(code)) return false;
    if (provider === "argos" && ns.buildConfig?.enableLocalBackend === false) return false;
    return true;
  }

  function mixedPriorityConfigError(message, details = {}) {
    const error = new Error(message);
    error.code = "MIXED_PRIORITY_CONFIG_INVALID";
    error.phase = "config";
    error.details = details;
    return error;
  }

  function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  }

  function resolveMixedPrioritySettings(cfg, payload) {
    const payloadEnabled = hasOwn(payload, "mixed_priority_enabled")
      ? payload.mixed_priority_enabled
      : undefined;
    const enabled = typeof payloadEnabled === "boolean"
      ? payloadEnabled
      : cfg?.mixedPriorityEnabled === true;
    const groups = hasOwn(payload, "mixed_priority_groups")
      ? payload.mixed_priority_groups
      : cfg?.mixedPriorityGroups;
    return { enabled, groups };
  }

  /**
   * Validate the ordered priority groups without looking at providers. This
   * stays pure so callers/tests can reason about boundary conditions without
   * starting a translation backend.
   */
  function normalizeMixedPriorityGroups(rawGroups) {
    if (!Array.isArray(rawGroups) || rawGroups.length === 0 || rawGroups.length > 8) {
      throw mixedPriorityConfigError(
        "混合翻译优先级组必须包含 1 到 8 个组",
        { field: "mixed_priority_groups", reason: "group_count_out_of_range" }
      );
    }
    const seenIds = new Set();
    let previousAfterCues = -1;
    const groups = rawGroups.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string") {
        throw mixedPriorityConfigError(
          `混合翻译优先级第 ${index + 1} 个组缺少有效的组标识`,
          { field: `mixed_priority_groups[${index}].id`, reason: "id_must_be_string" }
        );
      }
      const id = raw.id.trim();
      if (!id || seenIds.has(id)) {
        throw mixedPriorityConfigError(
          `混合翻译优先级第 ${index + 1} 个组的标识必须唯一且非空`,
          { field: `mixed_priority_groups[${index}].id`, reason: "duplicate_or_empty_id" }
        );
      }
      const afterCues = raw.afterCues;
      const validAfterCues = Number.isSafeInteger(afterCues) &&
        (index === 0 ? afterCues === 0 : afterCues >= 1 && afterCues > previousAfterCues);
      if (!validAfterCues) {
        throw mixedPriorityConfigError(
          index === 0
            ? "第一级字幕阈值必须为 0"
            : "后续级别字幕阈值必须为严格递增的正整数",
          { field: `mixed_priority_groups[${index}].afterCues`, reason: "after_cues_must_increase" }
        );
      }
      seenIds.add(id);
      previousAfterCues = afterCues;
      return { id, afterCues, index };
    });
    return groups;
  }

  function normalizeMixedProviderConfig(cfg, payload) {
    const source = Array.isArray(payload?.mixed_providers) && payload.mixed_providers.length > 0
      ? payload.mixed_providers
      : cfg?.mixedProviders;
    const prioritySettings = resolveMixedPrioritySettings(cfg, payload);

    if (prioritySettings.enabled) {
      const priorityGroups = normalizeMixedPriorityGroups(prioritySettings.groups);
      const groupsById = new Map(priorityGroups.map((group) => [group.id, group]));
      const configuredGroups = new Set();
      const compatibleGroups = new Set();
      const seen = new Set();
      const providers = [];

      for (const raw of Array.isArray(source) ? source : []) {
        const provider = String(raw?.provider || raw?.id || "").trim().toLowerCase();
        if (!provider || raw?.enabled === false || !MIXABLE_PROVIDER_CODES.has(provider)) continue;

        const priorityGroup = raw?.priorityGroup;
        const group = typeof priorityGroup === "string"
          ? groupsById.get(priorityGroup.trim())
          : undefined;
        if (!group) {
          throw mixedPriorityConfigError(
            `混合翻译服务 ${provider} 必须分配到有效优先级组`,
            { field: "mixed_providers.priorityGroup", provider, priorityGroup }
          );
        }
        if (seen.has(provider)) {
          throw mixedPriorityConfigError(
            `混合翻译服务 ${provider} 只能属于一个优先级组`,
            { provider, reason: "provider_in_multiple_groups", groupId: group.id }
          );
        }
        configuredGroups.add(group.id);
        seen.add(provider);
        if (!providerSupportsTarget(provider, payload?.target)) continue;
        compatibleGroups.add(group.id);
        const weight = Math.max(1, Math.min(100, Math.round(Number(raw?.weight) || 1)));
        providers.push({
          provider,
          weight,
          priorityGroup: group.id,
          priorityIndex: group.index,
        });
      }

      for (const group of priorityGroups) {
        if (!configuredGroups.has(group.id)) {
          throw mixedPriorityConfigError(
            `混合翻译优先级组 ${group.id} 没有启用的支持服务`,
            { groupId: group.id, reason: "group_has_no_enabled_provider" }
          );
        }
        if (!compatibleGroups.has(group.id)) {
          throw mixedPriorityConfigError(
            `混合翻译优先级组 ${group.id} 没有支持当前目标语言的服务`,
            { groupId: group.id, target: payload?.target || "ZH", reason: "group_incompatible" }
          );
        }
      }
      const firstGroupProviders = providers.filter((item) => item.priorityIndex === 0);
      if (firstGroupProviders.length === 0) {
        throw mixedPriorityConfigError(
          "混合翻译优先级第一个组没有支持当前目标语言的服务，不能自动提升后续组",
          { groupId: priorityGroups[0].id, target: payload?.target || "ZH", reason: "first_group_incompatible" }
        );
      }
      if (providers.length === 0) {
        throw mixedPriorityConfigError(
          "混合翻译没有支持当前目标语言的服务",
          { target: payload?.target || "ZH", reason: "no_compatible_provider" }
        );
      }
      return {
        providers,
        priority: { enabled: true, groups: priorityGroups },
      };
    }

    const seen = new Set();
    const providers = [];
    for (const raw of Array.isArray(source) ? source : []) {
      const provider = String(raw?.provider || raw?.id || "").trim().toLowerCase();
      if (!provider || seen.has(provider) || !MIXABLE_PROVIDER_CODES.has(provider) || raw?.enabled === false) continue;
      if (!providerSupportsTarget(provider, payload?.target)) continue;
      const weight = Math.max(1, Math.min(100, Math.round(Number(raw?.weight) || 1)));
      seen.add(provider);
      providers.push({ provider, weight });
    }
    if (providers.length < 2) {
      const error = new Error("混合翻译至少需要两个支持当前目标语言的服务");
      error.code = "MIXED_PROVIDERS_REQUIRED";
      error.phase = "config";
      error.details = { configured: Array.isArray(source) ? source : [], target: payload?.target || "ZH" };
      throw error;
    }
    return {
      providers,
      priority: { enabled: false, groups: [] },
    };
  }

  function normalizeMixedProviders(cfg, payload) {
    return normalizeMixedProviderConfig(cfg, payload).providers;
  }

  const MIXED_TIMING_RE = /^\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}\s*-->\s*(?:(?:\d{2,}):)?\d{2}:\d{2}\.\d{3}(?:\s+.*)?$/;

  function parseMixedCueUnits(vtt) {
    const lines = String(vtt || "").replace(/\r/g, "").split("\n");
    const units = [];
    for (let timingIndex = 0; timingIndex < lines.length; timingIndex += 1) {
      if (!MIXED_TIMING_RE.test(lines[timingIndex])) continue;
      let start = timingIndex;
      if (timingIndex > 0 && lines[timingIndex - 1].trim() && !MIXED_TIMING_RE.test(lines[timingIndex - 1]) &&
        (timingIndex < 2 || !lines[timingIndex - 2].trim())) {
        start = timingIndex - 1;
      }
      let end = timingIndex + 1;
      while (end < lines.length && lines[end].trim() && !MIXED_TIMING_RE.test(lines[end])) end += 1;
      const textIndexes = [];
      for (let index = timingIndex + 1; index < end; index += 1) {
        if (lines[index].trim()) textIndexes.push(index);
      }
      if (textIndexes.length > 0) {
        units.push({
          index: units.length,
          block: lines.slice(start, end),
          textIndexes,
          textCount: textIndexes.length,
        });
      }
    }
    return { lines, units };
  }

  // A translation checkpoint is deliberately built from the VTT that was
  // actually sent to a provider.  In sentence-merge mode that is the merged
  // VTT, rather than the original player timeline.  Keeping the exact source
  // bytes here makes a stale checkpoint fail closed when a page exposes a
  // different caption track after a reload.
  const TRANSLATION_CHECKPOINT_VERSION = 1;

  function checkpointError(message, code = "INVALID_TRANSLATION_CHECKPOINT", details = {}) {
    const error = new Error(message);
    error.code = code;
    error.phase = "checkpoint";
    error.details = details;
    return error;
  }

  function serializableCheckpointValue(value) {
    if (value == null) return value;
    try {
      const encoded = JSON.stringify(value);
      return encoded == null ? null : JSON.parse(encoded);
    } catch (_) {
      return null;
    }
  }

  function resultFailureItems(result) {
    const candidates = [
      result?.failed_items,
      result?.failedItems,
      result?.metrics?.failed_items,
      result?.metrics?.failedItems,
    ];
    const found = candidates.find((value) => Array.isArray(value));
    return found ? found : [];
  }

  function resultFailureCues(result) {
    const sources = [
      result?.failed_cues,
      result?.failedCues,
      result?.metrics?.failed_cues,
      result?.metrics?.failedCues,
    ];
    const cues = [];
    const seen = new Set();
    // The terminal list supersedes older progress/metrics mirrors, including
    // an explicit empty list after recovery.
    for (const raw of sources.find(Array.isArray) || []) {
      const cue = Number(raw);
      if (!Number.isSafeInteger(cue) || cue <= 0 || seen.has(cue)) continue;
      seen.add(cue);
      cues.push(cue);
    }
    return cues;
  }

  function resultFailureCodes(result) {
    const source = result?.failure_codes || result?.failureCodes ||
      result?.metrics?.failure_codes || result?.metrics?.failureCodes;
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};
    const codes = {};
    for (const [key, value] of Object.entries(source)) {
      const count = Number(value);
      if (!key || !Number.isFinite(count) || count <= 0) continue;
      codes[key] = count;
    }
    return codes;
  }

  function resultFailureLineCount(result) {
    const raw = Number(result?.metrics?.failed);
    if (Number.isSafeInteger(raw) && raw >= 0) return raw;
    return resultFailureItems(result).length;
  }

  function cueTimingSignature(unit) {
    const timing = unit?.block?.find((line) => MIXED_TIMING_RE.test(String(line || "")));
    return String(timing || "").trim().replace(/\s+/g, " ");
  }

  function checkpointStructure(sourceVtt, translatedVtt) {
    const source = parseMixedCueUnits(sourceVtt);
    const translated = parseMixedCueUnits(translatedVtt);
    if (source.units.length === 0 || translated.units.length === 0) return null;
    if (source.units.length !== translated.units.length) return null;
    for (let index = 0; index < source.units.length; index += 1) {
      const sourceUnit = source.units[index];
      const translatedUnit = translated.units[index];
      if (cueTimingSignature(sourceUnit) !== cueTimingSignature(translatedUnit) ||
        sourceUnit.textIndexes.length !== translatedUnit.textIndexes.length) {
        return null;
      }
    }
    return { source, translated };
  }

  function addFailureCue(cues, rawCue, cueCount) {
    const cue = Number(rawCue);
    if (!Number.isSafeInteger(cue) || cue <= 0 || cue > cueCount) return false;
    cues.add(cue - 1);
    return true;
  }

  // Provider metrics count text lines, while a resume request must send whole
  // cues.  Prefer explicit failed_cues, then map failed_items through the
  // physical line and translatable-item positions emitted by direct_translator.
  // This keeps multiline cues and providers that report line locations
  // resumable without guessing from the aggregate failed count.
  function failedCueIndexesForResult(result, parsed, { strict = false } = {}) {
    const cues = new Set();
    const cueCount = parsed?.units?.length || 0;
    const sourceLineToCue = new Map();
    const translatableLineToCue = [];
    for (let cueIndex = 0; cueIndex < cueCount; cueIndex += 1) {
      const unit = parsed.units[cueIndex];
      for (const lineIndex of unit.textIndexes) {
        sourceLineToCue.set(lineIndex, cueIndex);
        translatableLineToCue.push(cueIndex);
      }
    }

    let invalidExplicitCue = false;
    for (const rawCue of resultFailureCues(result)) {
      if (!addFailureCue(cues, rawCue, cueCount)) invalidExplicitCue = true;
    }
    for (const item of resultFailureItems(result)) {
      if (!item || typeof item !== "object") continue;
      if (item.cue != null) {
        if (!addFailureCue(cues, item.cue, cueCount)) invalidExplicitCue = true;
        continue;
      }
      const physicalLine = Number(item.line);
      if (Number.isSafeInteger(physicalLine) && physicalLine > 0) {
        const cueIndex = sourceLineToCue.get(physicalLine - 1);
        if (cueIndex != null) {
          cues.add(cueIndex);
          continue;
        }
      }
      const itemIndex = Number(item.item);
      if (Number.isSafeInteger(itemIndex) && itemIndex > 0 && itemIndex <= translatableLineToCue.length) {
        cues.add(translatableLineToCue[itemIndex - 1]);
      } else if (strict) {
        return { cues, valid: false, reason: "failure_item_not_locatable" };
      }
    }

    const failedLines = resultFailureLineCount(result);
    // failed_items is intentionally capped by the provider at 50 entries.
    // Once the aggregate count exceeds that sample, an exhaustive failed_cues
    // list is mandatory; otherwise a resume would silently treat unlisted
    // failed cues as successful work.
    const explicitFailedCues = resultFailureCues(result);
    if (strict && failedLines > resultFailureItems(result).length && explicitFailedCues.length === 0) {
      return { cues, valid: false, reason: "failure_details_sample_not_exhaustive" };
    }
    const locatedLineCapacity = [...cues].reduce((sum, index) => sum + parsed.units[index].textIndexes.length, 0);
    if (strict && (failedLines > locatedLineCapacity ||
      (Number.isInteger(result?.metrics?.failedCues) && result.metrics.failedCues !== cues.size))) {
      return { cues, valid: false, reason: "failure_locations_incomplete" };
    }
    if (invalidExplicitCue || (failedLines > 0 && cues.size === 0)) {
      return { cues, valid: false, reason: invalidExplicitCue ? "failed_cue_out_of_range" : "failed_cue_missing" };
    }
    if (strict && failedLines === 0 && (resultFailureItems(result).length > 0 || cues.size > 0)) {
      return { cues, valid: false, reason: "failure_count_mismatch" };
    }
    return { cues, valid: true, reason: "ok" };
  }

  // Diagnostic examples are bounded; resume decisions need exact line state.
  // Older results remain usable when their sample or whole failed cues prove
  // every failed line. Ambiguous legacy/custom results fail closed.
  function failedLineIndexesForResult(result, parsed) {
    const expected = resultFailureLineCount(result);
    const lineToCue = new Map(parsed.units.flatMap((unit, cue) => unit.textIndexes.map(line => [line, cue])));
    const textLines = [...lineToCue.keys()];
    const explicit = result?.failed_lines ?? result?.metrics?.failed_lines;
    const lines = new Set();
    if (Array.isArray(explicit)) {
      for (const value of explicit) {
        const line = Number(value) - 1;
        if (!Number.isInteger(line) || !lineToCue.has(line) || lines.has(line)) return null;
        lines.add(line);
      }
      if (lines.size !== expected) return null;
    }
    for (const item of resultFailureItems(result)) {
      const cue = parsed.units[Number(item.cue) - 1];
      const line = item.line != null ? Number(item.line) - 1
        : cue?.textIndexes.length === 1 ? cue.textIndexes[0]
          : Number.isInteger(Number(item.item)) ? textLines[Number(item.item) - 1] : NaN;
      if (!Number.isInteger(line) || !lineToCue.has(line)) return null;
      if (item.cue != null && lineToCue.get(line) !== Number(item.cue) - 1) return null;
      if (Array.isArray(explicit) && !lines.has(line)) return null;
      lines.add(line);
    }
    const located = failedCueIndexesForResult(result, parsed, { strict: true });
    if (!located.valid) return null;
    if (lines.size < expected && !Array.isArray(explicit)) {
      const wholeCues = [...located.cues].flatMap(cue => parsed.units[cue].textIndexes);
      if (wholeCues.length === expected) for (const line of wholeCues) lines.add(line);
    }
    if (lines.size !== expected) return null;
    const cues = new Set([...lines].map(line => lineToCue.get(line)));
    if (cues.size !== located.cues.size || [...cues].some(cue => !located.cues.has(cue))) return null;
    return lines;
  }

  function failureItemsForLines(result, parsed, failedLines) {
    const textLines = parsed.units.flatMap(unit => unit.textIndexes);
    const samples = new Map(resultFailureItems(result).map(item => {
      const unit = parsed.units[Number(item.cue) - 1];
      const line = item.line != null ? Number(item.line) - 1
        : unit?.textIndexes.length === 1 ? unit.textIndexes[0] : textLines[Number(item.item) - 1];
      return [line, item];
    }));
    const codes = Object.keys(resultFailureCodes(result));
    const fallbackCode = codes.length === 1 ? codes[0] : "UNSAMPLED_TRANSLATION_FAILURE";
    const entries = new Map(parsed.units.flatMap((unit, cue) => unit.textIndexes.map(line => [line, { cue, unit }])));
    return [...failedLines].sort((a, b) => a - b).map(line => {
      const sample = samples.get(line);
      const { cue, unit } = entries.get(line);
      const timing = cueTimingSignature(unit).match(/^(\S+)\s*-->\s*(\S+)/);
      const code = sample?.code || fallbackCode;
      return {
        ...(sample || {}),
        cue: cue + 1, line: line + 1, code,
        message: sample?.message || sample?.error || "该行翻译失败；服务仅提供前 50 条错误详情，请结合本轮错误统计排查",
        ...(sample ? {} : /^HTTP_\d{3}$/.test(code) ? { status: Number(code.slice(-3)) } : {}),
        source_text: sample?.source_text || parsed.lines[line],
        timecode: sample?.timecode || (timing ? `${timing[1]} --> ${timing[2]}` : ""),
        start_time: sample?.start_time || timing?.[1] || "",
        end_time: sample?.end_time || timing?.[2] || "",
      };
    });
  }

  function buildTranslationCheckpoint(result, sourceVtt) {
    if (!result || typeof result !== "object" || Array.isArray(result) ||
      typeof sourceVtt !== "string" || !sourceVtt.trim()) return null;
    const translatedVtt = typeof result.translated_vtt === "string"
      ? result.translated_vtt
      : typeof result.translatedVtt === "string" ? result.translatedVtt : "";
    if (!translatedVtt.trim() || !checkpointStructure(sourceVtt, translatedVtt)) return null;
    const resultCopy = serializableCheckpointValue({
      ...result,
      translated_vtt: translatedVtt,
      failed_items: resultFailureItems(result),
      failed_cues: resultFailureCues(result),
      failure_codes: resultFailureCodes(result),
      failureCodes: resultFailureCodes(result),
    });
    if (!resultCopy || typeof resultCopy !== "object" || Array.isArray(resultCopy)) return null;
    const parsed = parseMixedCueUnits(sourceVtt);
    const failureDetails = failedCueIndexesForResult(resultCopy, parsed, { strict: true });
    const failedLines = failedLineIndexesForResult(resultCopy, parsed);
    if (!failureDetails.valid || !failedLines) return null;
    resultCopy.failed_lines = [...failedLines].map(line => line + 1);
    return {
      version: TRANSLATION_CHECKPOINT_VERSION,
      sourceVtt,
      translatedVtt,
      result: resultCopy,
    };
  }

  function validateTranslationCheckpoint(checkpoint, sourceVtt, options = {}) {
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) ||
      typeof sourceVtt !== "string" || !sourceVtt.trim() || checkpoint.sourceVtt !== sourceVtt) {
      return null;
    }
    if (checkpoint.version != null && Number(checkpoint.version) !== TRANSLATION_CHECKPOINT_VERSION) return null;
    const result = checkpoint.result && typeof checkpoint.result === "object"
      ? checkpoint.result
      : checkpoint;
    const translatedVtt = typeof checkpoint.translatedVtt === "string"
      ? checkpoint.translatedVtt
      : typeof result.translated_vtt === "string" ? result.translated_vtt : "";
    if (!translatedVtt.trim() || (result.translated_vtt != null && result.translated_vtt !== translatedVtt)) return null;
    const structure = checkpointStructure(sourceVtt, translatedVtt);
    if (!structure) return null;
    const failureDetails = failedCueIndexesForResult(result, structure.source, { strict: true });
    const failedLineIndexes = failedLineIndexesForResult(result, structure.source);
    if (!failureDetails.valid || !failedLineIndexes) return null;
    const sourceLineCount = structure.source.units.reduce((sum, unit) => sum + unit.textIndexes.length, 0);
    const failedLines = resultFailureLineCount(result);
    if (failedLines < 0 || failedLines > sourceLineCount) return null;
    if (failedLines === 0 && failureDetails.cues.size > 0) return null;
    if (options.requireFailures === true && failureDetails.cues.size === 0) return null;
    const normalizedResult = {
      ...result,
      failed_lines: [...failedLineIndexes].map(line => line + 1),
      translated_vtt: translatedVtt,
      failed_items: resultFailureItems(result),
      failed_cues: resultFailureCues(result),
      failure_codes: resultFailureCodes(result),
      failureCodes: resultFailureCodes(result),
    };
    const validate = ns.backendClient?.validateTranslationResult;
    if (typeof validate !== "function") return null;
    try {
      validate(normalizedResult, "translation", {
        sourceVtt,
        target: options.target || result?.target || "ZH",
        provider: options.provider || result?.provider,
        bilingual: options.bilingual === true,
      });
    } catch (_) {
      return null;
    }
    return {
      version: TRANSLATION_CHECKPOINT_VERSION,
      sourceVtt,
      translatedVtt,
      result: serializableCheckpointValue(normalizedResult),
      failedCueIndexes: Array.from(failureDetails.cues).sort((left, right) => left - right),
    };
  }

  function buildMixedShardVtt(units) {
    return `WEBVTT\n\n${units.map((unit) => unit.block.join("\n")).join("\n\n")}\n`;
  }

  function allocateMixedUnits(units, providers) {
    const totalWeight = providers.reduce((sum, item) => sum + item.weight, 0);
    const states = providers.map((item) => ({ ...item, current: 0, units: [] }));
    for (const unit of units) {
      for (const state of states) state.current += state.weight;
      states.sort((left, right) => right.current - left.current || right.weight - left.weight || left.provider.localeCompare(right.provider));
      states[0].units.push(unit);
      states[0].current -= totalWeight;
    }
    return states.filter((state) => state.units.length > 0);
  }

  function mixedProviderPayload(basePayload, cfg, provider, units) {
    const stored = (basePayload?.provider_configs || cfg?.providerConfigs || {})[provider] || {};
    const defaults = MIXED_PROVIDER_DEFAULTS[provider] || { model: "", endpoint: "" };
    const childBase = { ...basePayload };
    delete childBase.mixed_providers;
    delete childBase.mixed_priority_enabled;
    delete childBase.mixed_priority_groups;
    delete childBase.mixedPriorityEnabled;
    delete childBase.mixedPriorityGroups;
    delete childBase.provider_configs;
    return {
      ...childBase,
      vtt_text: buildMixedShardVtt(units),
      provider,
      model: stored.model ?? defaults.model,
      endpoint: stored.endpoint ?? defaults.endpoint,
      // Each provider gets a distinct source fragment, so its own cache entry
      // and retry policy remain correct. The outer mixed result is cached by
      // the normal page-level cache signature.
      force_refresh: !!basePayload.force_refresh,
    };
  }

  function mixedPartialTextIsUsable(value, sourceValue) {
    const text = String(value ?? "").replace(/\r/g, "").trim();
    const source = String(sourceValue ?? "").replace(/\r/g, "").trim();
    if (!text || text === source) return false;
    const pendingLabel = String(ns.constants?.SUBTITLE_PENDING_LABEL || "正在翻译中…").trim();
    const failureLabel = String(ns.constants?.SUBTITLE_FAILURE_LABEL || "翻译失败").trim();
    return text !== pendingLabel && text !== failureLabel;
  }

  // A mixed route receives a complete VTT-shaped partial from its child
  // provider. Merge only non-source text lines into the outer VTT. Pending
  // lines remain the original text, which lets the renderer turn them into
  // its normal "正在翻译中" preview without ever exposing malformed cue
  // structure or a child provider's local cue numbering.
  function applyMixedShardPartial(outputLines, sourceLines, units, partialVtt) {
    const partial = parseMixedCueUnits(partialVtt || "");
    if (partial.units.length !== units.length) return { changed: false, updatedLines: 0 };
    let changed = false;
    let updatedLines = 0;
    for (let index = 0; index < units.length; index += 1) {
      const sourceUnit = units[index];
      const partialUnit = partial.units[index];
      if (partialUnit.textIndexes.length !== sourceUnit.textIndexes.length) {
        return { changed: false, updatedLines: 0 };
      }
      for (let textIndex = 0; textIndex < sourceUnit.textIndexes.length; textIndex += 1) {
        const sourceIndex = sourceUnit.textIndexes[textIndex];
        const partialIndex = partialUnit.textIndexes[textIndex];
        const nextText = partial.lines[partialIndex];
        if (!mixedPartialTextIsUsable(nextText, sourceLines[sourceIndex])) continue;
        if (outputLines[sourceIndex] === nextText) continue;
        outputLines[sourceIndex] = nextText;
        changed = true;
        updatedLines += 1;
      }
    }
    return { changed, updatedLines };
  }

  function addMixedCountMap(target, source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return target;
    for (const [key, value] of Object.entries(source)) {
      const count = Number(value);
      if (!key || !Number.isFinite(count) || count <= 0) continue;
      target[key] = (target[key] || 0) + count;
    }
    return target;
  }

  function mixedPermanentFailure(error) {
    const code = String(error?.code || error?.error_code || "").toUpperCase();
    const status = Number(error?.status ?? error?.statusCode);
    return status === 401 || status === 403 || [
      "PROVIDER_API_KEY_MISSING", "PROVIDER_CONFIG_ERROR", "UNSUPPORTED_PROVIDER",
      "UNSUPPORTED_TARGET_LANGUAGE", "INVALID_REASONING_EFFORT", "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN",
    ].includes(code);
  }

  async function translateSingleProvider(cfg, backendUrl, payload, options = {}) {
    const provider = String(payload?.provider || cfg?.provider || "").toLowerCase();
    if (provider === "argos") {
      if (ns.buildConfig?.enableLocalBackend === false || typeof ns.backendClient?.ensureArgosBackend !== "function") {
        const error = new Error("当前构建无法启动本地 Argos 后端");
        error.code = "ARGOS_BACKEND_START_UNAVAILABLE";
        error.phase = "backend";
        throw error;
      }
      options.onProgress?.(0, 0, "正在启动 Argos 离线翻译后端…", { phase: "argos-startup", provider });
      const ready = await ns.backendClient.ensureArgosBackend(LOCAL_ARGOS_BACKEND_URL);
      return translateWithBackend(ready?.backendUrl || LOCAL_ARGOS_BACKEND_URL, payload, options);
    }
    if (provider === "custom-backend") {
      return translateWithBackend(cfg?.customBackendUrl || backendUrl, payload, options);
    }
    return translateInExtension(payload, options);
  }

  function buildResumeCueVtt(sourceParsed, failedIndexes) {
    const units = failedIndexes
      .map((index) => sourceParsed.units[index])
      .filter(Boolean);
    return buildMixedShardVtt(units);
  }

  function cueIndexFromFailureItem(item, parsed) {
    if (!item || typeof item !== "object" || !parsed?.units?.length) return null;
    const cue = Number(item.cue);
    if (Number.isSafeInteger(cue) && cue > 0 && cue <= parsed.units.length) return cue - 1;
    const line = Number(item.line);
    if (Number.isSafeInteger(line) && line > 0) {
      for (let index = 0; index < parsed.units.length; index += 1) {
        if (parsed.units[index].textIndexes.includes(line - 1)) return index;
      }
    }
    const itemIndex = Number(item.item);
    if (Number.isSafeInteger(itemIndex) && itemIndex > 0) {
      let current = 0;
      for (let index = 0; index < parsed.units.length; index += 1) {
        current += parsed.units[index].textIndexes.length;
        if (itemIndex <= current) return index;
      }
    }
    return null;
  }

  function mapRetryFailureItems(result, retryParsed, originalIndexes, sourceParsed) {
    const items = [];
    for (const rawItem of resultFailureItems(result)) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const retryIndex = cueIndexFromFailureItem(rawItem, retryParsed);
      if (retryIndex == null || originalIndexes[retryIndex] == null) continue;
      const originalIndex = originalIndexes[retryIndex];
      const sourceUnit = sourceParsed.units[originalIndex];
      const next = { ...rawItem, cue: originalIndex + 1 };
      // A provider reports `line` in the child VTT.  Translate it back to the
      // physical line in the full source so the normal UI/error validators can
      // still highlight the correct original cue.
      const retryLine = Number(rawItem.line);
      if (Number.isSafeInteger(retryLine) && retryLine > 0) {
        const retryTextOffset = retryParsed.units[retryIndex]?.textIndexes?.indexOf(retryLine - 1) ?? -1;
        if (retryTextOffset >= 0) {
          const textOffset = retryTextOffset;
          next.line = (sourceUnit?.textIndexes?.[textOffset] ?? sourceUnit?.textIndexes?.[0] ?? 0) + 1;
        } else {
          next.line = (sourceUnit?.textIndexes?.[0] ?? 0) + 1;
        }
      } else {
        next.line = (sourceUnit?.textIndexes?.[0] ?? 0) + 1;
      }
      items.push(next);
    }
    return items;
  }

  function errorAsRetryResult(error, retryPayload) {
    const partialVtt = typeof error?.partial_vtt === "string" && error.partial_vtt.trim()
      ? error.partial_vtt
      : retryPayload.vtt_text;
    return {
      translated_vtt: partialVtt,
      failed_items: Array.isArray(error?.failed_items) ? error.failed_items : [],
      failed_cues: Array.isArray(error?.failed_cues) ? error.failed_cues : [],
      ...(Array.isArray(error?.failed_lines) ? { failed_lines: error.failed_lines } : {}),
      failure_codes: error?.failure_codes || error?.failureCodes || {},
      failureCodes: error?.failureCodes || error?.failure_codes || {},
      metrics: error?.metrics && typeof error.metrics === "object" ? error.metrics : {},
      warnings: Array.isArray(error?.warnings) ? error.warnings : [],
      provider: error?.provider || retryPayload.provider,
      target: error?.target || retryPayload.target,
    };
  }

  function failedResumeAttempt(checkpoint, error, sourceParsed) {
    const base = checkpoint.result;
    const normalized = ns.errorUtils?.normalizeError?.(error) || {};
    const code = normalized.code && !ns.errorUtils?.isGenericCode?.(normalized.code)
      ? normalized.code : "RESUME_RETRY_FAILED";
    const message = String(error?.message || "补译请求失败，已保留之前的译文");
    const failureCodes = { [code]: base.metrics.failed };
    return {
      ...base,
      warnings: [message],
      failed_items: resultFailureItems(base).map(item => ({
        ...item, code, message, status: normalized.status || null,
        source_text: item.source_text || sourceParsed.lines[Number(item.line) - 1] || "",
      })),
      failure_codes: failureCodes,
      failureCodes,
      metrics: { ...base.metrics, failureCodes, failure_codes: failureCodes },
      cache_hit: false,
    };
  }

  function mergeResumeVtt(baseVtt, sourceParsed, retryVtt, originalIndexes, pendingLines) {
    const base = parseMixedCueUnits(baseVtt);
    const retry = parseMixedCueUnits(retryVtt);
    if (base.units.length !== sourceParsed.units.length || retry.units.length !== originalIndexes.length) {
      throw checkpointError("断点重试返回的字幕 cue 数量不匹配", "INCOMPLETE_TRANSLATED_VTT", {
        expectedRetryCues: originalIndexes.length,
        actualRetryCues: retry.units.length,
      });
    }
    const lines = [...base.lines];
    for (let retryIndex = 0; retryIndex < originalIndexes.length; retryIndex += 1) {
      const originalIndex = originalIndexes[retryIndex];
      const sourceUnit = sourceParsed.units[originalIndex];
      const retryUnit = retry.units[retryIndex];
      if (!sourceUnit || !retryUnit || sourceUnit.textIndexes.length !== retryUnit.textIndexes.length ||
        cueTimingSignature(sourceUnit) !== cueTimingSignature(retryUnit)) {
        throw checkpointError("断点重试返回的字幕结构与原始 cue 不一致", "TRANSLATION_TIMELINE_MISMATCH", {
          cue: originalIndex + 1,
        });
      }
      for (let lineIndex = 0; lineIndex < sourceUnit.textIndexes.length; lineIndex += 1) {
        if (!pendingLines || pendingLines.has(sourceUnit.textIndexes[lineIndex])) {
          lines[base.units[originalIndex].textIndexes[lineIndex]] = retry.lines[retryUnit.textIndexes[lineIndex]];
        }
      }
    }
    return lines.join("\n");
  }

  function mergeResumePartialVtt(checkpoint, sourceParsed, retryVtt, originalIndexes) {
    try {
      return mergeResumeVtt(checkpoint.translatedVtt, sourceParsed, retryVtt, originalIndexes,
        failedLineIndexesForResult(checkpoint.result, sourceParsed));
    } catch (_) {
      return checkpoint.translatedVtt;
    }
  }

  function mergeResumeResult(checkpoint, sourceVtt, retryResult, originalIndexes) {
    const baseResult = checkpoint.result || {};
    const sourceParsed = parseMixedCueUnits(sourceVtt);
    const retryParsed = parseMixedCueUnits(buildResumeCueVtt(sourceParsed, originalIndexes));
    const baseFailedLines = failedLineIndexesForResult(baseResult, sourceParsed);
    const retryFailedLines = failedLineIndexesForResult(retryResult, retryParsed);
    if (!baseFailedLines || !retryFailedLines) {
      throw checkpointError("补译结果没有完整、可验证的失败行位置", "TRANSLATION_FAILURE_DETAILS_MISSING");
    }
    const mergedVtt = mergeResumeVtt(checkpoint.translatedVtt, sourceParsed,
      retryResult.translated_vtt, originalIndexes, baseFailedLines);
    const lineMap = new Map(originalIndexes.flatMap((originalIndex, retryIndex) =>
      retryParsed.units[retryIndex].textIndexes.map((line, offset) => [line, sourceParsed.units[originalIndex].textIndexes[offset]])));
    const pendingRetryLines = new Set([...retryFailedLines].filter(line => baseFailedLines.has(lineMap.get(line))));
    const allFailedItems = mapRetryFailureItems({
      failed_items: failureItemsForLines(retryResult, retryParsed, pendingRetryLines),
    }, retryParsed, originalIndexes, sourceParsed);
    const failedItems = allFailedItems.slice(0, 50);
    const finalFailedIndexes = new Set(allFailedItems.map(item => item.cue - 1));
    const failedLines = allFailedItems.length;
    const totalLines = sourceParsed.units.reduce((sum, unit) => sum + unit.textIndexes.length, 0);
    const failureCodes = {};
    for (const item of allFailedItems) failureCodes[item.code] = (failureCodes[item.code] || 0) + 1;

    const baseMetrics = baseResult.metrics && typeof baseResult.metrics === "object" ? baseResult.metrics : {};
    const retryMetrics = retryResult.metrics && typeof retryResult.metrics === "object" ? retryResult.metrics : {};
    const translatedLines = Math.max(0, totalLines - failedLines);
    const observedFailureCodes = {};
    for (const result of [baseResult, retryResult]) {
      addMixedCountMap(observedFailureCodes, result.metrics?.observedFailureCodes ||
        result.metrics?.observed_failure_codes || resultFailureCodes(result));
    }
    const metrics = {
      ...baseMetrics,
      total: totalLines,
      processed: totalLines,
      translated: translatedLines,
      failed: failedLines,
      providerResults: translatedLines,
      provider_results: translatedLines,
      targetResults: translatedLines,
      target_results: translatedLines,
      totalCues: sourceParsed.units.length,
      processedCues: sourceParsed.units.length,
      translatedCues: Math.max(0, sourceParsed.units.length - finalFailedIndexes.size),
      failedCues: finalFailedIndexes.size,
      failureCodes: { ...failureCodes },
      failure_codes: { ...failureCodes },
      failed_items: failedItems,
      failed_lines: allFailedItems.map(item => item.line),
      failed_cues: Array.from(finalFailedIndexes).sort((a, b) => a - b).map(index => index + 1),
      observedFailureCodes,
      observed_failure_codes: { ...observedFailureCodes },
      retryCount: (Number(baseMetrics.retryCount) || 0) + (Number(retryMetrics.retryCount) || 0),
      rateLimitCount: (Number(baseMetrics.rateLimitCount) || 0) + (Number(retryMetrics.rateLimitCount) || 0),
      google429Responses: (Number(baseMetrics.google429Responses) || 0) + (Number(retryMetrics.google429Responses) || 0),
    };
    const merged = {
      ...baseResult,
      ...retryResult,
      translated_vtt: mergedVtt,
      // A resolved checkpoint failure must not keep the previous attempt's
      // "cue failed" warning. Provider/cache context from the current retry
      // remains useful and is surfaced by the controller.
      warnings: failedLines > 0 ? [...new Set(Array.isArray(retryResult.warnings) ? retryResult.warnings : [])] : [],
      failed_items: failedItems,
      failed_lines: allFailedItems.map(item => item.line),
      failed_cues: Array.from(finalFailedIndexes).sort((left, right) => left - right).map((index) => index + 1),
      failure_codes: { ...failureCodes },
      failureCodes: { ...failureCodes },
      metrics,
      cache_hit: false,
    };
    return merged;
  }

  async function translateWithResumeCheckpoint(cfg, backendUrl, payload, options, checkpoint) {
    const sourceParsed = parseMixedCueUnits(payload.vtt_text);
    const failedIndexes = Array.isArray(checkpoint.failedCueIndexes)
      ? checkpoint.failedCueIndexes.map(Number).filter((index) => Number.isSafeInteger(index) && index >= 0 && index < sourceParsed.units.length)
      : Array.from(failedCueIndexesForResult(checkpoint.result, sourceParsed).cues);
    const uniqueIndexes = Array.from(new Set(failedIndexes)).sort((left, right) => left - right);
    if (uniqueIndexes.length === 0) return checkpoint.result;
    const retryVtt = buildResumeCueVtt(sourceParsed, uniqueIndexes);
    const retryPayload = {
      ...payload,
      vtt_text: retryVtt,
      // A checkpoint is explicitly a request to revisit failed work. Avoid a
      // provider-side source cache returning the same failed response.
      force_refresh: true,
    };
    const totalLines = sourceParsed.units.reduce((sum, unit) => sum + unit.textIndexes.length, 0);
    const retryLineCount = uniqueIndexes.reduce((sum, index) => sum + sourceParsed.units[index].textIndexes.length, 0);
    const completedBeforeRetry = totalLines - retryLineCount;
    const retryParsed = parseMixedCueUnits(retryVtt);
    const pendingLines = failedLineIndexesForResult(checkpoint.result, sourceParsed);
    const retryLineMap = new Map(uniqueIndexes.flatMap((originalIndex, retryIndex) =>
      retryParsed.units[retryIndex].textIndexes.map((line, offset) =>
        [line + 1, sourceParsed.units[originalIndex].textIndexes[offset] + 1])));
    const retryOptions = {
      ...options,
      resumeCheckpoint: undefined,
      onProgress: (current, total, line = "", details = {}) => {
        const currentNumber = Number(current) || 0;
        options.onProgress?.(
          Math.min(totalLines, completedBeforeRetry + currentNumber),
          totalLines,
          line,
          { ...details, resumed: true, resumeCues: uniqueIndexes.length }
        );
      },
      onPartialVtt: (partialVtt, details = {}) => {
        const mergedPartial = mergeResumePartialVtt(checkpoint, sourceParsed, partialVtt, uniqueIndexes);
        const progressResult = {
          failed_items: details.failed_items || details.failedItems || details.metrics?.failed_items || details.metrics?.failedItems || [],
          failed_cues: details.failed_cues || details.failedCues || details.metrics?.failed_cues || details.metrics?.failedCues || [],
          metrics: details.metrics || {},
        };
        const localProgressFailures = failedCueIndexesForResult(progressResult, retryParsed, { strict: false });
        const localFailedLines = details.failed_lines ?? details.metrics?.failed_lines;
        const globalFailedLines = Array.isArray(localFailedLines)
          ? [...new Set(localFailedLines.map(line => retryLineMap.get(Number(line))))]
            .filter(line => line != null && pendingLines.has(line - 1)).sort((a, b) => a - b)
          : null;
        const remappedFailedItems = mapRetryFailureItems(progressResult, retryParsed, uniqueIndexes, sourceParsed)
          .filter(item => pendingLines.has(Number(item.line) - 1));
        const globalFailedCues = globalFailedLines !== null
          ? sourceParsed.units.filter(unit => unit.textIndexes.some(line => globalFailedLines.includes(line + 1))).map(unit => unit.index + 1)
          : Array.from(localProgressFailures.cues)
          .map((index) => uniqueIndexes[index])
          .filter((index) => index != null)
          .sort((left, right) => left - right)
          .map((index) => index + 1);
        options.onPartialVtt?.(mergedPartial, {
          ...details,
          failed_cues: globalFailedCues,
          failedCues: globalFailedCues,
          failed_items: remappedFailedItems,
          ...(globalFailedLines !== null ? { failed_lines: globalFailedLines } : {}),
          ...(details.metrics ? { metrics: { ...details.metrics,
            failed_items: remappedFailedItems, failed_cues: globalFailedCues,
            ...(globalFailedLines !== null ? { failed_lines: globalFailedLines } : {}),
          } } : {}),
          resumed: true,
          current: Math.min(totalLines, completedBeforeRetry + (Number(details.current || details.completed) || 0)),
          completed: Math.min(totalLines, completedBeforeRetry + (Number(details.completed || details.current) || 0)),
          total: totalLines,
        });
      },
    };

    let retryResult;
    try {
      retryResult = await translateConfiguredOnce(cfg, backendUrl, retryPayload, retryOptions);
    } catch (error) {
      const errorCode = String(error?.code || "").toUpperCase();
      if (errorCode === "TRANSLATION_CANCELLED" || errorCode === "STALE_JOB" || error?.name === "AbortError") {
        throw error;
      }
      // A provider can reject a child job because every remaining cue failed.
      // Validate the combined result, whose earlier successful cues still count.
      // Unstructured/network failures preserve the whole checkpoint, including
      // already successful lines inside a partially failed multiline cue.
      const candidate = errorAsRetryResult(error, retryPayload);
      if (resultFailureLineCount(candidate) > 0) {
        try {
          const merged = mergeResumeResult(checkpoint, payload.vtt_text, candidate, uniqueIndexes);
          return ns.backendClient.validateTranslationResult(merged, "translation", {
            sourceVtt: payload.vtt_text, target: payload.target, provider: payload.provider,
            bilingual: payload.bilingual === true,
          });
        } catch (_) { /* Keep the last verified checkpoint when a child response is incomplete. */ }
      }
      const preserved = failedResumeAttempt(checkpoint, error, sourceParsed);
      return ns.backendClient.validateTranslationResult(preserved, "translation", {
        sourceVtt: payload.vtt_text, target: payload.target, provider: payload.provider,
        bilingual: payload.bilingual === true,
      });
    }

    const merged = mergeResumeResult(checkpoint, payload.vtt_text, retryResult, uniqueIndexes);
    const validate = ns.backendClient?.validateTranslationResult;
    if (typeof validate === "function") {
      return validate(merged, "translation", {
        sourceVtt: payload.vtt_text,
        target: payload.target,
        provider: payload.provider,
        bilingual: payload.bilingual === true,
      });
    }
    return merged;
  }

  async function translateMixed(cfg, backendUrl, payload, options = {}) {
    const normalized = normalizeMixedProviderConfig(cfg, payload);
    const priority = normalized.priority;
    let providers = normalized.providers;
    const parsed = parseMixedCueUnits(payload.vtt_text);
    if (parsed.units.length === 0) {
      const error = new Error("VTT 中没有可供混合调度的字幕 cue");
      error.code = "EMPTY_TRANSLATABLE_VTT";
      error.phase = "source";
      throw error;
    }

    // A later priority group is activated only after the total number of
    // translatable cues crosses its threshold. The first group is always
    // eligible; unsupported later groups simply have no eligible providers
    // and therefore cannot be started or used as fallback routes.
    let activePriorityGroups = [];
    if (priority.enabled) {
      const cueCount = parsed.units.length;
      const thresholdGroups = priority.groups.filter((group, index) =>
        index === 0 || cueCount > group.afterCues
      );
      const activeIndexes = new Set(thresholdGroups.map((group) => group.index));
      providers = providers.filter((item) => activeIndexes.has(item.priorityIndex));
      activePriorityGroups = thresholdGroups.filter((group) =>
        providers.some((item) => item.priorityIndex === group.index)
      );
      if (providers.length === 0 || !providers.some((item) => item.priorityIndex === 0)) {
        // normalizeMixedProviderConfig already checks this for the first
        // group, but retain a typed config error if a future eligibility rule
        // changes the filtering above.
        throw mixedPriorityConfigError(
          "混合翻译优先级第一个组没有可用服务",
          { reason: "first_group_not_eligible" }
        );
      }
    }
    const groups = allocateMixedUnits(parsed.units, providers);
    const totalLines = parsed.units.reduce((sum, unit) => sum + unit.textCount, 0);
    const outputLines = [...parsed.lines];
    const providerState = new Map(providers.map((item) => [item.provider, {
      weight: item.weight,
      assignedCues: groups.find((group) => group.provider === item.provider)?.units.length || 0,
      completedCues: 0,
      failures: 0,
      fallbacksReceived: 0,
      inFlight: 0,
      circuitOpen: false,
      retryCount: 0,
      rateLimitCount: 0,
      google429Responses: 0,
      googleCircuitTripped: false,
      observedFailureCodes: {},
      ...(priority.enabled
        ? { priorityGroup: item.priorityGroup, priorityIndex: item.priorityIndex }
        : {}),
    }]));
    const providerChains = new Map();
    const routeProgress = new Map();
    const warnings = [];
    let completedLines = 0;
    const verifiedText = new Map();
    const failuresByLine = new Map();

    function isCancelled(error) {
      return ["TRANSLATION_CANCELLED", "STALE_JOB"].includes(String(error?.code || "").toUpperCase()) || error?.name === "AbortError";
    }

    function restoreVerifiedText() {
      for (const [line, text] of verifiedText) outputLines[line] = text;
    }

    function recordRouteFailure(units, error) {
      const code = String(error?.code || error?.error_code || "MIXED_ALL_PROVIDERS_FAILED");
      for (const unit of units) {
        const timing = cueTimingSignature(unit).match(/^(\S+)\s*-->\s*(\S+)/);
        for (const line of unit.textIndexes) {
          if (verifiedText.has(line)) continue;
          outputLines[line] = parsed.lines[line];
          failuresByLine.set(line, {
            cue: unit.index + 1, line: line + 1,
            code, message: String(error?.message || "所有候选翻译服务均未完成该行"),
            ...(error?.status ? { status: error.status } : {}),
            source_text: parsed.lines[line],
            timecode: timing ? `${timing[1]} --> ${timing[2]}` : "",
            start_time: timing?.[1] || "", end_time: timing?.[2] || "",
          });
        }
      }
      restoreVerifiedText();
    }

    // A route still sends whole cues, but acceptance is monotonic per text
    // line. A fallback cannot erase a line verified by an earlier provider.
    function acceptRouteResult(result, childSource, units) {
      const structure = checkpointStructure(childSource, result.translated_vtt);
      if (!structure) throw checkpointError("混合翻译分片返回了不匹配的字幕结构", "INCOMPLETE_TRANSLATED_VTT");
      let failedLines = failedLineIndexesForResult(result, structure.source);
      if (!failedLines) {
        // Older providers may identify only whole failed cues. Conservatively
        // retry those entire cues instead of guessing which rows succeeded.
        const located = failedCueIndexesForResult(result, structure.source, { strict: true });
        if (!located.valid) throw checkpointError("混合翻译分片缺少完整失败位置", "TRANSLATION_FAILURE_DETAILS_MISSING");
        failedLines = new Set([...located.cues].flatMap(cue => structure.source.units[cue].textIndexes));
      }
      const mappedFailures = mapRetryFailureItems({
        failed_items: failureItemsForLines(result, structure.source, failedLines),
      }, structure.source, units.map(unit => unit.index), parsed);
      for (const item of mappedFailures) {
        if (!verifiedText.has(item.line - 1)) failuresByLine.set(item.line - 1, item);
      }
      let succeededLines = 0;
      const failedIndexes = new Set();
      units.forEach((unit, cue) => {
        unit.textIndexes.forEach((line, offset) => {
          const childLine = structure.source.units[cue].textIndexes[offset];
          if (!verifiedText.has(line) && !failedLines.has(childLine)) {
            verifiedText.set(line, structure.translated.lines[structure.translated.units[cue].textIndexes[offset]]);
            failuresByLine.delete(line);
            succeededLines += 1;
          }
          if (!verifiedText.has(line)) {
            outputLines[line] = parsed.lines[line];
            failedIndexes.add(cue);
          }
        });
      });
      restoreVerifiedText();
      completedLines += succeededLines;
      return { succeededLines, failedIndexes };
    }

    function providerBreakdownSnapshot() {
      return Object.fromEntries(Array.from(providerState.entries()).map(([provider, state]) => [
        provider,
        {
          ...state,
          observedFailureCodes: { ...(state.observedFailureCodes || {}) },
        },
      ]));
    }

    function mixedTelemetry() {
      const observedFailureCodes = {};
      let retryCount = 0;
      let rateLimitCount = 0;
      let google429Responses = 0;
      let googleCircuitTripped = false;
      for (const state of providerState.values()) {
        retryCount += Number(state.retryCount) || 0;
        rateLimitCount += Number(state.rateLimitCount) || 0;
        google429Responses += Number(state.google429Responses) || 0;
        googleCircuitTripped = googleCircuitTripped || state.googleCircuitTripped === true;
        addMixedCountMap(observedFailureCodes, state.observedFailureCodes);
      }
      return {
        retryCount,
        rateLimitCount,
        google429Responses,
        googleCircuitTripped,
        observedFailureCodes,
        observed_failure_codes: { ...observedFailureCodes },
      };
    }

    function absorbProviderTelemetry(provider, resultOrError) {
      const state = providerState.get(provider);
      if (!state) return;
      const metrics = resultOrError?.metrics && typeof resultOrError.metrics === "object"
        ? resultOrError.metrics
        : {};
      state.retryCount += Number(metrics.retryCount) || 0;
      state.rateLimitCount += Number(metrics.rateLimitCount) || 0;
      state.google429Responses += Number(metrics.google429Responses) || 0;
      state.googleCircuitTripped = state.googleCircuitTripped || metrics.googleCircuitTripped === true;
      const observed = metrics.observedFailureCodes || metrics.observed_failure_codes ||
        metrics.failureCodes || metrics.failure_codes || resultOrError?.failure_codes || resultOrError?.failureCodes;
      addMixedCountMap(state.observedFailureCodes, observed);
      const status = Number(resultOrError?.status ?? resultOrError?.statusCode);
      if (status === 429) state.observedFailureCodes.HTTP_429 = (state.observedFailureCodes.HTTP_429 || 0) + 1;
      const code = String(resultOrError?.code || resultOrError?.error_code || "").trim().toUpperCase();
      if (code && code !== "ERROR" && code !== "UNKNOWN" && code !== "UNKNOWN_ERROR") {
        state.observedFailureCodes[code] = (state.observedFailureCodes[code] || 0) + 1;
      }
    }

    function reportProgress(routeKey, current, total, line, provider, isFallback = false, completedBeforeAttempt = 0, attemptLines = null) {
      const group = groups.find((item) => item.provider === routeKey);
      const groupLines = (group?.units || []).reduce((sum, unit) => sum + unit.textCount, 0);
      const scopedLines = Number.isFinite(attemptLines) ? attemptLines : groupLines;
      const fraction = Number(total) > 0 ? Math.max(0, Math.min(1, Number(current) / Number(total))) : 0;
      const next = Math.min(groupLines, completedBeforeAttempt + Math.round(scopedLines * fraction));
      routeProgress.set(routeKey, Math.max(routeProgress.get(routeKey) || 0, next));
      const inFlight = Math.max(completedLines, Math.min(totalLines, Array.from(routeProgress.values()).reduce((sum, value) => sum + value, 0)));
      options.onProgress?.(inFlight, totalLines, `混合翻译 · ${provider}${isFallback ? "（故障转移）" : ""}${line ? ` · ${line}` : ""}`, {
        phase: "mixed-translation",
        provider: "mixed",
        activeProvider: provider,
        fallback: isFallback,
        providerBreakdown: providerBreakdownSnapshot(),
      });
      return inFlight;
    }

    async function withProviderLease(provider, operation) {
      const previous = providerChains.get(provider) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      providerChains.set(provider, previous.catch(() => {}).then(() => gate));
      await previous.catch(() => {});
      const state = providerState.get(provider);
      if (state.circuitOpen) {
        release();
        const error = new Error(`${provider} 已在本次混合翻译中熔断`);
        error.code = "MIXED_PROVIDER_CIRCUIT_OPEN";
        throw error;
      }
      state.inFlight += 1;
      try {
        return await operation();
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1);
        release();
      }
    }

    async function runRoute(group) {
      const attempted = new Set();
      let lastError = null;
      let pendingUnits = [...group.units];
      let completedRouteLines = 0;
      while (pendingUnits.length > 0 && attempted.size < providers.length) {
        if (typeof options.isActive === "function" && !options.isActive()) {
          throw checkpointError("翻译任务已失效", "STALE_JOB");
        }
        const candidate = attempted.size === 0
          ? group.provider
          : providers
            .filter((item) => !attempted.has(item.provider) && !providerState.get(item.provider)?.circuitOpen)
            .sort((left, right) => {
              const leftState = providerState.get(left.provider);
              const rightState = providerState.get(right.provider);
              const priorityOrder = priority.enabled
                ? leftState.priorityIndex - rightState.priorityIndex
                : 0;
              if (priorityOrder !== 0) return priorityOrder;
              return leftState.failures - rightState.failures ||
                (leftState.inFlight / left.weight) - (rightState.inFlight / right.weight) ||
                leftState.fallbacksReceived - rightState.fallbacksReceived ||
                right.weight - left.weight;
            })[0]?.provider;
        if (!candidate) break;
        attempted.add(candidate);
        const state = providerState.get(candidate);
        const isFallback = candidate !== group.provider;
        if (isFallback) state.fallbacksReceived += 1;
        const attemptedUnits = pendingUnits;
        const attemptedLines = attemptedUnits.reduce((sum, unit) => sum + unit.textCount, 0);
        const childPayload = mixedProviderPayload(payload, cfg, candidate, attemptedUnits);
        try {
          const result = await withProviderLease(candidate, () => translateSingleProvider(cfg, backendUrl, childPayload, {
            ...options,
            onProgress: (current, total, line = "") => reportProgress(
              group.provider,
              current,
              total,
              line,
              candidate,
              isFallback,
              completedRouteLines,
              attemptedLines
            ),
            onPartialVtt: (partialVtt, partialMeta = {}) => {
              const merged = applyMixedShardPartial(outputLines, parsed.lines, attemptedUnits, partialVtt);
              restoreVerifiedText();
              const partialCurrent = Number(partialMeta?.current ?? partialMeta?.completed ?? 0);
              const partialTotal = Number(partialMeta?.total ?? attemptedLines);
              const inFlight = reportProgress(
                group.provider,
                partialCurrent,
                partialTotal,
                partialMeta?.line || "",
                candidate,
                isFallback,
                completedRouteLines,
                attemptedLines
              );
              if (!merged.changed) return;
              const telemetry = mixedTelemetry();
              options.onPartialVtt?.(outputLines.join("\n"), {
                current: inFlight,
                completed: inFlight,
                total: totalLines,
                done: false,
                translated: inFlight,
                failed: 0,
                activeProvider: candidate,
                fallback: isFallback,
                metrics: {
                  provider: "mixed",
                  total: totalLines,
                  totalCues: parsed.units.length,
                  processed: inFlight,
                  translated: inFlight,
                  failed: 0,
                  providerResults: inFlight,
                  targetResults: inFlight,
                  providerBreakdown: providerBreakdownSnapshot(),
                  ...telemetry,
                },
              });
            },
          }));
          absorbProviderTelemetry(candidate, result);
          const { failedIndexes, succeededLines } = acceptRouteResult(result, childPayload.vtt_text, attemptedUnits);
          const succeededUnits = attemptedUnits.filter((_unit, index) => !failedIndexes.has(index));
          state.completedCues += succeededUnits.length;
          completedRouteLines += succeededLines;
          routeProgress.set(group.provider, completedRouteLines);
          options.onPartialVtt?.(outputLines.join("\n"), {
            current: completedLines,
            completed: completedLines,
            total: totalLines,
            done: false,
            translated: completedLines,
            failed: 0,
            metrics: {
              provider: "mixed",
              total: totalLines,
              totalCues: parsed.units.length,
              processed: completedLines,
              translated: completedLines,
              failed: 0,
              providerResults: completedLines,
              targetResults: completedLines,
              providerBreakdown: providerBreakdownSnapshot(),
              ...mixedTelemetry(),
            },
          });
          if (failedIndexes.size === 0) {
            if (isFallback) warnings.push(`${group.provider} 的剩余分片已由 ${candidate} 接管并完成。`);
            reportProgress(group.provider, 1, 1, "分片完成", candidate, isFallback, completedRouteLines, 0);
            return;
          }

          pendingUnits = attemptedUnits.filter((_unit, index) => failedIndexes.has(index));
          const partialError = new Error(`${candidate} 有 ${pendingUnits.length} 个 cue 未完成，已保留成功结果并准备改派`);
          partialError.code = "MIXED_PARTIAL_PROVIDER_RESULT";
          partialError.result = result;
          const firstFailure = result.failed_items?.[0];
          partialError.status = firstFailure?.status ?? null;
          lastError = partialError;
          state.failures += 1;
          if (mixedPermanentFailure(firstFailure) || state.failures >= 2) state.circuitOpen = true;
          warnings.push(`${candidate} 有 ${pendingUnits.length} 个 cue 失败${state.circuitOpen ? "，本次任务已熔断" : ""}；已保留 ${succeededUnits.length} 个成功 cue 并改派。`);
        } catch (error) {
          if (isCancelled(error)) throw error;
          recordRouteFailure(attemptedUnits, error);
          if (error?.partial_vtt && resultFailureLineCount(error) > 0) {
            try {
              const accepted = acceptRouteResult(errorAsRetryResult(error, childPayload), childPayload.vtt_text, attemptedUnits);
              completedRouteLines += accepted.succeededLines;
              const completedCues = attemptedUnits.length - accepted.failedIndexes.size;
              state.completedCues += completedCues;
              pendingUnits = attemptedUnits.filter((_unit, index) => accepted.failedIndexes.has(index));
              if (pendingUnits.length === 0) return;
            } catch (_) { /* Retain only previously verified rows for incomplete errors. */ }
          }
          absorbProviderTelemetry(candidate, error);
          lastError = error;
          state.failures += 1;
          if (mixedPermanentFailure(error) || state.failures >= 2) state.circuitOpen = true;
          warnings.push(`${candidate} 分片失败${state.circuitOpen ? "，本次任务已熔断" : ""}：${error?.message || String(error)}`);
        }
      }
      // All candidates were attempted. Unresolved rows already carry the
      // latest diagnostic; siblings may still finish before finalization.
      for (const unit of pendingUnits) {
        if (unit.textIndexes.some(line => !verifiedText.has(line) && !failuresByLine.has(line))) {
          recordRouteFailure([unit], lastError);
        }
      }
    }

    const routeResults = await Promise.allSettled(groups.map(group => runRoute(group)));
    const rejected = routeResults.find(item => item.status === "rejected" && isCancelled(item.reason)) ||
      routeResults.find(item => item.status === "rejected");
    if (rejected) throw rejected.reason;
    if (typeof options.isActive === "function" && !options.isActive()) {
      throw checkpointError("翻译任务已失效", "STALE_JOB");
    }
    const allFailedItems = [...failuresByLine.entries()]
      .filter(([line]) => !verifiedText.has(line)).sort(([a], [b]) => a - b).map(([, item]) => item);
    const failedLines = allFailedItems.map(item => item.line);
    const failedCues = [...new Set(allFailedItems.map(item => item.cue))];
    const failureCodes = {};
    for (const item of allFailedItems) failureCodes[item.code] = (failureCodes[item.code] || 0) + 1;
    const telemetry = mixedTelemetry();
    const providerBreakdown = providerBreakdownSnapshot();
    const metrics = {
      provider: "mixed",
      total: totalLines,
      totalCues: parsed.units.length,
      processed: totalLines,
      processedCues: parsed.units.length,
      translated: completedLines,
      translatedCues: parsed.units.length - failedCues.length,
      failed: failedLines.length,
      failedCues: failedCues.length,
      providerResults: completedLines,
      provider_results: completedLines,
      targetResults: completedLines,
      target_results: completedLines,
      failed_items: allFailedItems.slice(0, 50),
      failed_lines: failedLines,
      failed_cues: failedCues,
      failureCodes,
      failure_codes: { ...failureCodes },
      providerBreakdown,
      ...telemetry,
    };
    if (priority.enabled) {
      const activeGroups = activePriorityGroups.map((group) => ({
        id: group.id,
        index: group.index,
        afterCues: group.afterCues,
        providerCount: providers.filter((item) => item.priorityIndex === group.index).length,
      }));
      const mixedPriority = {
        enabled: true,
        count: priority.groups.length,
        groupCount: priority.groups.length,
        activeGroupCount: activeGroups.length,
        activeGroups,
        activeGroupIds: activeGroups.map((group) => group.id),
      };
      metrics.mixedPriority = mixedPriority;
      // Keep a snake_case mirror for consumers that use the backend payload
      // naming convention while retaining the camelCase public metrics shape.
      metrics.mixed_priority = {
        enabled: mixedPriority.enabled,
        count: mixedPriority.count,
        group_count: mixedPriority.groupCount,
        active_group_count: mixedPriority.activeGroupCount,
        active_groups: activeGroups,
      };
    }
    const result = {
      translated_vtt: outputLines.join("\n"),
      provider: "mixed",
      target: payload.target,
      warnings,
      failed_items: allFailedItems.slice(0, 50),
      failed_lines: failedLines,
      failed_cues: failedCues,
      failure_codes: failureCodes,
      failureCodes: { ...failureCodes },
      metrics,
      cache_hit: false,
    };
    options.onPartialVtt?.(result.translated_vtt, {
      completed: totalLines,
      total: totalLines,
      done: true,
      translated: completedLines,
      failed: failedLines.length,
      failed_items: result.failed_items,
      failed_cues: failedCues,
      failed_lines: failedLines,
      metrics,
    });
    if (completedLines === 0 && failedLines.length > 0) {
      const error = new Error(`混合翻译仍有 ${failedCues.length} 个 cue 无法完成；所有候选服务均失败`);
      Object.assign(error, result, {
        code: "MIXED_ALL_PROVIDERS_FAILED", phase: "translation",
        partial_vtt: result.translated_vtt, providerBreakdown,
      });
      throw error;
    }
    const validate = ns.backendClient?.validateTranslationResult;
    return typeof validate === "function"
      ? validate(result, "translation", {
        sourceVtt: payload.vtt_text,
        target: payload.target,
        provider: "mixed",
        bilingual: false,
      })
      : result;
  }

  async function translateConfiguredOnce(cfg, backendUrl, payload, options = {}) {
    if (String(payload?.provider || cfg?.provider || "").toLowerCase() === "mixed") {
      return translateMixed(cfg, backendUrl, payload, options);
    }
    try {
      return await translateSingleProvider(cfg, backendUrl, payload, options);
    } catch (error) {
      if (!shouldFallbackGoogleToArgos(error, payload) || ns.buildConfig?.enableLocalBackend === false) {
        throw error;
      }
      return await translateWithArgosFallback(backendUrl, payload, options, error);
    }
  }

  async function translateWithConfig(cfg, backendUrl, payload, options = {}) {
    const checkpoint = validateTranslationCheckpoint(options.resumeCheckpoint, payload?.vtt_text, {
      target: payload?.target || cfg?.target,
      provider: payload?.provider || cfg?.provider,
      requireFailures: true,
    });
    if (checkpoint) {
      return translateWithResumeCheckpoint(cfg, backendUrl, payload, options, checkpoint);
    }
    return translateConfiguredOnce(cfg, backendUrl, payload, options);
  }

  async function buildCacheKey(cfg, sourceId, vttText, options = {}) {
    const stableSourceId = String(ns.sourceFinder?.canonicalizeSourceId?.(sourceId) || sourceId || "").trim();
    // A canonical source URL already identifies the subtitle bytes for cache
    // purposes. Avoid hashing the full VTT (which can be several megabytes)
    // unless the source adapter could not provide a stable identifier.
    const sourceKey = stableSourceId || `${location.href}#${await ns.storage.sha256Text(vttText)}`;
    const baseConfigSig = ns.storage.buildConfigSignature(cfg);
    // Merge mode is identified by algorithm version, not by hashing grouped
    // VTT. A canonical source URL already stands in for subtitle bytes; the
    // cache validator still rejects stored cues that no longer line up.
    const configSig = options.sentenceMergeEnabled === true
      ? `${baseConfigSig}::sentence-merge-v2`
      : baseConfigSig;
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
    buildTranslationCheckpoint,
    validateTranslationCheckpoint,
    shouldFallbackGoogleToArgos,
    buildArgosFallbackPayload,
    normalizeMixedProviders,
    normalizeMixedPriorityGroups,
    parseMixedCueUnits,
    allocateMixedUnits,
    translateMixed,
    buildCacheKey,
  };
})();
