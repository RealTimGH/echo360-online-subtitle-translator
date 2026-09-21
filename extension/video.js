(() => {
  const ns = window.Echo360Translator;

  function installPageProbe() {
    if (window.__echo360TranslatorProbeInstalled) return;
    window.__echo360TranslatorProbeInstalled = true;

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.source !== "echo360-translator-probe" || !data.record) return;
      if (data.record.kind === "video-snapshot" && Array.isArray(data.record.videos)) {
        ns.state.latestPageVideoSnapshot = data.record.videos;
      }
    });
  }

  // A deep query used to rediscover every open shadow root on every renderer
  // maintenance pass. Keep an index instead: the document and every open
  // shadow root get their own observer, and only added subtrees are walked.
  //
  // MutationObserver cannot see an attachShadow() call made on a host that is
  // already in the document. The candidate queue is a deliberately bounded,
  // low-frequency compatibility check for that case. It contains elements
  // encountered by the initial/addition scans; it does not walk the document
  // on every query and it never patches page prototypes.
  const SHADOW_ROOT_RECONCILE_INTERVAL_MS = 15000;
  const MAX_SHADOW_ROOT_RECONCILE_CANDIDATES = 1000;
  const DISCOVERY_ATTRIBUTE_FILTER = [
    "class", "style", "hidden", "aria-hidden", "src", "poster", "data-media-id", "data-uuid", "data-source-id",
    "data-video-id", "data-echo360-translated", "label", "kind", "srclang", "default",
  ];
  const VIDEO_MEDIA_EVENTS = [
    "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "durationchange",
    "emptied", "play", "playing", "pause", "ended", "resize", "enterpictureinpicture",
    "leavepictureinpicture", "ratechange", "loadstart", "error",
  ];
  let discoveryStarted = false;
  let discoveryPageSuspended = false;
  let documentObserver = null;
  let shadowRootReconcileTimer = null;
  const shadowRoots = new Set();
  const shadowRootObservers = new Map();
  const indexedVideos = new Set();
  const videoListeners = new Map();
  const discoverySubscribers = new Set();
  const candidateElements = new Set();
  let candidateQueue = [];
  let candidateCursor = 0;
  const VIDEO_HINT_CACHE_TTL_MS = 3000;
  const MAX_HINT_TRAVERSAL_PROPERTIES = 4000;
  const videoHintCache = new WeakMap();

  function getMutationObserver() {
    return typeof MutationObserver === "function" ? MutationObserver : window.MutationObserver;
  }

  function isNodeConnected(node) {
    if (!node) return false;
    if (node === document) return true;
    if (typeof node.isConnected === "boolean") return node.isConnected;
    try {
      return !!document.documentElement?.contains(node);
    } catch (_) {
      return false;
    }
  }

  function isShadowRootConnected(root) {
    return root === document || isNodeConnected(root?.host);
  }

  function isDiscoverySuspended() {
    return discoveryPageSuspended || (document.visibilityState === "hidden" && !document.pictureInPictureElement);
  }

  function enqueueCandidate(element) {
    if (!element || element.nodeType !== 1 || candidateElements.has(element)) return;
    candidateElements.add(element);
    candidateQueue.push(element);
  }

  function compactCandidateQueue() {
    if (candidateQueue.length <= Math.max(2048, candidateElements.size * 2 + 64)) return;
    candidateQueue = candidateQueue.filter((element) => candidateElements.has(element));
    candidateCursor = candidateQueue.length > 0 ? candidateCursor % candidateQueue.length : 0;
  }

  function emitDiscoveryChange(type, detail = {}) {
    const change = { type, ...detail };
    for (const listener of [...discoverySubscribers]) {
      try {
        listener(change);
      } catch (error) {
        console.warn("[echo360-translator][video] discovery listener failed", error);
      }
    }
  }

  function attachVideoListeners(video) {
    const listeners = [];
    const notify = (event) => emitDiscoveryChange("media", { video, event: event?.type || "media" });
    for (const eventName of VIDEO_MEDIA_EVENTS) {
      try {
        video.addEventListener(eventName, notify);
        listeners.push([video, eventName, notify]);
      } catch (_) {}
    }
    const textTracks = video.textTracks;
    if (textTracks && typeof textTracks.addEventListener === "function") {
      for (const eventName of ["addtrack", "removetrack", "change"]) {
        try {
          textTracks.addEventListener(eventName, notify);
          listeners.push([textTracks, eventName, notify]);
        } catch (_) {}
      }
    }
    videoListeners.set(video, listeners);
  }

  function removeVideo(video) {
    if (!indexedVideos.delete(video)) return false;
    for (const [target, eventName, listener] of videoListeners.get(video) || []) {
      try {
        target.removeEventListener(eventName, listener);
      } catch (_) {}
    }
    videoListeners.delete(video);
    return true;
  }

  function processElement(element, state) {
    if (!element || element.nodeType !== 1) return;
    enqueueCandidate(element);
    if (String(element.tagName || "").toLowerCase() === "video" && !indexedVideos.has(element) && isNodeConnected(element)) {
      indexedVideos.add(element);
      attachVideoListeners(element);
      if (state) state.videosAdded = true;
    }
    const root = element.shadowRoot;
    if (root) registerShadowRoot(root, state);
  }

  function scanElements(root, state) {
    const elements = Array.from(root?.querySelectorAll?.("*") || []);
    for (const element of elements) processElement(element, state);
  }

  function scanAddedNode(node, state) {
    if (!node) return;
    if (node.nodeType === 1) processElement(node, state);
    scanElements(node, state);
  }

  function removeCandidatesInSubtree(node) {
    if (!node) return;
    // A node can appear in both removedNodes and addedNodes when a player
    // moves it within one mutation batch. Keep its live candidate in that
    // case; the added-subtree scan has already revalidated it.
    if (isNodeConnected(node)) return;
    const elements = [];
    if (node.nodeType === 1) elements.push(node);
    elements.push(...Array.from(node.querySelectorAll?.("*") || []));
    for (const element of elements) {
      candidateElements.delete(element);
      // Open shadow descendants are not included in querySelectorAll() on the
      // light subtree, but their hosts are still available in removed DOM.
      if (element.shadowRoot) removeCandidatesInSubtree(element.shadowRoot);
    }
    compactCandidateQueue();
  }

  function unregisterShadowRoot(root) {
    const observer = shadowRootObservers.get(root);
    if (observer) {
      try {
        observer.disconnect();
      } catch (_) {}
    }
    shadowRootObservers.delete(root);
    return shadowRoots.delete(root);
  }

  function registerShadowRoot(root, state) {
    if (!root || shadowRoots.has(root)) return false;
    shadowRoots.add(root);
    const Observer = getMutationObserver();
    if (typeof Observer === "function") {
      const observer = new Observer((records) => handleMutations(root, records));
      try {
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: DISCOVERY_ATTRIBUTE_FILTER,
        });
        shadowRootObservers.set(root, observer);
      } catch (_) {
        try { observer.disconnect(); } catch (_) {}
      }
    }
    scanElements(root, state);
    if (state) state.shadowRootsAdded = true;
    return true;
  }

  function cleanupDisconnected(state) {
    let changed = false;
    for (const root of [...shadowRoots]) {
      if (!isShadowRootConnected(root)) {
        unregisterShadowRoot(root);
        changed = true;
      }
    }
    for (const video of [...indexedVideos]) {
      if (!isNodeConnected(video)) {
        removeVideo(video);
        changed = true;
      }
    }
    if (state && changed) state.disconnected = true;
    return changed;
  }

  function isMediaNode(node) {
    if (!node) return false;
    const name = String(node.nodeName || "").toLowerCase();
    if (name === "video" || name === "track") return true;
    return !!node.querySelector?.("video,track");
  }

  function handleMutations(root, records) {
    if (!discoveryStarted) return;
    const state = { videosAdded: false, shadowRootsAdded: false, disconnected: false };
    let relevant = false;
    for (const record of records || []) {
      if (record.type === "childList") {
        for (const node of record.addedNodes || []) {
          scanAddedNode(node, state);
          if (isMediaNode(node)) relevant = true;
        }
        for (const node of record.removedNodes || []) {
          removeCandidatesInSubtree(node);
          if (isMediaNode(node)) relevant = true;
        }
      } else if (record.type === "attributes") {
        // Attribute changes on videos/tracks can change the source or active
        // track without changing the node topology.
        const target = record.target;
        const knownVideoAffected = [...indexedVideos].some((video) =>
          isNodeWithin(target, video) || isNodeWithin(video, target));
        if (knownVideoAffected) {
          processElement(target, state);
          relevant = true;
        } else if (target?.shadowRoot && !shadowRoots.has(target.shadowRoot)) {
          processElement(target, state);
        }
      }
    }
    cleanupDisconnected(state);
    if (state.videosAdded || state.shadowRootsAdded || state.disconnected) relevant = true;
    if (relevant) {
      emitDiscoveryChange("dom", { root, records: records || [] });
    }
  }

  function reconcileShadowRoots() {
    shadowRootReconcileTimer = null;
    if (!discoveryStarted || isDiscoverySuspended()) return;
    const state = { videosAdded: false, shadowRootsAdded: false, disconnected: false };
    let checked = 0;
    let visited = 0;
    const visitBudget = Math.min(MAX_SHADOW_ROOT_RECONCILE_CANDIDATES, candidateQueue.length);
    while (candidateQueue.length > 0 && visited < visitBudget) {
      if (candidateCursor >= candidateQueue.length) candidateCursor = 0;
      const element = candidateQueue[candidateCursor++];
      visited += 1;
      if (!candidateElements.has(element)) continue;
      if (!isNodeConnected(element)) {
        candidateElements.delete(element);
        continue;
      }
      processElement(element, state);
      checked += 1;
    }
    if (candidateElements.size === 0) {
      candidateQueue = [];
      candidateCursor = 0;
    } else {
      compactCandidateQueue();
    }
    cleanupDisconnected(state);
    if (state.videosAdded || state.shadowRootsAdded || state.disconnected) {
      emitDiscoveryChange("reconcile", { checked });
    }
    scheduleShadowRootReconcile();
  }

  function scheduleShadowRootReconcile() {
    if (!discoveryStarted || shadowRootReconcileTimer != null || isDiscoverySuspended()) return;
    const batches = Math.max(1, Math.ceil(candidateQueue.length / MAX_SHADOW_ROOT_RECONCILE_CANDIDATES));
    const delay = Math.max(50, Math.floor(SHADOW_ROOT_RECONCILE_INTERVAL_MS / batches));
    shadowRootReconcileTimer = setTimeout(reconcileShadowRoots, delay);
    shadowRootReconcileTimer?.unref?.();
  }

  function onDiscoveryVisibilityChanged() {
    if (shadowRootReconcileTimer != null) clearTimeout(shadowRootReconcileTimer);
    shadowRootReconcileTimer = null;
    scheduleShadowRootReconcile();
  }

  function suspendDiscovery() {
    discoveryPageSuspended = true;
    onDiscoveryVisibilityChanged();
  }

  function resumeDiscovery() {
    discoveryPageSuspended = false;
    onDiscoveryVisibilityChanged();
  }

  function startDiscovery() {
    if (discoveryStarted) return;
    discoveryStarted = true;
    const state = { videosAdded: false, shadowRootsAdded: false, disconnected: false };
    // This is the one initial document walk. Thereafter observers scan only
    // added subtrees and the bounded candidate queue checks late shadow roots.
    scanElements(document, state);
    const Observer = getMutationObserver();
    if (typeof Observer === "function") {
      documentObserver = new Observer((records) => handleMutations(document, records));
      try {
        documentObserver.observe(document, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: DISCOVERY_ATTRIBUTE_FILTER,
        });
      } catch (_) {
        try { documentObserver.disconnect(); } catch (_) {}
        documentObserver = null;
      }
    }
    document.addEventListener("visibilitychange", onDiscoveryVisibilityChanged);
    document.addEventListener("enterpictureinpicture", onDiscoveryVisibilityChanged, true);
    document.addEventListener("leavepictureinpicture", onDiscoveryVisibilityChanged, true);
    window.addEventListener("pagehide", suspendDiscovery);
    window.addEventListener("pageshow", resumeDiscovery);
    scheduleShadowRootReconcile();
  }

  function destroyDiscovery() {
    if (shadowRootReconcileTimer != null) clearTimeout(shadowRootReconcileTimer);
    shadowRootReconcileTimer = null;
    try { documentObserver?.disconnect?.(); } catch (_) {}
    documentObserver = null;
    document.removeEventListener("visibilitychange", onDiscoveryVisibilityChanged);
    document.removeEventListener("enterpictureinpicture", onDiscoveryVisibilityChanged, true);
    document.removeEventListener("leavepictureinpicture", onDiscoveryVisibilityChanged, true);
    window.removeEventListener("pagehide", suspendDiscovery);
    window.removeEventListener("pageshow", resumeDiscovery);
    discoveryPageSuspended = false;
    for (const root of [...shadowRoots]) unregisterShadowRoot(root);
    for (const video of [...indexedVideos]) removeVideo(video);
    shadowRoots.clear();
    indexedVideos.clear();
    discoverySubscribers.clear();
    candidateElements.clear();
    candidateQueue = [];
    candidateCursor = 0;
    discoveryStarted = false;
  }

  function subscribeToChanges(listener) {
    if (typeof listener !== "function") return () => {};
    startDiscovery();
    discoverySubscribers.add(listener);
    return () => discoverySubscribers.delete(listener);
  }

  function flushPendingMutations() {
    const pendingDocumentRecords = documentObserver?.takeRecords?.() || [];
    if (pendingDocumentRecords.length > 0) handleMutations(document, pendingDocumentRecords);
    for (const [root, observer] of shadowRootObservers) {
      const records = observer?.takeRecords?.() || [];
      if (records.length > 0) handleMutations(root, records);
    }
  }

  function isNodeWithin(container, node) {
    if (!container || !node) return false;
    let current = node;
    while (current) {
      if (current === container) return true;
      if (current.parentNode) {
        current = current.parentNode;
      } else if (current.host) {
        current = current.host;
      } else {
        current = null;
      }
    }
    return false;
  }

  function getShadowRootsWithin(root) {
    const roots = [];
    for (const shadowRoot of shadowRoots) {
      if (!isShadowRootConnected(shadowRoot)) continue;
      if (root === document || root === shadowRoot || isNodeWithin(root, shadowRoot.host)) roots.push(shadowRoot);
    }
    return roots;
  }

  function querySelectorAllDeep(selector, root = document) {
    startDiscovery();
    flushPendingMutations();
    cleanupDisconnected();
    const results = Array.from(root?.querySelectorAll?.(selector) || []);
    for (const shadowRoot of getShadowRootsWithin(root)) {
      results.push(...Array.from(shadowRoot.querySelectorAll(selector)));
    }
    return Array.from(new Set(results));
  }

  function getAllVideos() {
    return querySelectorAllDeep("video");
  }

  function getVideoSelectionScore(video) {
    if (!video) return -Infinity;
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
    let score = 0;
    if (!video.paused && !video.ended) score += 1_000_000;
    if (Number(video.currentTime) > 0) score += 100_000 + Number(video.currentTime) * 100;
    score += (Number(video.readyState) || 0) * 10_000;
    if (visible) score += 50_000;
    score += area;
    if (!visible || area < 10_000) score -= 200_000;
    return score;
  }

  function getPrimaryVideo() {
    const videos = getAllVideos();
    if (videos.length === 0) return null;
    const candidates = videos.filter((v) => {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
      return visible && area > 10_000;
    });
    const pool = candidates.length > 0 ? candidates : videos;
    return pool.slice().sort((a, b) => getVideoSelectionScore(b) - getVideoSelectionScore(a))[0];
  }

  function isVideoLikelyActive(video) {
    if (!video) return false;
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0;
    return visible && area > 10_000 && !video.ended && (video.readyState || 0) >= 2;
  }

  async function waitForVideo(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const video = getPrimaryVideo();
      if (video) return video;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  function addUuidMatches(text, out) {
    const matches = String(text || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || [];
    for (const id of matches) out.add(id.toLowerCase());
  }

  function collectUuidsFromObject(value, out, depth = 0, seen = new WeakSet(), budget = { remaining: MAX_HINT_TRAVERSAL_PROPERTIES }) {
    if (out.size > 120 || depth > 5 || value == null) return;
    if (budget.remaining <= 0) return;
    const type = typeof value;
    if (type === "string" || type === "number") {
      addUuidMatches(value, out);
      return;
    }
    if (type !== "object" && type !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);

    let keys = [];
    try {
      keys = Reflect.ownKeys(value).slice(0, 120);
    } catch (_) {
      return;
    }
    for (const key of keys) {
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;
      addUuidMatches(key, out);
      let next;
      try {
        next = value[key];
      } catch (_) {
        continue;
      }
      collectUuidsFromObject(next, out, depth + 1, seen, budget);
    }
  }

  function getInternalMediaIdsFromNode(node, budget, seen) {
    const hints = new Set();
    if (!node) return hints;
    if (!budget || budget.remaining <= 0) return hints;
    let keys = [];
    try {
      keys = Reflect.ownKeys(node);
    } catch (_) {
      return hints;
    }
    for (const key of keys) {
      const name = String(key);
      if (!/(react|fiber|props|state|echo|media|player)/i.test(name)) continue;
      try {
        collectUuidsFromObject(node[key], hints, 0, seen, budget);
      } catch (_) {}
    }
    return hints;
  }

  function getHintAttributeSignature(video) {
    const parts = [];
    let node = video;
    let depth = 0;
    while (node && depth < 5) {
      for (const attribute of Array.from(node.attributes || [])) {
        if (/(uuid|media|source|src|echo|player|react|fiber|data-)/i.test(attribute.name) ||
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(attribute.value)) {
          parts.push(`${attribute.name}=${attribute.value}`);
        }
      }
      node = node.parentElement;
      depth += 1;
    }
    return parts.join("\u0001");
  }

  function extractMediaIdFromVttUrl(url) {
    const raw = String(url || "");
    // Echo360's lesson endpoint uses captions-<uuid>-<suffix>, while Canvas
    // Instructure Media uses /api/media_management/caption_files/<uuid>-<suffix>
    // (the suffix is usually an institution/player identifier).  Both URLs
    // identify the same media UUID; keeping this extraction in the shared
    // video module lets source selection and mount selection use the exact
    // same mapping for both old and new page types.
    const patterns = [
      /captions-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i,
      /\/caption_files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-|\/|$)/i,
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) return match[1].toLowerCase();
    }
    return "";
  }

  function extractInteractiveMediaId(url) {
    const m = String(url || "").match(/\/api\/ui\/interactive-media\/media\/([0-9a-f-]{36})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : "";
  }

  function collectInteractiveMediaIdsFromResources() {
    const ids = new Set();
    const entries = performance.getEntriesByType("resource") || [];
    for (const e of entries) {
      const id = extractInteractiveMediaId(e.name || "");
      if (id) ids.add(id);
    }
    return ids;
  }

  function getVideoHintMediaIds(video) {
    const now = Date.now();
    const currentSrc = String(video?.currentSrc || "");
    const src = String(video?.src || "");
    const attributeSignature = getHintAttributeSignature(video);
    const cached = video && videoHintCache.get(video);
    if (cached && cached.currentSrc === currentSrc && cached.src === src &&
      cached.attributeSignature === attributeSignature &&
      now - cached.at < VIDEO_HINT_CACHE_TTL_MS) {
      return new Set(cached.ids);
    }
    const hints = new Set();
    const traversalBudget = { remaining: MAX_HINT_TRAVERSAL_PROPERTIES };
    const traversalSeen = new WeakSet();
    const add = (s) => addUuidMatches(s, hints);
    add(currentSrc);
    add(src);
    const attrs = video ? Array.from(video.attributes || []) : [];
    for (const a of attrs) add(a.value);
    let node = video;
    let depth = 0;
    while (node && depth < 5) {
      const at = Array.from(node.attributes || []);
      for (const a of at) add(a.value);
      for (const id of getInternalMediaIdsFromNode(node, traversalBudget, traversalSeen)) hints.add(id);
      node = node.parentElement;
      depth += 1;
    }
    const videos = getAllVideos();
    const index = videos.indexOf(video);
    const probeVideo = index >= 0 ? ns.state.latestPageVideoSnapshot[index] : null;
    if (probeVideo && Array.isArray(probeVideo.uuidHints)) {
      for (const id of probeVideo.uuidHints) hints.add(String(id).toLowerCase());
    }
    if (video) videoHintCache.set(video, { at: now, currentSrc, src, attributeSignature, ids: [...hints] });
    return new Set(hints);
  }

  ns.video = {
    installPageProbe,
    subscribeToChanges,
    destroy: destroyDiscovery,
    querySelectorAllDeep,
    getAllVideos,
    getPrimaryVideo,
    isVideoLikelyActive,
    waitForVideo,
    extractMediaIdFromVttUrl,
    collectInteractiveMediaIdsFromResources,
    getVideoHintMediaIds,
  };
})();
