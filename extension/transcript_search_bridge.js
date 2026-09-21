(() => {
  const ns = window.Echo360Translator;
  const adapter = () => ns.transcriptPanelAdapter;
  const modelApi = () => ns.transcriptModel;
  const BRIDGE_ATTR = "data-echo360-transcript-search-bridge";
  const HIT_ATTR = "data-echo360-transcript-search-hit";
  const CURRENT_CLASS = "echo360-transcript-search-current";
  const renderSignatures = new WeakMap();

  const state = {
    model: null,
    panels: new Map(),
    started: false,
    query: "",
    matches: [],
    currentIndex: -1,
    inputListeners: new Map(),
    renderer: null,
    refreshHandle: null,
    refreshHandleType: "",
    refreshGeneration: 0,
    diagnostics: { refreshCount: 0, virtualizedTargetMisses: 0 },
  };

  function normalize(value) {
    return modelApi()?.normalizeSearchText?.(value) || String(value || "").normalize?.("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  }

  function createTextNodes(parent, text, ranges = []) {
    const raw = String(text || "");
    if (ranges.length === 0) {
      parent.appendChild(document.createTextNode(raw));
      return;
    }
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    let offset = 0;
    for (const range of sorted) {
      const start = Math.max(offset, Math.min(raw.length, Number(range.start) || 0));
      const end = Math.max(start, Math.min(raw.length, Number(range.end) || start));
      if (start > offset) parent.appendChild(document.createTextNode(raw.slice(offset, start)));
      if (end > start) {
        const mark = document.createElement("mark");
        mark.setAttribute(HIT_ATTR, "1");
        mark.textContent = raw.slice(start, end);
        parent.appendChild(mark);
      }
      offset = end;
    }
    if (offset < raw.length) parent.appendChild(document.createTextNode(raw.slice(offset)));
  }

  function pruneDetachedPanels() {
    for (const [root, panelState] of state.panels) {
      if (root.isConnected !== false) continue;
      const input = adapter()?.findSearchInput(root);
      if (input) {
        input.removeEventListener("input", state.inputListeners.get(input));
        state.inputListeners.delete(input);
      }
      panelState.ui?.remove?.();
      state.panels.delete(root);
    }
  }

  function findMatches(model, query) {
    pruneDetachedPanels();
    if (!model?.cues || state.panels.size === 0) return [];
    const limits = [...state.panels.values()].map((panelState) => {
      if (!panelState.descriptor?.virtualized) return model.cues.length;
      return panelState.visibleRowCount;
    });
    if (limits.some((limit) => !Number.isInteger(limit) || limit < 0 || limit > model.cues.length)) return [];
    const visibleCount = Math.min(...limits);
    return modelApi()?.searchTranslations?.(model, query, visibleCount) || [];
  }

  function getCurrentMatch() {
    return state.currentIndex >= 0 ? state.matches[state.currentIndex] || null : null;
  }

  function ensureUi(panelState) {
    const descriptor = panelState.descriptor?.searchInput?.isConnected && panelState.root.contains(panelState.descriptor.searchInput)
      ? panelState.descriptor
      : adapter()?.getPanelDescriptor(panelState.root);
    if (descriptor) panelState.descriptor = descriptor;
    const input = descriptor?.searchInput || adapter()?.findSearchInput(panelState.root);
    const container = descriptor?.searchContainer || adapter()?.findSearchContainer(panelState.root) || input?.parentElement;
    if (!input || !container) return null;
    let ui = panelState.ui;
    if (!ui || !ui.isConnected || !container.contains(ui)) {
      ui = container.querySelector(`[${BRIDGE_ATTR}="1"]`);
    }
    if (!ui) {
      ui = document.createElement("div");
      ui.setAttribute(BRIDGE_ATTR, "1");
      ui.setAttribute("role", "status");
      ui.setAttribute("aria-live", "polite");
      ui.className = "echo360-transcript-search-bridge";
      const label = document.createElement("span");
      label.setAttribute("data-echo360-transcript-search-count", "1");
      const previous = document.createElement("button");
      previous.type = "button";
      previous.setAttribute("data-echo360-transcript-search-prev", "1");
      previous.setAttribute("aria-label", "上一个译文匹配 Previous translated match");
      previous.textContent = "‹";
      const next = document.createElement("button");
      next.type = "button";
      next.setAttribute("data-echo360-transcript-search-next", "1");
      next.setAttribute("aria-label", "下一个译文匹配 Next translated match");
      next.textContent = "›";
      previous.addEventListener("click", () => navigate(-1));
      next.addEventListener("click", () => navigate(1));
      ui.append(label, previous, next);
      container.appendChild(ui);
    }
    const uiChanged = panelState.ui !== ui;
    panelState.ui = ui;
    if (uiChanged || !panelState.uiElements) {
      panelState.uiElements = {
        label: ui.querySelector(`[data-echo360-transcript-search-count="1"]`),
        previous: ui.querySelector(`[data-echo360-transcript-search-prev="1"]`),
        next: ui.querySelector(`[data-echo360-transcript-search-next="1"]`),
      };
    }
    return ui;
  }

  function mountInput(panelRoot) {
    const input = adapter()?.findSearchInput(panelRoot);
    if (!input || state.inputListeners.has(input)) return input;
    const listener = () => {
      // Passive observer: do not stop native Echo360 input handling or write a
      // proxy query back into the input.
      queueRefresh(input.value || "");
    };
    input.addEventListener("input", listener, false);
    state.inputListeners.set(input, listener);
    return input;
  }

  function queueRefresh(query) {
    const nextQuery = String(query || "");
    const generation = ++state.refreshGeneration;
    cancelQueuedRefresh();
    const run = () => {
      if (generation !== state.refreshGeneration) return;
      state.refreshHandle = null;
      state.refreshHandleType = "";
      refresh(nextQuery);
    };
    if (typeof requestAnimationFrame === "function") {
      state.refreshHandleType = "raf";
      state.refreshHandle = requestAnimationFrame(run);
    } else {
      state.refreshHandleType = "timeout";
      state.refreshHandle = setTimeout(run, 0);
    }
  }

  function cancelQueuedRefresh() {
    if (state.refreshHandle == null) return;
    if (state.refreshHandleType === "raf" && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(state.refreshHandle);
    } else if (state.refreshHandleType === "timeout") {
      clearTimeout(state.refreshHandle);
    }
    state.refreshHandle = null;
    state.refreshHandleType = "";
  }

  function highlightVisibleTranslations() {
    const visibleMatches = new Map();
    for (const match of state.matches) {
      const list = visibleMatches.get(match.cue.key) || [];
      list.push(match);
      visibleMatches.set(match.cue.key, list);
    }
    const current = getCurrentMatch();
    const currentKey = current?.cue?.key || "";
    for (const panelState of state.panels.values()) {
      // The bridge only owns translation nodes.  Querying those directly
      // avoids re-enumerating every virtualized English cue on every keypress
      // and keeps native search markup completely untouched.
      const translations = panelState.root.querySelectorAll?.('[data-echo360-transcript-translation="1"]') || [];
      for (const translation of translations) {
        const key = translation.getAttribute("data-echo360-cue-key") || "";
        const text = translation.getAttribute("data-echo360-translated-text") || translation.textContent || "";
        const ranges = visibleMatches.get(key) || [];
        const rangeSignature = ranges.map((range) => `${range.start}:${range.end}`).join(",");
        const currentForNode = currentKey === key;
        const signature = `${text}\u0000${rangeSignature}\u0000${currentForNode ? "1" : "0"}`;
        if (renderSignatures.get(translation) !== signature) {
          translation.querySelectorAll?.(`[${HIT_ATTR}="1"]`).forEach((node) => node.remove());
          // Rebuild only extension-owned translation content.  Native English
          // spans, including Echo's own <mark> nodes, are never touched.
          translation.textContent = "";
          createTextNodes(translation, text, ranges);
          renderSignatures.set(translation, signature);
        }
        translation.classList.toggle(CURRENT_CLASS, currentForNode);
        if (currentForNode) translation.setAttribute("aria-current", "true");
        else translation.removeAttribute("aria-current");
      }
    }
  }

  function updateUi() {
    const total = state.matches.length;
    for (const panelState of state.panels.values()) {
      const ui = ensureUi(panelState);
      if (!ui) continue;
      const { label, previous, next } = panelState.uiElements || {};
      if (!label || !previous || !next) continue;
      const visible = !!normalize(state.query) && total > 0;
      ui.hidden = !visible;
      if (visible) label.textContent = `译文匹配 ${state.currentIndex + 1} / ${total}`;
      else label.textContent = "";
      previous.disabled = !visible;
      next.disabled = !visible;
    }
  }

  async function scrollToMatch(match) {
    if (!match) return false;
    let found = false;
    for (const panelState of state.panels.values()) {
      const translations = panelState.root.querySelectorAll?.('[data-echo360-transcript-translation="1"]') || [];
      for (const translation of translations) {
        if (translation.getAttribute("data-echo360-cue-key") !== match.cue.key) continue;
        found = true;
        try { translation.scrollIntoView?.({ block: "center" }); } catch (_) {}
      }
    }
    if (found) return true;
    if (typeof state.renderer?.scrollToCue !== "function") return false;
    const result = await Promise.resolve(state.renderer.scrollToCue(match.cue));
    if (result === false) state.diagnostics.virtualizedTargetMisses += 1;
    return result !== false;
  }

  function navigate(delta) {
    if (state.matches.length === 0) return Promise.resolve(false);
    const next = state.currentIndex < 0
      ? (delta >= 0 ? 0 : state.matches.length - 1)
      : (state.currentIndex + delta + state.matches.length) % state.matches.length;
    state.currentIndex = next;
    highlightVisibleTranslations();
    updateUi();
    return scrollToMatch(state.matches[next]);
  }

  function refresh(query = state.query) {
    if (typeof document === "undefined") return [];
    // A direct refresh supersedes any queued input-frame refresh.  Incrementing
    // the generation here prevents a stale callback from restoring an older
    // query after callers update the model or panel synchronously.
    cancelQueuedRefresh();
    state.refreshGeneration += 1;
    state.diagnostics.refreshCount += 1;
    const previousQuery = normalize(state.query);
    const previous = getCurrentMatch();
    state.query = String(query || "");
    state.matches = findMatches(state.model, state.query);
    if (state.matches.length === 0) state.currentIndex = -1;
    else if (previousQuery === normalize(state.query) && previous) {
      const preserved = state.matches.findIndex((match) => match.cue.key === previous.cue.key &&
        match.start === previous.start && match.end === previous.end);
      state.currentIndex = preserved >= 0 ? preserved : 0;
    } else state.currentIndex = 0;
    highlightVisibleTranslations();
    updateUi();
    return state.matches;
  }

  function setPanels(panelRoots) {
    const roots = Array.isArray(panelRoots) ? panelRoots : [];
    const validRoots = roots.filter((root) => !!adapter()?.getPanelDescriptor(root));
    const validRootSet = new Set(validRoots);
    const next = new Map();
    for (const oldPanel of state.panels.values()) {
      if (validRootSet.has(oldPanel.root)) continue;
      const oldInput = adapter()?.findSearchInput(oldPanel.root);
      if (oldInput) {
        oldInput.removeEventListener("input", state.inputListeners.get(oldInput));
        state.inputListeners.delete(oldInput);
      }
      oldPanel.root.querySelectorAll?.(`[${BRIDGE_ATTR}="1"]`).forEach((node) => node.remove());
    }
    for (const root of validRoots) {
      const descriptor = adapter()?.getPanelDescriptor(root);
      if (!descriptor) continue;
      const panelState = state.panels.get(root) || { root, descriptor, ui: null, uiElements: null };
      panelState.descriptor = descriptor;
      const modelCount = state.model?.cues?.length || 0;
      if (!Number.isInteger(panelState.visibleRowCount) || panelState.visibleRowCount < 0 || panelState.visibleRowCount > modelCount) {
        panelState.visibleRowCount = descriptor.virtualized ? null : (state.model?.cues?.length || 0);
      }
      next.set(root, panelState);
      mountInput(root);
    }
    state.panels = next;
    const activeInput = validRoots.map((root) => adapter()?.findSearchInput(root)).find(Boolean);
    const activeQuery = activeInput ? (activeInput.value || "") : state.query;
    refresh(activeQuery);
  }

  function setModel(model) {
    state.model = model || null;
    refresh(state.query);
  }

  function clear() {
    state.refreshGeneration += 1;
    cancelQueuedRefresh();
    state.model = null;
    state.query = "";
    state.matches = [];
    state.currentIndex = -1;
    for (const panelState of state.panels.values()) {
      const input = adapter()?.findSearchInput(panelState.root);
      if (input) {
        input.removeEventListener("input", state.inputListeners.get(input));
        state.inputListeners.delete(input);
      }
      panelState.root.querySelectorAll?.(`[${BRIDGE_ATTR}="1"]`).forEach((node) => node.remove());
      panelState.root.querySelectorAll?.(`[data-echo360-transcript-translation="1"]`).forEach((node) => {
        node.querySelectorAll?.(`[${HIT_ATTR}="1"]`).forEach((hit) => hit.remove());
      });
    }
    state.panels = new Map();
  }

  function setPanelVisibleCount(root, visibleRowCount) {
    const panelState = state.panels.get(root);
    if (!panelState || !panelState.descriptor?.virtualized) return;
    const count = Number(visibleRowCount);
    const modelCount = state.model?.cues?.length || 0;
    if (!Number.isInteger(count) || count < 0 || count > modelCount) return;
    if (panelState.visibleRowCount === count) return;
    panelState.visibleRowCount = count;
    refresh(state.query);
  }

  function start(renderer) {
    if (renderer) state.renderer = renderer;
    state.started = true;
    return api;
  }

  function getDebugState() {
    pruneDetachedPanels();
    return {
      query: state.query,
      searchQuery: state.query,
      translatedMatchCount: state.matches.length,
      currentIndex: state.currentIndex,
      panelCount: state.panels.size,
      ...state.diagnostics,
    };
  }

  const api = {
    start,
    setModel,
    setPanels,
    setPanelVisibleCount,
    refresh,
    navigate,
    clear,
    getDebugState,
    normalize,
    findMatches,
    _state: state,
  };
  ns.transcriptSearchBridge = api;
})();
