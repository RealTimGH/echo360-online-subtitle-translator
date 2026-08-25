(() => {
  if (window.__echo360Probe && window.__echo360Probe.installed) return;

  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
  const records = [];
  const CAPTURE_NETWORK_DETAILS = false;

  const interestingUrl = (url) =>
    /echo360|captions|caption|subtitle|webvtt|m3u8|mpd|manifest|playlist|interactive-media|transcode|hls|dash|segment|chunk|media/i
      .test(String(url || ""));

  const addUuids = (value, out) => {
    const matches = String(value || "").match(uuidRe) || [];
    matches.forEach((id) => out.add(id.toLowerCase()));
  };

  const collectObjectUuids = (value, out, depth = 0, seen = new WeakSet()) => {
    if (out.size > 120 || depth > 5 || value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      addUuids(value, out);
      return;
    }
    if (typeof value !== "object" && typeof value !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);

    let keys = [];
    try {
      keys = Reflect.ownKeys(value).slice(0, 120);
    } catch (_) {
      return;
    }
    for (const key of keys) {
      addUuids(key, out);
      let next;
      try {
        next = value[key];
      } catch (_) {
        continue;
      }
      collectObjectUuids(next, out, depth + 1, seen);
    }
  };

  const reactHints = (el) => {
    const out = new Set();
    let node = el;
    let depth = 0;
    while (node && depth < 6) {
      let keys = [];
      try {
        keys = Reflect.ownKeys(node);
      } catch (_) {
        keys = [];
      }
      for (const key of keys) {
        const name = String(key);
        if (!/(react|fiber|props|state|echo|media|player)/i.test(name)) continue;
        try {
          collectObjectUuids(node[key], out);
        } catch (_) {}
      }
      node = node.parentElement;
      depth += 1;
    }
    return [...out];
  };

  const push = (record) => {
    const item = { time: Date.now(), ...record };
    records.push(item);
    if (records.length > 500) records.splice(0, records.length - 500);
    window.postMessage({ source: "echo360-translator-probe", record: item }, "*");
  };

  window.__echo360Probe = {
    installed: true,
    records,
    clear() {
      records.length = 0;
    },
    dump(kind) {
      return kind ? records.filter((r) => r.kind === kind) : records.slice();
    },
    resources() {
      return performance.getEntriesByType("resource")
        .map((e) => e.name)
        .filter((name) => interestingUrl(name));
    },
    videos(options) {
      // reactHints() walks each ancestor's own keys and recursively descends
      // into anything that looks like React/Angular internal state (fiber
      // trees, props, etc.) looking for UUIDs. That is only ever useful as a
      // last-resort hint when matching a video to a media id (video.js does
      // the same walk directly, on demand, when actually resolving a
      // translate source) - it's not something that needs to be fresh on a
      // recurring timer. Skip it by default so the interval below (which
      // runs on every page, translating or not) stays cheap; callers that
      // truly need it can opt in explicitly.
      const deep = !!(options && options.deep);
      return [...document.querySelectorAll("video")].map((v, i) => {
        const rect = v.getBoundingClientRect();
        const ids = new Set();
        addUuids(v.currentSrc, ids);
        addUuids(v.src, ids);
        [...v.attributes].forEach((a) => addUuids(a.value, ids));
        if (deep) reactHints(v).forEach((id) => ids.add(id));
        return {
          i,
          currentTime: Number(v.currentTime || 0).toFixed(2),
          duration: Number(v.duration || 0).toFixed(2),
          paused: v.paused,
          ended: v.ended,
          readyState: v.readyState,
          area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
          visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
          currentSrc: v.currentSrc || "",
          src: v.src || "",
          uuidHints: [...ids],
        };
      });
    },
    summary() {
      return {
        videos: this.videos(),
        resources: this.resources(),
        recentNetwork: records.filter((r) => r.kind === "fetch" || r.kind === "xhr").slice(-30),
        mediaEvents: records.filter((r) => r.kind === "media-event").slice(-30),
      };
    },
  };

  const postVideoSnapshot = () => {
    const videos = window.__echo360Probe.videos();
    if (videos.length > 0) push({ kind: "video-snapshot", videos });
  };
  window.__echo360Probe.snapshot = postVideoSnapshot;
  setTimeout(postVideoSnapshot, 0);
  setInterval(postVideoSnapshot, 1500);

  const originalFetch = window.fetch;
  if (CAPTURE_NETWORK_DETAILS && originalFetch && !originalFetch.__echo360ProbePatched) {
    const patchedFetch = async function(input, init) {
      const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      const started = performance.now();
      try {
        const resp = await originalFetch.apply(this, arguments);
        const url = resp.url || rawUrl;
        if (interestingUrl(url)) {
          const contentType = resp.headers.get("content-type") || "";
          const base = {
            kind: "fetch",
            url,
            status: resp.status,
            contentType,
            elapsedMs: Math.round(performance.now() - started),
          };
          if (/json|text|xml|mpegurl|dash|vtt/i.test(contentType) || /api\/|m3u8|mpd|vtt|caption|subtitle/i.test(url)) {
            resp.clone().text()
              .then((text) => push({ ...base, bodyLength: text.length, bodyPreview: text.slice(0, 4000) }))
              .catch(() => push(base));
          } else {
            push(base);
          }
        }
        return resp;
      } catch (err) {
        if (interestingUrl(rawUrl)) push({ kind: "fetch-error", url: String(rawUrl), error: String(err) });
        throw err;
      }
    };
    patchedFetch.__echo360ProbePatched = true;
    window.fetch = patchedFetch;
  }

  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (CAPTURE_NETWORK_DETAILS && xhrProto && !xhrProto.open.__echo360ProbePatched) {
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    xhrProto.open = function(method, url) {
      this.__echo360Probe = { method, url: String(url || ""), started: performance.now() };
      return originalOpen.apply(this, arguments);
    };
    xhrProto.open.__echo360ProbePatched = true;
    xhrProto.send = function() {
      const xhr = this;
      const meta = xhr.__echo360Probe || {};
      const shouldHideExpectedEcho404 =
        interestingUrl(meta.url) &&
        /\/api\/ui\/(?:interactive-media|discussions)\//i.test(meta.url || "");
      if (shouldHideExpectedEcho404) {
        xhr.addEventListener("error", (event) => event.stopImmediatePropagation(), true);
      }
      xhr.addEventListener("loadend", () => {
        const url = xhr.responseURL || meta.url || "";
        if (!interestingUrl(url)) return;
        let bodyPreview = "";
        let bodyLength = 0;
        try {
          if (!xhr.responseType || xhr.responseType === "text" || xhr.responseType === "json") {
            bodyPreview = String(xhr.responseText || "").slice(0, 4000);
            bodyLength = String(xhr.responseText || "").length;
          }
        } catch (_) {}
        push({
          kind: "xhr",
          method: meta.method || "",
          url,
          status: xhr.status,
          contentType: xhr.getResponseHeader("content-type") || "",
          elapsedMs: Math.round(performance.now() - (meta.started || performance.now())),
          bodyLength,
          bodyPreview,
        });
      });
      return originalSend.apply(this, arguments);
    };
  }

  const mediaEvents = ["loadedmetadata", "durationchange", "play", "pause", "emptied", "loadeddata", "canplay"];
  for (const eventName of mediaEvents) {
    document.addEventListener(eventName, (event) => {
      const target = event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      const ids = new Set();
      addUuids(target.currentSrc, ids);
      addUuids(target.src, ids);
      reactHints(target).forEach((id) => ids.add(id));
      push({
        kind: "media-event",
        event: eventName,
        currentTime: Number(target.currentTime || 0).toFixed(2),
        duration: Number(target.duration || 0).toFixed(2),
        paused: target.paused,
        currentSrc: target.currentSrc || "",
        src: target.src || "",
        uuidHints: [...ids],
      });
    }, true);
  }
})();

