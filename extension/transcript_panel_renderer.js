(() => {
  const ns = window.Echo360Translator;
  const adapter = () => ns.transcriptPanelAdapter;
  const modelApi = () => ns.transcriptModel;
  const ATTR = "data-echo360-transcript-translation";
  const ROW_ATTR = "data-echo360-transcript-decorated-row";
  const LAYOUT_PENDING_ATTR = "data-echo360-transcript-layout-pending";
  const SOURCE = "echo360-translator-transcript";
  const PAGE_SOURCE = "echo360-translator-transcript-page";
  const VERSION = 1;
  const CAPABILITY = "echo-react-virtualized-v1";
  const SEARCH_BRIDGE_ATTR = "data-echo360-transcript-search-bridge";
  const SEARCH_HIT_ATTR = "data-echo360-transcript-search-hit";
  const DEBUG_ELEMENT_ID = "echo360-transcript-panel-debug";
  const DEBUG_PUBLISH_THROTTLE_MS = 250;
  // A React commit can temporarily occupy the main thread while the
  // virtualized row manager recalculates offsets.  The old 350 ms deadline
  // could therefore misclassify a valid bridge response as a failure.  The
  // failure path removes all Chinese nodes and restores native heights, which
  // is the visible scroll-away/scroll-back loop seen during playback.
  const BRIDGE_TIMEOUT_MS = Object.freeze({
    capabilities: 1200,
    "set-layout": 1200,
    "restore-layout": 1200,
    "scroll-to-row": 900,
  });
  const BRIDGE_MAX_ATTEMPTS = Object.freeze({
    capabilities: 2,
    "set-layout": 2,
    "restore-layout": 2,
    "scroll-to-row": 2,
  });
  const LAYOUT_REVALIDATE_MS = 2000;
  const LAYOUT_PROBE_ATTEMPTS = 8;
  const LAYOUT_OVERLAP_TOLERANCE_PX = 6;
  const LAYOUT_EXTRA_MARGIN_PX = 8;
  const LANG_BY_TARGET = {
    ZH: "zh-Hans", "ZH-HK": "zh-Hant", YUE: "zh-Hant", JA: "ja", EN: "en",
    KO: "ko", FR: "fr", DE: "de", ES: "es", IT: "it", PT: "pt", RU: "ru", AR: "ar", HI: "hi",
  };

  const state = {
    model: null,
    enabled: true,
    started: false,
    documentObserver: null,
    panelObservers: new Map(),
    panelRoots: new Set(),
    panelStates: new Map(),
    pendingRequests: new Map(),
    // A flush can await a MAIN-world bridge response while React and the
    // ResizeObserver are already scheduling another pass.  Keep one render
    // transaction in flight and coalesce those follow-up signals; otherwise
    // two passes share panelState.revision and a valid older response can be
    // mistaken for a failed `set-layout` request.
    flushInFlight: null,
    flushPending: false,
    flushScheduled: false,
    flushHandle: null,
    flushGeneration: 0,
    warnedReasons: new Set(),
    ownMutationDepth: 0,
    styleEl: null,
    diagnostics: {
      active: false,
      sessionKey: null,
      target: null,
      modelCueCount: 0,
      modelOriginalCueCount: 0,
      modelTranslatedCueCount: 0,
      modelMappedCueCount: 0,
      modelUnmappedCueCount: 0,
      panelCount: 0,
      discoveredCueRows: 0,
      decoratedCueRows: 0,
      unmappedCueRows: 0,
      duplicateTextResolutions: 0,
      searchQuery: "",
      translatedMatchCount: 0,
      nativeSearchMode: "echo-cue-model",
      observerFlushCount: 0,
      lastFlushDurationMs: 0,
      maxFlushDurationMs: 0,
      virtualizedTargetMisses: 0,
      layoutCapability: "unavailable",
      layoutRevision: 0,
      layoutExtraRowCount: 0,
      layoutBridgeFailures: 0,
      lastLayoutFailure: null,
      rawPanelCount: 0,
      rawListCount: 0,
      rawSearchInputCount: 0,
      verifiedPanelCount: 0,
      lastBridgeAction: null,
      lastBridgeResult: null,
      lastBridgeDetail: null,
      lastBridgeElapsedMs: 0,
      adapter: "new-player-v1",
    },
  };
  let lastDebugPublishAt = -Infinity;
  let lastReadyDiagnosticSession = null;

  function nextId(prefix = "t") {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`.slice(0, 120);
  }

  function ensureStyle() {
    if (state.styleEl?.isConnected) return;
    state.styleEl = document.createElement("style");
    state.styleEl.id = "echo360-transcript-panel-style";
    state.styleEl.textContent = `
      [${ATTR}="1"] {
        display: block;
        margin-top: 0.25rem;
        line-height: 1.45;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: inherit;
        opacity: 0.86;
      }
      /*
       * A react-virtualized commit can briefly leave the row manager's
       * absolute top/height styles one commit behind the DOM content.  The
       * pending marker is retained as an internal layout state, but the
       * translated node is never hidden: the bridge must fix row geometry
       * instead of masking an overlap by removing Chinese from the screen.
       */
      [${ROW_ATTR}="1"] { height: auto !important; }
      .echo360-transcript-search-bridge {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        margin-top: 0.25rem;
        font-size: 0.82em;
        line-height: 1.3;
      }
      .echo360-transcript-search-bridge[hidden] { display: none; }
      .echo360-transcript-search-bridge button { cursor: pointer; }
      [${ATTR}="1"].echo360-transcript-search-current {
        outline: 2px solid currentColor;
        outline-offset: 1px;
      }
    `;
    (document.head || document.documentElement).appendChild(state.styleEl);
  }

  function panelDiagnosticSnapshot() {
    return [...state.panelStates.values()].map((panelState) => ({
      connected: !!panelState.root?.isConnected,
      virtualized: !!panelState.descriptor?.virtualized,
      modelRowCount: Number(panelState.modelRowCount || 0),
      visibleRowCount: Number.isInteger(panelState.visibleRowCount) ? panelState.visibleRowCount : null,
      layout: panelState.layout || "unknown",
      token: panelState.token || "",
    }));
  }

  function publishDiagnostics(force = false) {
    if (typeof document === "undefined") return;
    const now = performance.now();
    if (!force && now - lastDebugPublishAt < DEBUG_PUBLISH_THROTTLE_MS) return;
    lastDebugPublishAt = now;
    const snapshot = {
      version: 1,
      adapter: state.diagnostics.adapter,
      active: state.diagnostics.active,
      enabled: state.enabled,
      modelCueCount: state.diagnostics.modelCueCount,
      modelOriginalCueCount: state.diagnostics.modelOriginalCueCount,
      modelTranslatedCueCount: state.diagnostics.modelTranslatedCueCount,
      modelMappedCueCount: state.diagnostics.modelMappedCueCount,
      modelUnmappedCueCount: state.diagnostics.modelUnmappedCueCount,
      sessionKey: state.diagnostics.sessionKey,
      target: state.diagnostics.target,
      rawPanelCount: state.diagnostics.rawPanelCount,
      rawListCount: state.diagnostics.rawListCount,
      rawSearchInputCount: state.diagnostics.rawSearchInputCount,
      verifiedPanelCount: state.diagnostics.verifiedPanelCount,
      panelCount: state.panelRoots.size,
      panels: panelDiagnosticSnapshot(),
      discoveredCueRows: state.diagnostics.discoveredCueRows,
      decoratedCueRows: state.diagnostics.decoratedCueRows,
      unmappedCueRows: state.diagnostics.unmappedCueRows,
      layoutCapability: state.diagnostics.layoutCapability,
      layoutRevision: state.diagnostics.layoutRevision,
      layoutExtraRowCount: state.diagnostics.layoutExtraRowCount,
      layoutBridgeFailures: state.diagnostics.layoutBridgeFailures,
      lastLayoutFailure: state.diagnostics.lastLayoutFailure,
      lastBridgeAction: state.diagnostics.lastBridgeAction,
      lastBridgeResult: state.diagnostics.lastBridgeResult,
      lastBridgeDetail: state.diagnostics.lastBridgeDetail,
      lastBridgeElapsedMs: state.diagnostics.lastBridgeElapsedMs,
      observerFlushCount: state.diagnostics.observerFlushCount,
      lastFlushDurationMs: state.diagnostics.lastFlushDurationMs,
    };
    try {
      let element = document.getElementById(DEBUG_ELEMENT_ID);
      if (!element) {
        element = document.createElement("meta");
        element.id = DEBUG_ELEMENT_ID;
        element.setAttribute("name", "echo360-translator-transcript-panel-debug");
        (document.head || document.documentElement).appendChild(element);
      }
      element.setAttribute("content", JSON.stringify(snapshot));
    } catch (_) {}
    if (snapshot.active && snapshot.decoratedCueRows > 0 && snapshot.sessionKey !== lastReadyDiagnosticSession) {
      lastReadyDiagnosticSession = snapshot.sessionKey;
      try {
        console.info("[echo360-translator] Transcript panel ready", {
          modelCueCount: snapshot.modelCueCount,
          panelCount: snapshot.panelCount,
          discoveredCueRows: snapshot.discoveredCueRows,
          decoratedCueRows: snapshot.decoratedCueRows,
          layoutCapability: snapshot.layoutCapability,
          visibleRowCount: snapshot.panels[0]?.visibleRowCount ?? null,
        });
      } catch (_) {}
    }
  }

  function isExtensionOnlyMutation(records) {
    if (!records?.length) return false;
    return records.every((record) => {
      // A React commit can remove an extension-owned translation as an
      // otherwise "extension-only" child-list mutation.  That removal is
      // precisely the signal that the next flush must repair; suppressing it
      // leaves the panel in the transient state seen in the field recording
      // (Chinese appears once, then disappears after the virtual list commits
      // its row).  Mutations that remove our marker are therefore never
      // treated as ignorable here.  Renderer-owned removals may schedule one
      // extra idempotent flush, but they cannot loop because the next pass has
      // no marker to remove.
      const removedNodes = [...(record.removedNodes || [])];
      if (removedNodes.some((node) => node.nodeType === 1 &&
        node.matches?.(`[${ATTR}="1"]`))) return false;
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      if (target?.closest?.(`[${ATTR}="1"], [${SEARCH_BRIDGE_ATTR}="1"]`)) return true;
      const nodes = [...(record.addedNodes || []), ...removedNodes];
      return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && (
        node.matches?.(`[${ATTR}="1"], [${SEARCH_BRIDGE_ATTR}="1"], [${SEARCH_HIT_ATTR}="1"]`) ||
        node.closest?.(`[${ATTR}="1"], [${SEARCH_BRIDGE_ATTR}="1"]`)
      ));
    });
  }

  function postBridge(action, panelState, payload = {}, timeoutMs = 350) {
    if (!panelState?.descriptor?.virtualized) return Promise.resolve({ ok: true, capability: "static" });
    const requestId = nextId("request");
    const panelToken = panelState.token;
    const started = performance.now();
    state.diagnostics.lastBridgeAction = action;
    const message = {
      source: SOURCE,
      version: VERSION,
      requestId,
      action,
      panelToken,
      revision: Number(payload.revision || 0),
      // The model count is the protocol upper bound.  MAIN may expose only a
      // gated prefix of these rows, and reports that prefix as visibleRowCount.
      rowCount: Number(panelState.modelRowCount || 0),
      ...payload,
    };
    return new Promise((resolve) => {
      const finish = (result) => {
        state.diagnostics.lastBridgeResult = result?.ok
          ? (result.capability || "ok")
          : String(result?.error || "unknown");
        // Keep a small, non-transcript diagnostic payload so a failed bridge
        // can be distinguished from a response that was silently rejected.
        // This is especially useful on Safari where a stale page-world
        // bridge can otherwise look identical to a timing timeout.
        state.diagnostics.lastBridgeDetail = result && typeof result === "object"
          ? {
            ok: result.ok === true,
            error: result.error ? String(result.error) : null,
            transient: result.transient === true,
            capability: result.capability ? String(result.capability) : null,
            appliedRevision: Number.isFinite(Number(result.appliedRevision)) ? Number(result.appliedRevision) : null,
            visibleRowCount: Number.isFinite(Number(result.visibleRowCount)) ? Number(result.visibleRowCount) : null,
          }
          : null;
        state.diagnostics.lastBridgeElapsedMs = Number((performance.now() - started).toFixed(2));
        publishDiagnostics(true);
        resolve(result);
      };
      const timer = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        finish({ ok: false, error: "timeout" });
      }, timeoutMs);
      state.pendingRequests.set(requestId, { timer, resolve: finish });
      try {
        window.postMessage(message, "*");
      } catch (error) {
        clearTimeout(timer);
        state.pendingRequests.delete(requestId);
        finish({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  function isRetryableBridgeResult(result) {
    return result?.error === "timeout" || result?.transient === true;
  }

  async function postBridgeWithRetry(action, panelState, payload = {}, timeoutMs = 350, maxAttempts = 3) {
    let result = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 16 * attempt));
      }
      result = await postBridge(action, panelState, payload, timeoutMs);
      if (result?.ok || !isRetryableBridgeResult(result)) return result;
    }
    return result;
  }

  function bridgeTimeoutFor(action) {
    return Number(BRIDGE_TIMEOUT_MS[action] || 1200);
  }

  function bridgeAttemptsFor(action) {
    return Number(BRIDGE_MAX_ATTEMPTS[action] || 2);
  }

  function clearLayoutRetry(panelState) {
    if (!panelState) return;
    if (panelState.layoutRetryTimer != null) {
      try { clearTimeout(panelState.layoutRetryTimer); } catch (_) {}
    }
    panelState.layoutRetryTimer = null;
    panelState.layoutRetryCount = 0;
  }

  function scheduleLayoutRetry(panelState) {
    if (!panelState?.root?.isConnected || panelState.layoutRetryTimer != null) return;
    panelState.layoutRetryCount = Math.min(6, Number(panelState.layoutRetryCount || 0) + 1);
    const delay = Math.min(2400, 180 * (2 ** Math.max(0, panelState.layoutRetryCount - 1)));
    panelState.layoutRetryTimer = setTimeout(() => {
      panelState.layoutRetryTimer = null;
      if (!panelState.root?.isConnected || panelState.layout !== "ready") return;
      panelState.layoutNeedsSync = true;
      scheduleFlush();
    }, delay);
  }

  function preserveTransientLayoutFailure(panelState, result) {
    // A timeout/transient response does not prove that MAIN failed.  It may
    // have applied the row-height update and lost only the response while the
    // browser was committing the virtualized list.  Keep the current Chinese
    // nodes and the ready bridge; removing them here collapses/restores
    // thousands of pixels and makes the native current-cue follower visibly
    // reverse the scroll position.
    panelState.layout = "ready";
    panelState.layoutNeedsSync = true;
    state.diagnostics.layoutCapability = CAPABILITY;
    state.diagnostics.layoutBridgeFailures += 1;
    state.diagnostics.lastLayoutFailure = String(result?.error || "transient bridge failure");
    scheduleLayoutRetry(panelState);
    publishDiagnostics(true);
  }

  function onBridgeMessage(event) {
    if (!event || event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE_SOURCE || data.version !== VERSION || typeof data.requestId !== "string") return;
    const pending = state.pendingRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingRequests.delete(data.requestId);
    pending.resolve(data);
  }

  function markLayoutFailure(panelState, reason) {
    const wasReady = panelState?.layout === "ready";
    if (wasReady) {
      // A timeout does not prove that MAIN world failed to apply the message;
      // it may have applied the layout and lost only the response.  Restore
      // before entering unsupported so no stale extra heights survive.
      panelState.layout = "ready";
      removePanelDecorations(panelState, true);
    }
    panelState.layout = "unsupported";
    state.diagnostics.layoutCapability = "unsupported";
    state.diagnostics.layoutBridgeFailures += 1;
    state.diagnostics.lastLayoutFailure = String(reason || "unsupported");
    warnOnce(`layout:${state.diagnostics.lastLayoutFailure}`, `Transcript layout bridge unavailable: ${state.diagnostics.lastLayoutFailure}`);
    publishDiagnostics(true);
  }

  function warnOnce(key, message) {
    if (state.warnedReasons.has(key)) return;
    state.warnedReasons.add(key);
    try { console.warn("[echo360-translator]", message); } catch (_) {}
  }

  async function ensureLayoutCapability(panelState) {
    if (!panelState.descriptor.virtualized) {
      panelState.layout = "static";
      panelState.visibleRowCount = Number(panelState.modelRowCount || 0);
      return true;
    }
    if (panelState.layout === "ready") return true;
    if (panelState.layout === "unsupported") return false;
    if (panelState.capabilityPromise) return panelState.capabilityPromise;
    panelState.layout = "pending";
    panelState.capabilityPromise = postBridgeWithRetry(
      "capabilities",
      panelState,
      { revision: 0 },
      bridgeTimeoutFor("capabilities"),
      bridgeAttemptsFor("capabilities"),
    )
      .then((result) => {
        panelState.capabilityPromise = null;
        if (result?.ok && result.capability === CAPABILITY) {
          panelState.layout = "ready";
          panelState.revision = Number(result.appliedRevision || 0);
          const visible = Number(result.visibleRowCount);
          const modelCount = Number(panelState.modelRowCount || 0);
          if (!Number.isInteger(visible) || visible < 0 || visible > modelCount) {
            markLayoutFailure(panelState, "invalid visible row count");
            return false;
          }
          panelState.visibleRowCount = visible;
          state.diagnostics.layoutCapability = CAPABILITY;
          return true;
        }
        markLayoutFailure(panelState, result?.error || "capability handshake failed");
        return false;
      });
    return panelState.capabilityPromise;
  }

  function removeOwnNodes(candidate) {
    if (!candidate) return;
    state.ownMutationDepth += 1;
    try {
      candidate.querySelectorAll?.(`[${ATTR}="1"]`).forEach((node) => node.remove());
    } finally {
      state.ownMutationDepth -= 1;
    }
  }

  function setRowDecorated(row, decorated) {
    if (!row) return;
    if (decorated) row.setAttribute(ROW_ATTR, "1");
    else row.removeAttribute(ROW_ATTR);
  }

  function translationCandidate(translation) {
    return translation?.closest?.('[data-test-component="Content"]') || translation?.parentElement || null;
  }

  function setPanelLayoutPending(panelState) {
    if (!panelState?.descriptor?.virtualized || !panelState.root?.isConnected) return;
    panelState.layoutPending = true;
    panelState.layoutNeedsSync = true;
    state.ownMutationDepth += 1;
    try {
      panelState.root.querySelectorAll?.(`[${ATTR}="1"]`).forEach((translation) => {
        translation.setAttribute(LAYOUT_PENDING_ATTR, "1");
        const candidate = translationCandidate(translation);
        setRowDecorated(adapter().findRowWrapper(candidate, panelState.root), false);
      });
    } finally {
      state.ownMutationDepth -= 1;
    }
  }

  function hasPendingTranslations(panelState) {
    return !!panelState?.root?.querySelector?.(`[${ATTR}="1"][${LAYOUT_PENDING_ATTR}="1"]`);
  }

  function setPanelLayoutReady(panelState) {
    if (!panelState?.descriptor?.virtualized || !panelState.root?.isConnected) return;
    panelState.layoutPending = false;
    state.ownMutationDepth += 1;
    try {
      panelState.root.querySelectorAll?.(`[${ATTR}="1"]`).forEach((translation) => {
        const candidate = translationCandidate(translation);
        translation.removeAttribute(LAYOUT_PENDING_ATTR);
        setRowDecorated(adapter().findRowWrapper(candidate, panelState.root), true);
      });
    } finally {
      state.ownMutationDepth -= 1;
    }
  }

  function hasLayoutOverlap(panelState) {
    if (!panelState?.root?.isConnected) return true;
    const rows = [];
    const allRows = [];
    for (const candidate of adapter().findCueCandidates(panelState.root)) {
      const row = adapter().findRowWrapper(candidate, panelState.root);
      if (row && !allRows.some((item) => item.row === row)) allRows.push({ candidate, row });
      const translation = candidate.querySelector?.(`[${ATTR}="1"]`);
      if (!translation || translation.hasAttribute(LAYOUT_PENDING_ATTR)) continue;
      if (row) rows.push({ candidate, row, translation });
    }
    for (const current of rows) {
      const rowIndex = allRows.findIndex((item) => item.row === current.row);
      const next = rowIndex >= 0 ? allRows[rowIndex + 1] : null;
      let rowRect;
      let translationRect;
      try {
        rowRect = current.row.getBoundingClientRect?.();
        translationRect = current.translation.getBoundingClientRect?.();
      } catch (_) {
        continue;
      }
      if (!rowRect || !translationRect) continue;
      if (Number.isFinite(Number(translationRect.bottom)) &&
          Number.isFinite(Number(rowRect.bottom)) &&
          translationRect.bottom > rowRect.bottom + LAYOUT_OVERLAP_TOLERANCE_PX) return true;
      if (!next) continue;
      let nextRect;
      try { nextRect = next.row.getBoundingClientRect?.(); } catch (_) { nextRect = null; }
      if (nextRect && Number.isFinite(Number(nextRect.top)) &&
          Number.isFinite(Number(rowRect.bottom)) &&
          rowRect.bottom > nextRect.top + LAYOUT_OVERLAP_TOLERANCE_PX) return true;
    }
    return false;
  }

  function hasMeasurableVirtualizedRows(panelState) {
    for (const candidate of adapter().findCueCandidates(panelState?.root)) {
      const row = adapter().findRowWrapper(candidate, panelState.root);
      if (!row) continue;
      if (String(row.style?.height || "").trim()) return true;
      try {
        const rect = row.getBoundingClientRect?.();
        if (rect && (rect.width || rect.height || rect.top || rect.bottom)) return true;
      } catch (_) {}
    }
    return false;
  }

  function nextLayoutProbeFrame() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 16);
    });
  }

  async function revealLayoutWhenSafe(panelState) {
    if (!panelState?.descriptor?.virtualized) return true;
    // Unit-test DOMs (and a document-start page before React has assigned any
    // row geometry) expose zero-sized rectangles and no inline row height.  A
    // geometry probe cannot provide useful evidence there; keep the protocol
    // deterministic and let the real browser perform the guarded probe once
    // React has mounted measurable rows.
    if (!hasMeasurableVirtualizedRows(panelState)) {
      setPanelLayoutReady(panelState);
      return true;
    }
    for (let attempt = 0; attempt < LAYOUT_PROBE_ATTEMPTS; attempt += 1) {
      // React Virtualized updates its absolute row styles asynchronously after
      // recomputeRowHeights(). Probe only after a paint opportunity, then keep
      // the layout marker pending if the current geometry still overlaps a
      // following native row. The Chinese node remains visible throughout;
      // the bridge/retry path must correct the row offsets rather than mask
      // the problem by removing the translation from the screen.
      await nextLayoutProbeFrame();
      if (!panelState.root?.isConnected) return false;
      setPanelLayoutReady(panelState);
      if (!hasLayoutOverlap(panelState)) return true;
      setPanelLayoutPending(panelState);
    }
    return false;
  }

  function resolveCue(candidate, candidates, used, lastIndex, duplicateCounter) {
    const text = modelApi().normalizeSearchText(adapter().extractCueText(candidate));
    if (!text) return null;
    const indexed = state.model.searchIndex?.original?.get(text) || state.model.cues.filter((cue) => cue.normalizedOriginal === text);
    const exact = indexed.filter((cue) => !used.has(cue.index));
    if (exact.length === 0) return null;
    if (exact.length === 1) return exact[0];
    const approx = adapter().extractCueApproxStartMs(candidate);
    const timed = approx == null ? [] : exact.filter((cue) => Math.abs(cue.startMs - approx) <= 1500);
    if (timed.length === 1) {
      duplicateCounter.count += 1;
      return timed[0];
    }
    const ordered = exact.filter((cue) => cue.index > lastIndex);
    if (ordered.length === 1) {
      duplicateCounter.count += 1;
      return ordered[0];
    }
    // A duplicate text without a unique time/order anchor is intentionally
    // left untouched rather than risking a translation from another cue.
    return null;
  }

  function measureTranslationExtraPx(candidate, translation) {
    const text = String(translation?.textContent || "");
    let width = 320;
    try {
      width = Number(candidate?.getBoundingClientRect?.().width || 320);
    } catch (_) {}
    const lines = estimateTextLineCount(text, width);
    let height = 0;
    try {
      height = Number(translation?.scrollHeight || translation?.getBoundingClientRect?.().height || 0);
    } catch (_) {}
    const estimated = lines * 22;
    if (!(height > 0)) height = estimated;
    // Include margin-top while keeping the protocol's per-row bound.
    // The pending node can report a stale one-line measurement in
    // Safari when CJK glyphs wrap at the exact content width.  Keep the
    // conservative line estimate as a lower bound so MAIN never receives a
    // height smaller than the text that will actually be revealed.
    return Math.max(1, Math.min(400, Math.ceil(Math.max(height, estimated) + LAYOUT_EXTRA_MARGIN_PX)));
  }

  function estimateTextLineCount(text, widthPx = 320) {
    const value = String(text || "");
    const width = Math.max(40, Number(widthPx) || 320);
    // CJK/Hangul glyphs are approximately one full em wide, while Latin
    // transcripts average close to half an em.  Using the Latin-only `/8`
    // heuristic for Chinese underestimates a 20–30 character cue by one whole
    // line; the bridge then leaves the native row at its English height and
    // the overlap gate correctly keeps every translation in the pending state.
    const hasWideGlyph = /[\u2e80-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(value);
    const charsPerLine = Math.max(1, Math.floor(width / (hasWideGlyph ? 14 : 8)));
    return Math.max(1, value.split("\n").reduce((sum, part) =>
      sum + Math.max(1, Math.ceil(part.length / charsPerLine)), 0));
  }

  function estimateTextExtraPx(text, widthPx = 320) {
    const lines = estimateTextLineCount(text, widthPx);
    return Math.max(1, Math.min(400, lines * 22 + LAYOUT_EXTRA_MARGIN_PX));
  }

  function measureAllModelExtras(panelState, candidates, visibleExtras) {
    const extras = new Map(visibleExtras);
    if (!state.model?.cues) return [...extras.entries()];
    const modelCount = state.model.cues.length;
    const visibleCount = Math.max(0, Math.min(modelCount, Number.isInteger(panelState.visibleRowCount)
      ? panelState.visibleRowCount : modelCount));
    const reference = candidates[0]?.querySelector?.(`[${ATTR}="1"]`);
    let width = 320;
    try {
      width = Number(candidates[0]?.getBoundingClientRect?.().width || panelState.root.getBoundingClientRect?.().width || 320);
    } catch (_) {}
    width = Math.max(40, Math.round(Number.isFinite(width) && width > 0 ? width : 320));
    const modelRevision = state.model.translationRevision ?? state.model.revision ?? "";
    const cache = panelState.layoutCache;
    if (!cache || cache.model !== state.model || cache.modelRevision !== modelRevision || cache.width !== width) {
      panelState.layoutCache = {
        model: state.model,
        modelRevision,
        width,
        measuredCount: 0,
        extras: new Map(),
      };
    }
    const measured = panelState.layoutCache;
    for (const [index, extra] of visibleExtras) {
      if (index < visibleCount) measured.extras.set(index, Math.max(0, Math.min(400, Math.round(extra))));
    }
    // A hidden measurement node lets real browsers account for the current
    // panel width/font while the fallback estimate keeps jsdom and early
    // document-start layout deterministic.
    let measurement = null;
    if (measured.measuredCount < visibleCount) {
      state.ownMutationDepth += 1;
      try {
        measurement = document.createElement("span");
        measurement.setAttribute(ATTR, "1");
        measurement.style.cssText = `position:absolute;visibility:hidden;display:block;width:${width}px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;`;
        if (reference) {
          const computed = window.getComputedStyle?.(reference);
          if (computed?.font) measurement.style.font = computed.font;
        }
        panelState.root.appendChild(measurement);
      } catch (_) {
        measurement = null;
      } finally {
        state.ownMutationDepth -= 1;
      }
    }
    // Measure only the model prefix that MAIN currently exposes.  Once a
    // prefix has been measured, repeated React commits reuse it; a later gate
    // expansion measures only the newly visible suffix.
    for (let index = measured.measuredCount; index < visibleCount; index += 1) {
      const cue = state.model.cues[index];
      if (cue.status === "unmapped" || !cue.translatedText) continue;
      let extra = 0;
      if (measurement) {
        measurement.textContent = cue.translatedText;
        extra = Number(measurement.scrollHeight || measurement.getBoundingClientRect?.().height || 0);
      }
      const estimate = estimateTextExtraPx(cue.translatedText, width);
      // Prefer the real hidden measurement when it is larger, but never let a
      // browser's one-line CJK measurement undercut the conservative glyph
      // estimate.  A small overestimate leaves whitespace; an underestimate
      // causes the layout gate to keep Chinese pending indefinitely.
      const measuredExtra = extra > 0 ? Math.min(400, Math.ceil(extra + LAYOUT_EXTRA_MARGIN_PX)) : 0;
      measured.extras.set(cue.index, Math.max(estimate, measuredExtra));
    }
    measured.measuredCount = Math.max(measured.measuredCount, visibleCount);
    if (measurement) {
      state.ownMutationDepth += 1;
      try { measurement.remove(); } finally { state.ownMutationDepth -= 1; }
    }
    for (const [index, extra] of measured.extras) {
      if (index < visibleCount) extras.set(index, extra);
    }
    return [...extras.entries()];
  }

  function syncTranslationClickProxy(translation, candidate) {
    if (!translation) return;
    const target = adapter().findClickableCue?.(candidate) || candidate;
    const previous = translation.__echo360ClickProxy;
    if (previous?.target === target) return;
    if (previous?.listener) {
      try { translation.removeEventListener("click", previous.listener); } catch (_) {}
    }
    translation.__echo360ClickProxy = null;
    // In the verified new-player DOM, the full English cue is a React-owned
    // span.  Keep Chinese outside that span and proxy only the Chinese click
    // to the native target.  Split search highlights fall back to Content;
    // bubbling then follows Echo's original delegated handler naturally.
    if (!target || target === candidate || typeof translation.addEventListener !== "function") return;
    const listener = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      try {
        if (typeof target.click === "function") target.click();
        else target.dispatchEvent?.(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch (_) {}
    };
    translation.addEventListener("click", listener);
    translation.__echo360ClickProxy = { target, listener };
  }

  function createOrUpdateTranslation(candidate, cue, panelState, layoutExtras) {
    const existing = Array.from(candidate.querySelectorAll(`[${ATTR}="1"]`));
    const translation = existing[0] || document.createElement("span");
    const mount = adapter().findTranslationMount(candidate) || candidate;
    const wasMounted = translation.isConnected && translation.parentElement === mount;
    state.ownMutationDepth += 1;
    try {
      for (const duplicate of existing.slice(1)) duplicate.remove();
      translation.setAttribute(ATTR, "1");
      translation.setAttribute("data-echo360-cue-key", cue.key);
      translation.setAttribute("data-echo360-translated-text", cue.translatedText || "");
      translation.setAttribute("lang", LANG_BY_TARGET[state.model.target] || String(state.model.target || "").toLowerCase() || "und");
      translation.setAttribute("dir", "auto");
      if (translation.textContent !== cue.translatedText) translation.textContent = cue.translatedText || "";
      if (!translation.isConnected || translation.parentElement !== mount) mount.appendChild(translation);
      syncTranslationClickProxy(translation, candidate);
      const row = adapter().findRowWrapper(candidate, panelState.root);
      if (panelState.descriptor.virtualized &&
          (panelState.layout !== "ready" || panelState.layoutPending || !wasMounted ||
            !Array.isArray(panelState.lastExtras) || translation.hasAttribute(LAYOUT_PENDING_ATTR))) {
        translation.setAttribute(LAYOUT_PENDING_ATTR, "1");
        setRowDecorated(row, false);
      } else {
        translation.removeAttribute(LAYOUT_PENDING_ATTR);
        setRowDecorated(row, panelState.descriptor.virtualized);
      }
      if (row && panelState.descriptor.virtualized) layoutExtras.push([cue.index, measureTranslationExtraPx(candidate, translation)]);
    } finally {
      state.ownMutationDepth -= 1;
    }
    return translation;
  }

  async function applyLayout(panelState, extras) {
    if (!panelState.descriptor.virtualized || panelState.layout !== "ready") return true;
    const normalized = [];
    const seen = new Set();
    for (const [index, extra] of extras) {
      if (seen.has(index)) continue;
      seen.add(index);
      normalized.push([index, Math.max(0, Math.min(400, Math.round(extra))) ]);
    }
    normalized.sort((a, b) => a[0] - b[0]);
    const sameExtras = Array.isArray(panelState.lastExtras) && panelState.lastExtras.length === normalized.length &&
      panelState.lastExtras.every(([index, extra], position) => normalized[position][0] === index && normalized[position][1] === extra);
    // ResizeObserver can report the same stable translation height on every
    // native cue update.  Re-sending an identical 1,395-row layout makes the
    // bridge compete with playback for the main thread and needlessly creates
    // timeout windows.  Host replacement and a transient failure set
    // layoutNeedsSync so those cases still perform a real handshake.
    const recentlySynced = Number.isFinite(Number(panelState.layoutLastSyncedAt)) &&
      performance.now() - Number(panelState.layoutLastSyncedAt) < LAYOUT_REVALIDATE_MS;
    if (sameExtras && panelState.layout === "ready" && !panelState.layoutNeedsSync && recentlySynced &&
        !hasPendingTranslations(panelState)) return true;
    if (!sameExtras) {
      panelState.revision += 1;
      panelState.lastExtras = normalized.map((pair) => [...pair]);
    }
    // Capture the revision belonging to this request.  A restore, model
    // update, or a coalesced follow-up pass may advance panelState.revision
    // while the bridge is awaiting React's response.  That makes the response
    // stale, not erroneous; it must never enter the fail-closed path and erase
    // the translations that the newer pass is about to reconcile.
    const requestRevision = panelState.revision;
    const result = await postBridgeWithRetry("set-layout", panelState, {
      revision: requestRevision,
      extras: normalized,
    }, bridgeTimeoutFor("set-layout"), bridgeAttemptsFor("set-layout"));
    if (panelState.revision !== requestRevision) {
      if (result?.ok && result.capability === CAPABILITY && Number(result.appliedRevision) === requestRevision) {
        scheduleFlush();
      }
      return false;
    }
    if (!result?.ok || result.capability !== CAPABILITY || Number(result.appliedRevision) !== requestRevision) {
      if (isRetryableBridgeResult(result) && panelState.layout === "ready") {
        preserveTransientLayoutFailure(panelState, result);
        return false;
      }
      const reason = result?.error || (result?.transient ? "set-layout transient failure" :
        result && result.ok === false ? "set-layout rejected without error" : "set-layout timeout");
      markLayoutFailure(panelState, reason);
      removePanelDecorations(panelState, false);
      return false;
    }
    const visible = Number(result.visibleRowCount);
    const modelCount = Number(panelState.modelRowCount || 0);
    if (!Number.isInteger(visible) || visible < 0 || visible > modelCount) {
      markLayoutFailure(panelState, "invalid visible row count");
      removePanelDecorations(panelState, false);
      return false;
    }
    const visibleChanged = panelState.visibleRowCount !== visible;
    panelState.visibleRowCount = visible;
    panelState.layoutLastSyncedAt = performance.now();
    state.diagnostics.lastLayoutFailure = null;
    state.diagnostics.layoutRevision = requestRevision;
    state.diagnostics.layoutExtraRowCount = normalized.length;
    if (visibleChanged) scheduleFlush();
    const safe = await revealLayoutWhenSafe(panelState);
    if (!safe) {
      panelState.layoutNeedsSync = true;
      scheduleLayoutRetry(panelState);
      return false;
    }
    if (panelState.revision !== requestRevision) {
      // A newer observer/model pass may have advanced the revision while this
      // response was in flight.  The geometry probe has already established
      // that the currently revealed rows are safe, so keep them visible and
      // let the coalesced pass reconcile the newer revision.  Leaving the
      // nodes pending here creates a permanent pending/retry loop under React
      // Virtualized, where commits routinely arrive during the probe.
      panelState.layoutNeedsSync = true;
      scheduleFlush();
      return true;
    }
    panelState.layoutNeedsSync = false;
    clearLayoutRetry(panelState);
    return true;
  }

  function removePanelDecorations(panelState, restoreLayout = true) {
    state.ownMutationDepth += 1;
    try {
      panelState.root.querySelectorAll?.(`[${ATTR}="1"]`).forEach((node) => node.remove());
      panelState.root.querySelectorAll?.(`[${ROW_ATTR}="1"]`).forEach((node) => node.removeAttribute(ROW_ATTR));
      panelState.root.querySelectorAll?.(`[${LAYOUT_PENDING_ATTR}="1"]`).forEach((node) => node.removeAttribute(LAYOUT_PENDING_ATTR));
    } finally {
      state.ownMutationDepth -= 1;
    }
    panelState.layoutPending = false;
    if (restoreLayout && !panelState.restorePromise && panelState.root.isConnected && panelState.descriptor.virtualized && panelState.layout === "ready") {
      panelState.revision += 1;
      panelState.restorePromise = postBridgeWithRetry(
        "restore-layout",
        panelState,
        { revision: panelState.revision },
        bridgeTimeoutFor("restore-layout"),
        bridgeAttemptsFor("restore-layout"),
      ).then((result) => {
        if (!result?.ok) {
          if (isRetryableBridgeResult(result) && panelState.layout === "ready") {
            // Keep the ready state until a delayed restore has a chance to
            // complete; a lost response alone is not evidence that MAIN is
            // unavailable.
            scheduleLayoutRetry(panelState);
          } else {
            markLayoutFailure(panelState, result?.error || "restore-layout failed");
          }
        } else if (panelState.layout !== "unsupported") {
          panelState.layout = "restored";
          clearLayoutRetry(panelState);
        }
        panelState.restorePromise = null;
      });
    }
  }

  async function flushPanel(panelState) {
    if (!state.enabled || !state.model || !panelState.root.isConnected) return;
    if (panelState.restorePromise) await panelState.restorePromise;
    if (!(await ensureLayoutCapability(panelState))) {
      removePanelDecorations(panelState, false);
      return;
    }
    const started = performance.now();
    const candidates = adapter().findCueCandidates(panelState.root);
    state.diagnostics.discoveredCueRows += candidates.length;
    const used = new Set();
    const extras = [];
    const duplicateCounter = { count: 0 };
    let lastIndex = -1;
    let decorated = 0;
    let considered = 0;
    let unmapped = 0;
    for (const candidate of candidates) {
      const cue = resolveCue(candidate, candidates, used, lastIndex, duplicateCounter);
      if (!cue) {
        unmapped += 1;
        removeOwnNodes(candidate);
        setRowDecorated(adapter().findRowWrapper(candidate, panelState.root), false);
        continue;
      }
      used.add(cue.index);
      lastIndex = Math.max(lastIndex, cue.index);
      if (panelState.descriptor.virtualized && cue.index >= panelState.visibleRowCount) {
        // Interactive Media can expose a gated prefix of the complete model.
        // Never decorate, measure, or otherwise reveal rows outside that
        // prefix even if a stale DOM row briefly remains mounted.
        removeOwnNodes(candidate);
        setRowDecorated(adapter().findRowWrapper(candidate, panelState.root), false);
        continue;
      }
      considered += 1;
      if (cue.status === "unmapped" || !cue.translatedText) {
        unmapped += 1;
        removeOwnNodes(candidate);
        setRowDecorated(adapter().findRowWrapper(candidate, panelState.root), false);
        continue;
      }
      createOrUpdateTranslation(candidate, cue, panelState, extras);
      decorated += 1;
    }
    // A low-confidence batch is safer to leave untouched than to decorate with
    // a guessed cue mapping.  Exact, uniquely resolved rows are still retained
    // for tiny/partially rendered windows; larger windows must clear as one
    // transaction when the confidence threshold is missed.
    if (considered >= 3 && decorated / considered < 0.8) {
      removePanelDecorations(panelState, true);
      state.diagnostics.unmappedCueRows += considered - decorated;
      state.diagnostics.lastLayoutFailure = "cue mapping confidence below 80%";
      warnOnce("low-confidence", state.diagnostics.lastLayoutFailure);
      return;
    }
    if (panelState.descriptor.virtualized) {
      const ok = await applyLayout(panelState, measureAllModelExtras(panelState, candidates, extras));
      if (!ok) return;
    }
    state.diagnostics.decoratedCueRows += decorated;
    state.diagnostics.unmappedCueRows += unmapped;
    state.diagnostics.duplicateTextResolutions += duplicateCounter.count;
    const elapsed = performance.now() - started;
    state.diagnostics.lastFlushDurationMs = Number(elapsed.toFixed(2));
    state.diagnostics.maxFlushDurationMs = Math.max(state.diagnostics.maxFlushDurationMs, elapsed);
  }

  function syncPanels() {
    const panelSelector = adapter().PANEL_SELECTOR || '#transcripts-panel[role="tabpanel"]';
    const listSelector = adapter().LIST_SELECTOR || '.transcript-list[role="grid"]';
    const searchSelector = adapter().SEARCH_SELECTOR || '#search-transcripts_input';
    try {
      state.diagnostics.rawPanelCount = document.querySelectorAll(panelSelector).length;
      state.diagnostics.rawListCount = document.querySelectorAll(listSelector).length;
      state.diagnostics.rawSearchInputCount = document.querySelectorAll(searchSelector).length;
    } catch (_) {
      state.diagnostics.rawPanelCount = 0;
      state.diagnostics.rawListCount = 0;
      state.diagnostics.rawSearchInputCount = 0;
    }
    let roots = adapter().findPanelRoots(document);
    if (roots.length > 1) {
      // No verified media-to-panel discriminator exists in new-player-v1.
      // Decorating multiple candidates would risk cross-media translation, so
      // keep every native panel untouched until a future adapter can identify
      // the active one.
      roots = [];
      state.diagnostics.lastLayoutFailure = "multiple indistinguishable transcript panels";
      warnOnce("multiple-panels", state.diagnostics.lastLayoutFailure);
    }
    const nextRoots = new Set(roots);
    for (const root of state.panelRoots) {
      if (nextRoots.has(root)) continue;
      const observer = state.panelObservers.get(root);
      observer?.disconnect?.();
      state.panelObservers.delete(root);
      const panelState = state.panelStates.get(root);
      if (panelState) {
        clearLayoutRetry(panelState);
        panelState.resizeObserver?.disconnect?.();
        removePanelDecorations(panelState, true);
      }
      state.panelStates.delete(root);
    }
    for (const root of roots) {
      let panelState = state.panelStates.get(root);
      if (!panelState) {
        const descriptor = adapter().getPanelDescriptor(root);
        panelState = {
          root,
          descriptor,
          token: nextId("panel"),
          modelRowCount: state.model?.cues?.length || 0,
          rowCount: state.model?.cues?.length || 0,
          visibleRowCount: descriptor.virtualized ? null : state.model?.cues?.length || 0,
          layout: descriptor.virtualized ? "unknown" : "static",
          capabilityPromise: null,
          restorePromise: null,
          revision: 0,
          lastExtras: null,
          layoutCache: null,
          layoutNeedsSync: false,
          layoutPending: false,
          layoutLastSyncedAt: 0,
          layoutRetryTimer: null,
          layoutRetryCount: 0,
          lastObservedWidth: null,
        };
        root.setAttribute("data-echo360-transcript-panel-token", panelState.token);
        const observer = new MutationObserver((records) => {
          if (state.ownMutationDepth > 0 || isExtensionOnlyMutation(records)) return;
          const removedOwnNode = records.some((record) => [...(record.removedNodes || [])].some((node) =>
            node.nodeType === 1 && (node.matches?.(`[${ATTR}="1"]`) ||
              node.querySelector?.(`[${ATTR}="1"]`))));
          if (removedOwnNode) panelState.layoutNeedsSync = true;
          // A native React commit does not by itself make the current rows
          // unsafe.  Only enter the layout-settle gate when measured geometry
          // actually overlaps; marking every child-list mutation pending was
          // the source of the intermittent pending/retry loop.
          if (panelState.descriptor.virtualized && hasLayoutOverlap(panelState)) {
            setPanelLayoutPending(panelState);
          }
          scheduleFlush();
        });
        observer.observe(root, { childList: true, subtree: true });
        const resizeObserver = typeof ResizeObserver !== "undefined"
          ? new ResizeObserver((entries) => {
            const width = Number(entries?.[0]?.contentRect?.width);
            const widthChanged = Number.isFinite(width) && width > 0 &&
              (panelState.lastObservedWidth == null || Math.abs(width - panelState.lastObservedWidth) > 0.5);
            if (widthChanged) {
              panelState.lastObservedWidth = width;
              setPanelLayoutPending(panelState);
            }
            scheduleFlush();
          })
          : null;
        resizeObserver?.observe?.(root);
        panelState.resizeObserver = resizeObserver;
        state.panelObservers.set(root, observer);
        state.panelStates.set(root, panelState);
      } else {
        const previousListHost = panelState.descriptor?.listHost;
        panelState.descriptor = adapter().getPanelDescriptor(root);
        const nextRowCount = state.model?.cues?.length || 0;
        if (previousListHost && previousListHost !== panelState.descriptor?.listHost) {
          clearLayoutRetry(panelState);
          panelState.layout = panelState.descriptor.virtualized ? "unknown" : "static";
          panelState.revision = 0;
          panelState.lastExtras = null;
          panelState.layoutCache = null;
          panelState.layoutNeedsSync = true;
          panelState.layoutLastSyncedAt = 0;
          panelState.visibleRowCount = panelState.descriptor.virtualized ? null : nextRowCount;
          setPanelLayoutPending(panelState);
        }
        if (nextRowCount !== panelState.modelRowCount) {
          clearLayoutRetry(panelState);
          removePanelDecorations(panelState, true);
          panelState.layout = "unknown";
          panelState.revision = 0;
          panelState.lastExtras = null;
          panelState.layoutCache = null;
          panelState.layoutNeedsSync = true;
          panelState.layoutLastSyncedAt = 0;
          panelState.visibleRowCount = panelState.descriptor.virtualized ? null : nextRowCount;
          setPanelLayoutPending(panelState);
        }
        panelState.modelRowCount = nextRowCount;
        panelState.rowCount = nextRowCount;
      }
    }
    state.panelRoots = nextRoots;
    state.diagnostics.panelCount = roots.length;
    state.diagnostics.verifiedPanelCount = roots.length;
  }

  function syncSearchPanels() {
    const searchable = state.enabled && state.model
      ? [...state.panelStates.values()]
        .filter((panelState) => panelState.root.isConnected &&
          (panelState.layout === "static" || panelState.layout === "ready"))
        .map((panelState) => panelState.root)
      : [];
    ns.transcriptSearchBridge?.setPanels?.(searchable);
    for (const panelState of state.panelStates.values()) {
      if (!searchable.includes(panelState.root)) continue;
      ns.transcriptSearchBridge?.setPanelVisibleCount?.(panelState.root,
        panelState.descriptor.virtualized ? panelState.visibleRowCount : panelState.modelRowCount);
    }
  }

  async function flush() {
    // jsdom (and a page being torn down) can invalidate the document while a
    // previously scheduled observer frame is still queued.  Treat that as a
    // cancelled render rather than allowing the stale closure to touch the
    // detached global document.
    if (typeof document === "undefined" || !document.documentElement) return;
    if (state.flushInFlight) {
      state.flushPending = true;
      return state.flushInFlight;
    }
    state.flushHandle = null;
    state.flushScheduled = false;
    const run = Promise.resolve().then(async () => {
      if (!state.started) return;
      state.diagnostics.observerFlushCount += 1;
      state.diagnostics.discoveredCueRows = 0;
      state.diagnostics.decoratedCueRows = 0;
      state.diagnostics.unmappedCueRows = 0;
      state.diagnostics.duplicateTextResolutions = 0;
      syncPanels();
      syncSearchPanels();
      if (!state.enabled || !state.model) return;
      const panels = [...state.panelStates.values()];
      for (const panelState of panels) await flushPanel(panelState);
      syncSearchPanels();
      state.diagnostics.active = true;
      state.diagnostics.sessionKey = state.model.sessionKey;
      state.diagnostics.target = state.model.target;
      publishDiagnostics(true);
    });
    state.flushInFlight = run;
    try {
      return await run;
    } finally {
      if (state.flushInFlight === run) state.flushInFlight = null;
      if (state.flushPending) {
        state.flushPending = false;
        scheduleFlush();
      }
    }
  }

  function scheduleFlush() {
    if (!state.started) return;
    if (state.flushInFlight) {
      state.flushPending = true;
      return;
    }
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    const generation = ++state.flushGeneration;
    const run = () => {
      if (generation !== state.flushGeneration) return;
      state.flushHandle = null;
      void flush();
    };
    if (typeof requestAnimationFrame === "function") {
      state.flushHandle = requestAnimationFrame(run);
    } else {
      state.flushHandle = setTimeout(run, 0);
    }
  }

  function start() {
    if (state.started) return api;
    state.started = true;
    ensureStyle();
    window.addEventListener("message", onBridgeMessage, false);
    window.addEventListener("resize", scheduleFlush, false);
    state.documentObserver = new MutationObserver((records) => {
      if (state.ownMutationDepth > 0 || isExtensionOnlyMutation(records)) return;
      scheduleFlush();
    });
    state.documentObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    scheduleFlush();
    ns.transcriptSearchBridge?.start?.(api);
    return api;
  }

  function setTranslation(value) {
    const next = value?.cues ? value : modelApi()?.buildTranscriptModel?.(value || {}) || null;
    if (state.model?.sessionKey && next?.sessionKey && state.model.sessionKey !== next.sessionKey) {
      clearDecorationsOnly();
    }
    state.model = next;
    for (const panelState of state.panelStates.values()) {
      panelState.layoutCache = null;
      if (panelState.descriptor?.virtualized) setPanelLayoutPending(panelState);
      // Keep the revision when the measured extras are unchanged; MAIN will
      // acknowledge the same layout without recomputing every row.
    }
    state.diagnostics.modelCueCount = next?.cues?.length || 0;
    state.diagnostics.modelOriginalCueCount = Number(next?.stats?.originalCueCount || next?.cues?.length || 0);
    state.diagnostics.modelTranslatedCueCount = Number(next?.stats?.translatedCueCount || 0);
    state.diagnostics.modelMappedCueCount = Number(next?.stats?.mappedCueCount || 0);
    state.diagnostics.modelUnmappedCueCount = Number(next?.stats?.unmappedCueCount || 0);
    state.diagnostics.sessionKey = next?.sessionKey || null;
    state.diagnostics.target = next?.target || null;
    ns.transcriptSearchBridge?.setModel?.(next);
    publishDiagnostics(true);
    scheduleFlush();
    return next;
  }

  function clearDecorationsOnly() {
    for (const panelState of state.panelStates.values()) {
      removePanelDecorations(panelState, true);
      panelState.layoutCache = null;
      panelState.lastExtras = null;
    }
  }

  function setVisible(enabled) {
    state.enabled = enabled !== false;
    if (!state.enabled) {
      clearDecorationsOnly();
      state.diagnostics.active = false;
      ns.transcriptSearchBridge?.clear?.();
      publishDiagnostics(true);
    } else {
      ns.transcriptSearchBridge?.setModel?.(state.model);
      scheduleFlush();
    }
  }

  function clear() {
    clearDecorationsOnly();
    state.model = null;
    state.enabled = true;
    state.diagnostics.active = false;
    state.diagnostics.modelCueCount = 0;
    state.diagnostics.modelOriginalCueCount = 0;
    state.diagnostics.modelTranslatedCueCount = 0;
    state.diagnostics.modelMappedCueCount = 0;
    state.diagnostics.modelUnmappedCueCount = 0;
    ns.transcriptSearchBridge?.clear?.();
    publishDiagnostics(true);
  }

  async function scrollToCue(cue) {
    if (!cue) return false;
    for (const panelState of state.panelStates.values()) {
      if (panelState.descriptor.virtualized &&
          (!Number.isInteger(panelState.visibleRowCount) || cue.index >= panelState.visibleRowCount)) continue;
      const candidates = adapter().findCueCandidates(panelState.root);
      const candidate = candidates.find((item) => {
        const translation = item.querySelector(`[${ATTR}="1"]`);
        return translation?.getAttribute("data-echo360-cue-key") === cue.key;
      });
      if (candidate) {
        try { candidate.scrollIntoView?.({ block: "center" }); } catch (_) {}
        return true;
      }
      if (panelState.descriptor.virtualized && panelState.layout === "ready") {
        const result = await postBridge("scroll-to-row", panelState, { rowIndex: cue.index });
        if (result?.ok) {
          // react-virtualized renders the requested row asynchronously.  Give
          // React up to three frames to commit it, then use the real DOM node
          // rather than estimating scrollTop from cue index.
          for (let frame = 0; frame < 3; frame += 1) {
            await new Promise((resolve) => {
              if (typeof requestAnimationFrame === "function") requestAnimationFrame(resolve);
              else setTimeout(resolve, 0);
            });
            scheduleFlush();
            const rendered = adapter().findCueCandidates(panelState.root).find((item) => {
              const translation = item.querySelector(`[${ATTR}="1"]`);
              return translation?.getAttribute("data-echo360-cue-key") === cue.key;
            });
            if (rendered) {
              try { rendered.scrollIntoView?.({ block: "center" }); } catch (_) {}
              return true;
            }
          }
          state.diagnostics.virtualizedTargetMisses += 1;
          // A successful bridge call only means that react-virtualized
          // accepted the request.  A slow React commit or observer turn is a
          // recoverable DOM miss, not evidence that layout must be disabled.
          return false;
        }
        state.diagnostics.virtualizedTargetMisses += 1;
        markLayoutFailure(panelState, result?.error || "scroll-to-row failed");
      }
    }
    return false;
  }

  function getDebugState() {
    const search = ns.transcriptSearchBridge?.getDebugState?.() || {};
    return {
      ...state.diagnostics,
      ...search,
      panelStates: panelDiagnosticSnapshot(),
      virtualizedTargetMisses: state.diagnostics.virtualizedTargetMisses + Number(search.virtualizedTargetMisses || 0),
      panelCount: state.panelRoots.size,
    };
  }

  const api = {
    start,
    setTranslation,
    setVisible,
    clear,
    scrollToCue,
    getDebugState,
    flush,
    _measureAllModelExtras: measureAllModelExtras,
    _state: state,
  };
  ns.transcriptPanelRenderer = api;
})();
