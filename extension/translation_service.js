(() => {
  const ns = window.Echo360Translator;
  const MIXABLE_PROVIDER_CODES = new Set(["google-web", "deepl", "azure", "openai", "deepseek", "gemini", "argos", "custom-backend"]);
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
    const sourceOptions = { deadlineAt: sourceDeadlineAt };
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
      // adapter clamps Google Web to its conservative 3 RPS / 3-worker profile.
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

  function applyMixedShardResult(outputLines, units, result, skippedUnitIndexes = new Set()) {
    const translated = parseMixedCueUnits(result?.translated_vtt || "");
    if (translated.units.length !== units.length) {
      const error = new Error(`混合翻译分片返回 ${translated.units.length} 个 cue，预期 ${units.length} 个`);
      error.code = "INCOMPLETE_TRANSLATED_VTT";
      error.phase = "translation";
      throw error;
    }
    for (let index = 0; index < units.length; index += 1) {
      if (skippedUnitIndexes.has(index)) continue;
      const sourceUnit = units[index];
      const resultUnit = translated.units[index];
      if (resultUnit.textIndexes.length !== sourceUnit.textIndexes.length) {
        const error = new Error(`混合翻译分片第 ${index + 1} 个 cue 的文本行数不一致`);
        error.code = "INCOMPLETE_TRANSLATED_VTT";
        error.phase = "translation";
        throw error;
      }
      for (let textIndex = 0; textIndex < sourceUnit.textIndexes.length; textIndex += 1) {
        outputLines[sourceUnit.textIndexes[textIndex]] = translated.lines[resultUnit.textIndexes[textIndex]];
      }
    }
  }

  function mixedFailedUnitIndexes(result, unitCount) {
    const failedItems = Array.isArray(result?.failed_items) ? result.failed_items : [];
    const expectedFailed = Number(result?.metrics?.failed);
    const indexes = new Set();
    const failedCues = Array.isArray(result?.failed_cues) && result.failed_cues.length > 0
      ? result.failed_cues
      : failedItems.map((item) => item?.cue);
    for (const cue of failedCues) {
      const index = Number(cue) - 1;
      if (Number.isInteger(index) && index >= 0 && index < unitCount) indexes.add(index);
    }
    // metrics.failed counts failed text lines, while the mixed scheduler owns
    // whole cues. Multiple failed lines in one cue therefore legitimately map
    // to one retry unit and must not be mistaken for missing diagnostics.
    if ((failedCues.length > 0 && indexes.size === 0) ||
      (Number.isFinite(expectedFailed) && expectedFailed > 0 && failedCues.length === 0)) {
      const error = new Error("混合翻译分片没有返回可定位全部失败 cue 的明细");
      error.code = "TRANSLATION_FAILURE_DETAILS_MISSING";
      error.phase = "translation";
      error.details = { expectedFailedLines: expectedFailed, locatedFailedCues: indexes.size };
      throw error;
    }
    return indexes;
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
      ...(priority.enabled
        ? { priorityGroup: item.priorityGroup, priorityIndex: item.priorityIndex }
        : {}),
    }]));
    const providerChains = new Map();
    const routeProgress = new Map();
    const warnings = [];
    let completedLines = 0;

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
        providerBreakdown: Object.fromEntries(providerState),
      });
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
            // A child partial cannot be merged safely until all of its cue
            // lines have passed the normal result validator.
            onPartialVtt: () => {},
          }));
          const failedIndexes = mixedFailedUnitIndexes(result, attemptedUnits.length);
          applyMixedShardResult(outputLines, attemptedUnits, result, failedIndexes);
          const succeededUnits = attemptedUnits.filter((_unit, index) => !failedIndexes.has(index));
          const succeededLines = succeededUnits.reduce((sum, unit) => sum + unit.textCount, 0);
          state.completedCues += succeededUnits.length;
          completedLines += succeededLines;
          completedRouteLines += succeededLines;
          routeProgress.set(group.provider, completedRouteLines);
          options.onPartialVtt?.(outputLines.join("\n"), {
            completed: completedLines,
            total: totalLines,
            done: false,
            translated: completedLines,
            failed: 0,
            metrics: { provider: "mixed", providerBreakdown: Object.fromEntries(providerState) },
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
          lastError = error;
          state.failures += 1;
          if (mixedPermanentFailure(error) || state.failures >= 2) state.circuitOpen = true;
          warnings.push(`${candidate} 分片失败${state.circuitOpen ? "，本次任务已熔断" : ""}：${error?.message || String(error)}`);
        }
      }
      const error = new Error(`混合翻译仍有 ${pendingUnits.length} 个 cue 无法完成；所有候选服务均失败`);
      error.code = "MIXED_ALL_PROVIDERS_FAILED";
      error.phase = "translation";
      error.cause = lastError;
      error.warnings = warnings.slice(0, 30);
      error.providerBreakdown = Object.fromEntries(providerState);
      error.partial_vtt = outputLines.join("\n");
      throw error;
    }

    // Wait for every route to settle before surfacing a terminal error. Using
    // Promise.all here would reject immediately while sibling provider calls
    // continued in the background, producing confusing progress/cache writes
    // after the UI had already reported failure.
    const routeResults = await Promise.allSettled(groups.map((group) => runRoute(group)));
    const failedRoute = routeResults.find((item) => item.status === "rejected");
    if (failedRoute) {
      const error = failedRoute.reason instanceof Error
        ? failedRoute.reason
        : new Error(String(failedRoute.reason || "混合翻译失败"));
      error.code = error.code || "MIXED_ALL_PROVIDERS_FAILED";
      error.phase = error.phase || "translation";
      error.warnings = warnings.slice(0, 30);
      error.providerBreakdown = Object.fromEntries(providerState);
      error.partial_vtt = outputLines.join("\n");
      throw error;
    }
    const metrics = {
      provider: "mixed",
      total: totalLines,
      processed: totalLines,
      translated: totalLines,
      failed: 0,
      providerResults: totalLines,
      provider_results: totalLines,
      targetResults: totalLines,
      target_results: totalLines,
      failureCodes: {},
      failure_codes: {},
      providerBreakdown: Object.fromEntries(providerState),
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
      failed_items: [],
      failure_codes: {},
      failureCodes: {},
      metrics,
      cache_hit: false,
    };
    options.onPartialVtt?.(result.translated_vtt, {
      completed: totalLines,
      total: totalLines,
      done: true,
      translated: totalLines,
      failed: 0,
      metrics,
    });
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

  async function translateWithConfig(cfg, backendUrl, payload, options = {}) {
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