// ---------------------------------------------------------------------------
// Narrow MAIN-world Transcript layout bridge
// ---------------------------------------------------------------------------
// This is deliberately separate from the diagnostic probe above.  It does not
// inspect transcript text or alter Echo's data model; it only wraps a verified
// react-virtualized List/Grid rowHeight function and exposes scrollToRow.
(() => {
  if (window.__echo360TranscriptPageBridge?.installed) return;

  const SOURCE = "echo360-translator-transcript";
  const RESPONSE_SOURCE = "echo360-translator-transcript-page";
  const VERSION = 1;
  const CAPABILITY = "echo-react-virtualized-v1";
  const PANEL_TOKEN_ATTR = "data-echo360-transcript-panel-token";
  const MAX_ROW_COUNT = 100000;
  const MAX_EXTRAS = 10000;
  const MAX_EXTRA_PX = 400;
  const statesByToken = new Map();
  const stateByList = new WeakMap();
  let lifecycleObserver = null;
  let lastInstallFailure = null;

  const isFiniteInt = (value) => Number.isInteger(value) && Number.isFinite(value);
  const isOpaqueId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);

  function validEnvelope(data) {
    return !!data && typeof data === "object" && data.source === SOURCE && data.version === VERSION &&
      isOpaqueId(data.requestId) && isOpaqueId(data.panelToken) && isFiniteInt(data.revision) && data.revision >= 0;
  }

  function validRowCount(value) {
    return isFiniteInt(value) && value >= 0 && value <= MAX_ROW_COUNT;
  }

  function validateExtras(extras, rowCount) {
    if (!Array.isArray(extras) || extras.length > MAX_EXTRAS) return null;
    const out = new Map();
    for (const pair of extras) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [index, extra] = pair;
      if (!isFiniteInt(index) || !isFiniteInt(extra) || index < 0 || index >= rowCount || extra < 0 || extra > MAX_EXTRA_PX) {
        return null;
      }
      if (out.has(index)) return null;
      out.set(index, extra);
    }
    return out;
  }

  function findFiber(host) {
    if (!host) return null;
    let keys = [];
    try { keys = Reflect.ownKeys(host); } catch (_) {}
    const key = keys.find((name) => /^__react(?:Fiber|InternalInstance)\$/.test(String(name)));
    if (!key) return null;
    try {
      return host[key];
    } catch (_) {
      return null;
    }
  }

  function getManagerCellSizeGetter(manager) {
    if (typeof manager?._cellSizeGetter === "function") return manager._cellSizeGetter;
    const inner = manager?._cellSizeAndPositionManager;
    if (!inner || typeof inner !== "object" ||
        typeof inner.configure !== "function" || typeof inner.resetCell !== "function" ||
        typeof inner.getCellCount !== "function" || typeof inner.getEstimatedCellSize !== "function" ||
        typeof inner.getSizeAndPositionOfCell !== "function" || typeof inner._cellSizeGetter !== "function") {
      return null;
    }
    return inner._cellSizeGetter;
  }

  function getGridManager(grid) {
    const manager = grid?.state?.instanceProps?.rowSizeAndPositionManager;
    if (!manager || typeof manager.configure !== "function" || typeof manager.resetCell !== "function" ||
        typeof manager.getSizeAndPositionOfCell !== "function" || !getManagerCellSizeGetter(manager)) return null;
    const cellCount = typeof manager.getCellCount === "function" ? manager.getCellCount() : manager._cellCount;
    if (!validRowCount(cellCount)) return null;
    const estimated = typeof manager.getEstimatedCellSize === "function"
      ? manager.getEstimatedCellSize()
      : manager._estimatedCellSize;
    if (!Number.isFinite(Number(estimated)) || Number(estimated) < 0) return null;
    return manager;
  }

  function objectLooksLikeList(value, modelRowCount) {
    if (!value || typeof value !== "object") return false;
    const props = value.props;
    return typeof value.scrollToRow === "function" &&
      typeof value.recomputeRowHeights === "function" &&
      !!props && typeof props.rowHeight === "function" &&
      validRowCount(props.rowCount) && props.rowCount <= modelRowCount;
  }

  function getGridCandidates(list) {
    const candidates = [list.Grid, list._grid, list.grid, list.refs?.Grid, list.refs?.grid];
    return candidates.filter((candidate, index) => candidate && candidates.indexOf(candidate) === index);
  }

  function inspectVerifiedLayout(panelRoot, modelRowCount) {
    const fail = (reason, extra = {}) => ({ verified: null, reason, ...extra });
    if (!panelRoot || !validRowCount(modelRowCount)) return fail("invalid-model-row-count");
    const listHost = panelRoot.querySelector?.('.transcript-list[role="grid"]');
    if (!listHost || !panelRoot.contains(listHost)) return fail("list-host-not-found");
    const fiber = findFiber(listHost);
    if (!fiber) return fail("react-fiber-not-found");
    const list = (() => {
      let node = fiber;
      for (let depth = 0; node && depth < 32; depth += 1, node = node.return) {
        const candidate = node.stateNode;
        if (!candidate || typeof candidate !== "object") continue;
        const props = candidate.props;
        if (typeof candidate.scrollToRow !== "function" || typeof candidate.recomputeRowHeights !== "function" ||
            !props || typeof props.rowHeight !== "function" || !validRowCount(props.rowCount)) continue;
        if (props.rowCount > modelRowCount) return { rowCountExceeded: props.rowCount };
        if (objectLooksLikeList(candidate, modelRowCount)) return candidate;
      }
      return null;
    })();
    if (list?.rowCountExceeded != null) {
      return fail("host-row-count-exceeds-model", {
        hostRowCount: list.rowCountExceeded,
        modelRowCount,
      });
    }
    if (!list) return fail("react-list-not-found");
    const grids = getGridCandidates(list);
    if (grids.length === 0) return fail("react-grid-not-found");
    const grid = grids.find((candidate) => {
      const props = candidate?.props;
      return candidate && props && typeof props.rowHeight === "function" &&
        validRowCount(props.rowCount) && props.rowCount === list.props.rowCount;
    });
    if (!grid) return fail("react-grid-row-count-mismatch", {
      hostRowCount: Number(list.props.rowCount),
      gridRowCounts: grids.map((candidate) => Number(candidate?.props?.rowCount)).filter(Number.isFinite),
      modelRowCount,
    });
    if (Object.isFrozen(list.props) || Object.isFrozen(grid.props)) return fail("props-frozen");
    const manager = getGridManager(grid);
    if (!manager) return fail("row-manager-not-found-or-invalid");
    // The manager is the Grid's real offset source.  React-virtualized's
    // derived state configures it from the current Grid rowHeight prop; a
    // detached getter would let props look bridged while offsets stay stale.
    if (getManagerCellSizeGetter(manager) !== grid.props.rowHeight) return fail("row-manager-getter-mismatch");
    const visibleRowCount = Number(list.props.rowCount);
    if (visibleRowCount > modelRowCount) return fail("host-row-count-exceeds-model", {
      hostRowCount: visibleRowCount,
      modelRowCount,
    });
    const managerCellCount = typeof manager.getCellCount === "function" ? manager.getCellCount() : manager._cellCount;
    if (managerCellCount !== visibleRowCount) return fail("manager-row-count-mismatch", {
      hostRowCount: visibleRowCount,
      managerRowCount: Number(managerCellCount),
      modelRowCount,
    });
    return { verified: { panelRoot, listHost, list, grid, manager, visibleRowCount } };
  }

  function findVerifiedLayout(panelRoot, modelRowCount) {
    return inspectVerifiedLayout(panelRoot, modelRowCount).verified;
  }

  function findPanelForToken(panelToken) {
    const panels = Array.from(document.querySelectorAll('#transcripts-panel[role="tabpanel"]'))
      .filter((panel) => panel.getAttribute(PANEL_TOKEN_ATTR) === panelToken)
      .filter((panel) => panel.querySelector?.('.transcript-list[role="grid"]'));
    if (panels.length === 0) return { error: "panel-not-found" };
    if (panels.length !== 1) return { error: "multiple-panels" };
    return { panel: panels[0] };
  }

  function inspectPanelForToken(panelToken, modelRowCount) {
    const found = findPanelForToken(panelToken);
    if (!found.panel) return found;
    const inspected = inspectVerifiedLayout(found.panel, modelRowCount);
    if (!inspected.verified) {
      return {
        error: inspected.reason || "layout-not-verified",
        ...(Number.isFinite(inspected.hostRowCount) ? { hostRowCount: inspected.hostRowCount } : {}),
        ...(Number.isFinite(inspected.managerRowCount) ? { managerRowCount: inspected.managerRowCount } : {}),
        ...(Array.isArray(inspected.gridRowCounts) ? { gridRowCounts: inspected.gridRowCounts } : {}),
        modelRowCount,
      };
    }
    return { panel: found.panel, verified: inspected.verified };
  }

  function response(data, ok, extra = {}) {
    const payload = {
      source: RESPONSE_SOURCE,
      version: VERSION,
      requestId: data.requestId,
      panelToken: data.panelToken,
      ok: !!ok,
      ...extra,
    };
    try {
      window.postMessage(payload, "*");
    } catch (_) {}
    return payload;
  }

  function managerEstimatedCellSize(manager) {
    const estimated = typeof manager.getEstimatedCellSize === "function"
      ? manager.getEstimatedCellSize()
      : manager._estimatedCellSize;
    return Number(estimated);
  }

  // React Virtualized recomputes every offset from the first changed row.  If
  // a translated row above the viewport becomes taller, that recomputation
  // moves the browser's scrollTop even though the user has not scrolled.  The
  // native transcript auto-follow then corrects it on the next cue, producing
  // the visible "jump away, jump back" loop.  Keep the first visible row and
  // its pixel offset as an anchor while the row-height manager is rebuilt.
  function getScrollContainer(state) {
    return state?.grid?._scrollingContainer || state?.list?._scrollingContainer || state?.listHost || null;
  }

  function readScrollTop(state, container = getScrollContainer(state)) {
    const candidates = [
      container?.scrollTop,
      state?.grid?.state?.scrollTop,
    ];
    const value = candidates.find((item) => Number.isFinite(Number(item)) && Number(item) >= 0);
    return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  }

  function getCellPosition(manager, index) {
    try {
      const position = manager?.getSizeAndPositionOfCell?.(index);
      if (!position || !Number.isFinite(Number(position.offset)) || !Number.isFinite(Number(position.size))) return null;
      return { offset: Number(position.offset), size: Math.max(0, Number(position.size)) };
    } catch (_) {
      return null;
    }
  }

  function captureScrollAnchor(state) {
    const manager = state?.manager;
    const count = Number(manager?.getCellCount?.() ?? manager?._cellCount);
    if (!Number.isInteger(count) || count <= 0) return null;
    const container = getScrollContainer(state);
    const scrollTop = readScrollTop(state, container);
    let low = 0;
    let high = count - 1;
    let index = count - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const position = getCellPosition(manager, middle);
      if (!position) return null;
      if (position.offset + position.size > scrollTop) {
        index = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    const position = getCellPosition(manager, index);
    if (!position) return null;
    return {
      container,
      index,
      relativeOffset: scrollTop - position.offset,
      scrollTop,
    };
  }

  function restoreScrollAnchor(state, anchor) {
    if (!anchor) return;
    const position = getCellPosition(state?.manager, anchor.index);
    if (!position) return;
    let desired = position.offset + anchor.relativeOffset;
    const container = anchor.container || getScrollContainer(state);
    const viewport = Number(container?.clientHeight || 0);
    const total = Number(state?.manager?.getTotalSize?.() || 0);
    if (viewport > 0 && total > 0) desired = Math.min(desired, Math.max(0, total - viewport));
    desired = Math.max(0, Number(desired) || 0);
    const apply = () => {
      try { state?.grid?.scrollToPosition?.({ scrollTop: desired }); } catch (_) {}
      try {
        if (container && Number.isFinite(Number(container.scrollTop))) container.scrollTop = desired;
      } catch (_) {}
    };
    apply();
    // React Virtualized may commit its Grid update one frame after
    // recomputeRowHeights.  A second correction keeps the same anchor without
    // fighting the native follow-current-cue behavior between cues.
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
    else setTimeout(apply, 0);
  }

  function configureManager(state, visibleRowCount, recompute = false) {
    const manager = state.manager;
    const estimatedCellSize = managerEstimatedCellSize(manager);
    if (!Number.isFinite(estimatedCellSize) || estimatedCellSize < 0) return false;
    manager.configure({
      cellCount: visibleRowCount,
      estimatedCellSize,
      cellSizeGetter: state.bridgedGridRowHeight,
    });
    state.configuredVisibleRowCount = visibleRowCount;
    if (recompute) state.list.recomputeRowHeights(0);
    return true;
  }

  function restoreManager(state, recompute = false) {
    const manager = state.manager;
    const managerCellSizeGetter = getManagerCellSizeGetter(manager);
    if (managerCellSizeGetter !== state.bridgedGridRowHeight &&
        managerCellSizeGetter !== state.originalManagerCellSizeGetter) return false;
    const estimatedCellSize = managerEstimatedCellSize(manager);
    if (!Number.isFinite(estimatedCellSize) || estimatedCellSize < 0) return false;
    manager.configure({
      cellCount: state.visibleRowCount,
      estimatedCellSize,
      cellSizeGetter: state.originalManagerCellSizeGetter,
    });
    state.configuredVisibleRowCount = state.visibleRowCount;
    if (recompute) state.list.recomputeRowHeights(0);
    return true;
  }

  function restoreState(state, recompute = true) {
    if (!state) return false;
    const { list, grid, originalListRowHeight, originalGridRowHeight, bridgedListRowHeight, bridgedGridRowHeight } = state;
    try {
      const currentListRowHeight = list.props?.rowHeight;
      const currentGridRowHeight = grid.props?.rowHeight;
      const currentManagerRowHeight = getManagerCellSizeGetter(state.manager);
      // React may have committed a complete new host render before the
      // content-world cleanup arrives.  If List, Grid, and the manager agree
      // on that new pair of functions, the host already owns the restoration;
      // adopt those identities and only clear our extras/recompute.
      const hostAlreadyRestored = currentListRowHeight !== bridgedListRowHeight &&
        currentGridRowHeight !== bridgedGridRowHeight &&
        currentListRowHeight !== originalListRowHeight &&
        currentGridRowHeight !== originalGridRowHeight &&
        currentManagerRowHeight === currentGridRowHeight;
      const bridgeState = currentListRowHeight === bridgedListRowHeight &&
        currentGridRowHeight === bridgedGridRowHeight &&
        currentManagerRowHeight === state.bridgedGridRowHeight;
      const originalState = currentListRowHeight === state.originalListRowHeight &&
        currentGridRowHeight === state.originalGridRowHeight &&
        currentManagerRowHeight === state.originalManagerCellSizeGetter;
      if (!hostAlreadyRestored && !bridgeState && !originalState) return false;
      if (hostAlreadyRestored) {
        state.originalListRowHeight = currentListRowHeight;
        state.originalGridRowHeight = currentGridRowHeight;
        state.originalManagerCellSizeGetter = currentManagerRowHeight;
      }
      if (list.props?.rowHeight === bridgedListRowHeight) list.props.rowHeight = state.originalListRowHeight;
      else if (list.props?.rowHeight !== state.originalListRowHeight) return false;
      if (grid.props?.rowHeight === bridgedGridRowHeight) grid.props.rowHeight = state.originalGridRowHeight;
      else if (grid.props?.rowHeight !== state.originalGridRowHeight) return false;
      if (!restoreManager(state, false)) return false;
      state.extras = new Map();
      if (recompute) list.recomputeRowHeights(0);
      return true;
    } catch (_) {
      return false;
    }
  }

  function adoptHostFunctions(state, verified) {
    if (state.manager !== verified.manager) return null;
    const listFn = verified.list.props.rowHeight;
    const gridFn = verified.grid.props.rowHeight;
    const managerFn = getManagerCellSizeGetter(verified.manager);
    const listIsBridge = listFn === state.bridgedListRowHeight;
    const gridIsBridge = gridFn === state.bridgedGridRowHeight;
    if (listIsBridge !== gridIsBridge) return null;
    if (listIsBridge && gridIsBridge &&
        managerFn === state.bridgedGridRowHeight) return false;
    const propsAreOriginal = listFn === state.originalListRowHeight && gridFn === state.originalGridRowHeight;
    if (propsAreOriginal && managerFn === state.originalManagerCellSizeGetter) {
      // React can commit a host update that restores the original functions
      // while retaining the same List/Grid instances.  If the bridge simply
      // treats that as an already-owned binding, subsequent identical
      // set-layout messages are rejected as inconsistent and the DOM rows
      // keep their native heights (Chinese then overlaps English).  Report a
      // rebind so the caller reapplies both props and the manager getter.
      return true;
    }
    const listChanged = listFn !== state.originalListRowHeight;
    const gridChanged = gridFn !== state.originalGridRowHeight;
    // A functional React rerender changes both List and Grid props and the
    // Grid manager getter together.  A one-sided or manager-incoherent change
    // is treated as a third-party patch and rejected fail-closed.
    if (!listChanged || !gridChanged || managerFn !== gridFn) return null;
    state.originalListRowHeight = listFn;
    state.originalGridRowHeight = gridFn;
    state.originalManagerCellSizeGetter = managerFn;
    return true;
  }

  function refreshExistingBinding(state, modelRowCount, configure = true) {
    const verified = findVerifiedLayout(state.panelRoot, modelRowCount);
    if (!verified || verified.list !== state.list || verified.grid !== state.grid || verified.manager !== state.manager) return null;
    const rebind = adoptHostFunctions(state, verified);
    if (rebind == null) return null;
    const visibleChanged = state.visibleRowCount !== verified.visibleRowCount;
    state.modelRowCount = modelRowCount;
    state.rowCount = modelRowCount;
    state.visibleRowCount = verified.visibleRowCount;
    if (rebind || visibleChanged) {
      try {
        verified.list.props.rowHeight = state.bridgedListRowHeight;
        verified.grid.props.rowHeight = state.bridgedGridRowHeight;
        if (configure && !configureManager(state, state.visibleRowCount, true)) return null;
      } catch (_) {
        return null;
      }
    }
    return { verified, rebind: !!rebind, visibleChanged };
  }

  function forgetState(state) {
    if (!state) return;
    if (statesByToken.get(state.panelToken) === state) statesByToken.delete(state.panelToken);
    stateByList.delete(state.list);
  }

  function releaseState(state) {
    if (!state) return true;
    const hostStillOwned = !!(state.panelRoot?.isConnected && state.panelRoot.contains?.(state.listHost));
    // A disconnected React tree no longer affects the page.  If its host is
    // still present, restore only when the old identities are coherent; a
    // third-party/inconsistent mutation remains fail-closed.
    if (hostStillOwned && !restoreState(state, false)) return false;
    forgetState(state);
    return true;
  }

  function installState(data, verified) {
    lastInstallFailure = null;
    const previous = statesByToken.get(data.panelToken);
    if (previous && previous.panelRoot === verified.panelRoot && previous.list === verified.list &&
        previous.grid === verified.grid && previous.manager === verified.manager) {
      if (refreshExistingBinding(previous, data.rowCount)) return previous;
      lastInstallFailure = "refresh-existing-binding-failed";
      return null;
    }
    if (previous && !releaseState(previous)) {
      lastInstallFailure = "release-previous-state-failed";
      return null;
    }
    const current = stateByList.get(verified.list);
    if (current && current.panelToken !== data.panelToken) {
      lastInstallFailure = "list-already-bound";
      return null;
    }
    const originalListRowHeight = verified.list.props.rowHeight;
    const originalGridRowHeight = verified.grid.props.rowHeight;
    const originalManagerCellSizeGetter = getManagerCellSizeGetter(verified.manager);
    const state = {
      ...verified,
      panelToken: data.panelToken,
      modelRowCount: data.rowCount,
      rowCount: data.rowCount,
      visibleRowCount: verified.visibleRowCount,
      revision: 0,
      extras: new Map(),
      originalListRowHeight,
      originalGridRowHeight,
      originalManagerCellSizeGetter,
      configuredVisibleRowCount: verified.visibleRowCount,
      bridgedListRowHeight: null,
      bridgedGridRowHeight: null,
    };
    const extraFor = (args) => state.extras.get(typeof args === "number" ? args : Number(args?.index)) || 0;
    state.bridgedListRowHeight = function bridgedListRowHeight(args) {
      let base;
      try { base = state.originalListRowHeight.call(this, args); } catch (_) { return 0; }
      const value = Number(base) + extraFor(args);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    state.bridgedGridRowHeight = function bridgedGridRowHeight(args) {
      let base;
      try { base = state.originalGridRowHeight.call(this, args); } catch (_) { return 0; }
      const value = Number(base) + extraFor(args);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };
    try {
      verified.list.props.rowHeight = state.bridgedListRowHeight;
      verified.grid.props.rowHeight = state.bridgedGridRowHeight;
      // Safari can expose a non-writable props object without reporting it as
      // frozen.  In that case a non-strict assignment silently does nothing;
      // do not claim capability unless both props actually changed.
      if (verified.list.props.rowHeight !== state.bridgedListRowHeight ||
          verified.grid.props.rowHeight !== state.bridgedGridRowHeight) throw new Error("rowHeight props are not writable");
      if (!configureManager(state, state.visibleRowCount, true)) throw new Error("row manager unavailable");
    } catch (error) {
      lastInstallFailure = String(error?.message || error || "install-state-exception").slice(0, 160);
      try {
        verified.list.props.rowHeight = originalListRowHeight;
        verified.grid.props.rowHeight = originalGridRowHeight;
        verified.manager.configure({
          cellCount: verified.visibleRowCount,
          estimatedCellSize: managerEstimatedCellSize(verified.manager),
          cellSizeGetter: originalManagerCellSizeGetter,
        });
      } catch (_) {}
      return null;
    }
    statesByToken.set(data.panelToken, state);
    stateByList.set(verified.list, state);
    return state;
  }

  function handleCapabilities(data) {
    if (!validRowCount(data.rowCount)) return null;
    const inspected = inspectPanelForToken(data.panelToken, data.rowCount);
    if (!inspected.verified) {
      return response(data, false, {
        ...inspected,
        transient: isTransientLayoutError(inspected.error),
      });
    }
    const state = installState(data, inspected.verified);
    if (!state) return response(data, false, {
      error: "bridge-install-failed",
      detail: lastInstallFailure,
      modelRowCount: data.rowCount,
      transient: true,
    });
    return response(data, true, {
      capability: CAPABILITY,
      appliedRevision: state.revision,
      visibleRowCount: state.visibleRowCount,
    });
  }

  function isTransientLayoutError(error) {
    return new Set([
      "panel-not-found",
      "react-fiber-not-found",
      "react-list-not-found",
      "react-grid-not-found",
      "react-grid-row-count-mismatch",
      "bridge-install-failed",
      "binding-changed",
      "state-not-found",
    ]).has(String(error || ""));
  }

  function ensureStateForLayout(data) {
    const existing = statesByToken.get(data.panelToken);
    if (existing && data.revision < existing.revision) return { error: "stale-revision" };
    const inspected = inspectPanelForToken(data.panelToken, data.rowCount);
    if (!inspected.verified) return inspected;
    const state = installState(data, inspected.verified);
    if (!state) return { error: "bridge-install-failed", detail: lastInstallFailure, modelRowCount: data.rowCount };
    return { state };
  }

  function handleSetLayout(data) {
    if (!validRowCount(data.rowCount) || !Array.isArray(data.extras)) return null;
    const extras = validateExtras(data.extras, data.rowCount);
    const existing = statesByToken.get(data.panelToken);
    if (!extras || (existing && data.revision < existing.revision)) return null;
    // The renderer can receive a ResizeObserver notification for every native
    // current-cue update even when the translation heights are unchanged.  A
    // full fiber/manager discovery on each identical request needlessly
    // competes with playback and increases the chance of a lost response.  A
    // cheap identity check is enough to acknowledge a duplicate; a changed
    // List/Grid/manager falls through to the complete fail-closed verification
    // below.
    if (existing && existing.modelRowCount === data.rowCount && data.revision === existing.revision &&
        existing.panelRoot?.isConnected && existing.panelRoot.getAttribute(PANEL_TOKEN_ATTR) === existing.panelToken &&
        existing.panelRoot.contains?.(existing.listHost) &&
        existing.list.props?.rowHeight === existing.bridgedListRowHeight &&
        existing.grid.props?.rowHeight === existing.bridgedGridRowHeight &&
        getManagerCellSizeGetter(existing.manager) === existing.bridgedGridRowHeight) {
      const visibleExtras = new Map([...extras].filter(([index]) => index < existing.visibleRowCount));
      const sameExtras = visibleExtras.size === existing.extras.size &&
        [...visibleExtras].every(([index, value]) => existing.extras.get(index) === value);
      if (sameExtras) {
        return response(data, true, {
          capability: CAPABILITY,
          appliedRevision: existing.revision,
          visibleRowCount: existing.visibleRowCount,
        });
      }
    }
    const ensured = ensureStateForLayout(data);
    if (!ensured.state) {
      const existingStillOwnsHost = !!(existing?.panelRoot?.isConnected &&
        existing.panelRoot.contains?.(existing.listHost));
      // An already-bound, connected host that fails identity checks may have
      // been changed by the page (or frozen) rather than replaced by React.
      // Do not turn that fail-closed condition into a retry loop.
      if (ensured.error === "bridge-install-failed" && existingStillOwnsHost) return null;
      return response(data, false, {
        ...ensured,
        transient: isTransientLayoutError(ensured.error),
      });
    }
    const state = ensured.state;
    if (!state.panelRoot.isConnected || state.panelRoot.getAttribute(PANEL_TOKEN_ATTR) !== state.panelToken) {
      return response(data, false, { error: "state-not-found", transient: true, modelRowCount: data.rowCount });
    }
    const binding = refreshExistingBinding(state, data.rowCount, false);
    if (!binding) return response(data, false, { error: "binding-changed", transient: true, modelRowCount: data.rowCount });
    const visibleExtras = new Map([...extras].filter(([index]) => index < state.visibleRowCount));
    const mapEqual = (left, right) => left.size === right.size && [...left].every(([index, value]) => right.get(index) === value);
    const bindingChanged = binding.rebind || binding.visibleChanged;
    if (!bindingChanged && (
      state.list.props.rowHeight !== state.bridgedListRowHeight ||
      state.grid.props.rowHeight !== state.bridgedGridRowHeight ||
      getManagerCellSizeGetter(state.manager) !== state.bridgedGridRowHeight
    )) {
      return response(data, false, { error: "binding-inconsistent", modelRowCount: data.rowCount });
    }
    const extrasChanged = !mapEqual(state.extras, visibleExtras);
    if (data.revision === state.revision && extrasChanged) return null;
    const previousExtras = state.extras;
    const scrollAnchor = extrasChanged ? captureScrollAnchor(state) : null;
    const previousRevision = state.revision;
    state.extras = visibleExtras;
    if (bindingChanged) {
      try {
        if (!configureManager(state, state.visibleRowCount, true)) throw new Error("row manager unavailable");
      } catch (_) {
        state.extras = previousExtras;
        state.revision = previousRevision;
        return response(data, false, { error: "layout-configure-failed", modelRowCount: data.rowCount });
      }
    }
    if (!bindingChanged && !extrasChanged) {
      state.revision = data.revision;
      return response(data, true, {
        capability: CAPABILITY,
        appliedRevision: state.revision,
        visibleRowCount: state.visibleRowCount,
      });
    }
    const minIndex = (() => {
      const keys = new Set([...previousExtras.keys(), ...visibleExtras.keys()]);
      let min = state.visibleRowCount;
      for (const index of keys) if ((previousExtras.get(index) || 0) !== (visibleExtras.get(index) || 0)) min = Math.min(min, index);
      return min === state.visibleRowCount ? 0 : min;
    })();
    try {
      if (!bindingChanged) state.list.recomputeRowHeights(minIndex);
      if (extrasChanged) restoreScrollAnchor(state, scrollAnchor);
      state.revision = data.revision;
      return response(data, true, {
        capability: CAPABILITY,
        appliedRevision: state.revision,
        visibleRowCount: state.visibleRowCount,
      });
    } catch (_) {
      state.extras = previousExtras;
      state.revision = previousRevision;
      return response(data, false, { error: "layout-recompute-failed", modelRowCount: data.rowCount });
    }
  }

  function handleScrollToRow(data) {
    const state = statesByToken.get(data.panelToken);
    if (!state || !state.panelRoot.isConnected || state.panelRoot.getAttribute(PANEL_TOKEN_ATTR) !== state.panelToken || !validRowCount(data.rowCount) ||
      !isFiniteInt(data.rowIndex) || data.rowIndex < 0 || data.rowIndex >= data.rowCount) return null;
    const binding = refreshExistingBinding(state, data.rowCount);
    if (!binding || data.rowIndex >= state.visibleRowCount || state.list.props.rowHeight !== state.bridgedListRowHeight ||
        state.grid.props.rowHeight !== state.bridgedGridRowHeight || getManagerCellSizeGetter(state.manager) !== state.bridgedGridRowHeight) return null;
    try {
      state.list.scrollToRow(data.rowIndex);
      return response(data, true, {
        capability: CAPABILITY,
        appliedRevision: state.revision,
        visibleRowCount: state.visibleRowCount,
      });
    } catch (_) {
      return null;
    }
  }

  function handleRestore(data) {
    const state = statesByToken.get(data.panelToken);
    if (!state || !state.panelRoot.isConnected || state.panelRoot.getAttribute(PANEL_TOKEN_ATTR) !== state.panelToken || !state.panelRoot.contains(state.listHost)) return null;
    if (data.revision < state.revision) return null;
    if (!restoreState(state, true)) return null;
    state.revision = data.revision;
    statesByToken.delete(data.panelToken);
    stateByList.delete(state.list);
    return response(data, true, {
      capability: CAPABILITY,
      appliedRevision: data.revision,
      visibleRowCount: state.visibleRowCount,
    });
  }

  function hasOnlyKeys(data, allowed) {
    return Object.keys(data).every((key) => allowed.has(key));
  }

  function handleMessage(event) {
    if (!event || event.source !== window || !validEnvelope(event.data)) return null;
    const data = event.data;
    if (!validRowCount(data.rowCount)) return null;
    const baseKeys = new Set(["source", "version", "requestId", "action", "panelToken", "revision", "rowCount"]);
    if (data.action === "capabilities") {
      if (!hasOnlyKeys(data, baseKeys)) return null;
      return handleCapabilities(data);
    }
    if (data.action === "set-layout") {
      if (!hasOnlyKeys(data, new Set([...baseKeys, "extras"])) || typeof data.extras === "undefined") return null;
      return handleSetLayout(data);
    }
    if (data.action === "scroll-to-row") {
      if (!hasOnlyKeys(data, new Set([...baseKeys, "rowIndex"])) || typeof data.rowIndex === "undefined") return null;
      return handleScrollToRow(data);
    }
    if (data.action === "restore-layout") {
      if (!hasOnlyKeys(data, baseKeys)) return null;
      return handleRestore(data);
    }
    return null;
  }

  const listener = (event) => { handleMessage(event); };
  window.addEventListener("message", listener, false);
  if (typeof MutationObserver !== "undefined") {
    lifecycleObserver = new MutationObserver(() => {
      for (const [token, state] of statesByToken.entries()) {
        if (state.panelRoot?.isConnected) continue;
        restoreState(state, false);
        statesByToken.delete(token);
        stateByList.delete(state.list);
      }
    });
    lifecycleObserver.observe(document.documentElement || document, { childList: true, subtree: true });
  }
  window.__echo360TranscriptPageBridge = {
    installed: true,
    source: RESPONSE_SOURCE,
    version: VERSION,
    capability: CAPABILITY,
    handleMessage,
    validateExtras,
    findVerifiedLayout,
    statesByToken,
    restoreAll() {
      for (const [token, state] of statesByToken.entries()) {
        if (restoreState(state, true)) {
          statesByToken.delete(token);
          stateByList.delete(state.list);
        }
      }
    },
  };
  // Alias retained for diagnostics/tools that use the shorter historical name.
  window.__echo360TranscriptBridge = window.__echo360TranscriptPageBridge;
})();
