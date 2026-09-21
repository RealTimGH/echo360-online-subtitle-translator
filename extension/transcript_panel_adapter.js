(() => {
  const ns = window.Echo360Translator;
  const modelApi = () => ns.transcriptModel;

  const PANEL_SELECTOR = '#transcripts-panel[role="tabpanel"]';
  // Echo's accessible label is present in some builds but is not stable across
  // Safari/React render paths.  The id is the verified viewer contract; the
  // surrounding panel/list checks below keep this from matching an unrelated
  // input on an editor or legacy page.
  const SEARCH_SELECTOR = '#search-transcripts_input';
  const LIST_SELECTOR = '.transcript-list[role="grid"]';
  const ROWGROUP_SELECTOR = '.ReactVirtualized__Grid__innerScrollContainer[role="rowgroup"]';
  const CUE_SELECTOR = 'dd[data-test-component="Content"][title$=" min"], dd[data-test-component="Content"][title$=" sec"]';
  // Panel structure is stable across cue mutations.  Keep the expensive
  // selector walk for the panel's structural nodes in a weak cache, while cue
  // candidates remain live because React virtualisation replaces those rows.
  // WeakMap avoids retaining detached SPA panel roots.
  const structureCache = new WeakMap();

  function normalizeText(value) {
    return modelApi()?.normalizeSearchText?.(value) || String(value || "").trim().toLowerCase();
  }

  function isEditorContext(panelRoot) {
    if (!panelRoot) return true;
    if (panelRoot.closest?.('[contenteditable="true"], [data-test-component="TranscriptEditor"]')) return true;
    const href = String(panelRoot.ownerDocument?.location?.href || "");
    return /transcript[-_ ]?editor|editor[-_ ]?transcript/i.test(href);
  }

  function isViewerPanel(panelRoot) {
    if (!panelRoot || isEditorContext(panelRoot)) return false;
    if (panelRoot.id !== "transcripts-panel") return false;
    if (panelRoot.getAttribute("role") !== "tabpanel") return false;
    if (panelRoot.getAttribute("aria-labelledby") && panelRoot.getAttribute("aria-labelledby") !== "transcripts-tab") {
      return false;
    }
    // A real viewer panel has both the transcript list and the stable search
    // container.  Requiring these semantics prevents accidental injection into
    // a similarly named editor or a legacy page with unverified markup.
    return !!panelRoot.querySelector(LIST_SELECTOR) &&
      !!panelRoot.querySelector(SEARCH_SELECTOR);
  }

  function getPanelStructure(panelRoot) {
    if (!panelRoot?.querySelector) return null;
    const cached = structureCache.get(panelRoot);
    if (cached &&
      cached.searchInput?.isConnected && panelRoot.contains(cached.searchInput) &&
      cached.listHost?.isConnected && panelRoot.contains(cached.listHost) &&
      cached.rowGroup?.isConnected && cached.listHost.contains(cached.rowGroup) &&
      cached.searchContainer?.isConnected && panelRoot.contains(cached.searchContainer) &&
      cached.searchInput.matches?.(SEARCH_SELECTOR) &&
      cached.listHost.matches?.(LIST_SELECTOR) &&
      cached.searchContainer.matches?.('[data-test-id="search-transcripts"]') &&
      (!cached.hasRowGroup || cached.rowGroup.matches?.(ROWGROUP_SELECTOR)) &&
      panelRoot.id === "transcripts-panel" &&
      panelRoot.getAttribute("role") === "tabpanel" &&
      !isEditorContext(panelRoot) &&
      (!panelRoot.getAttribute("aria-labelledby") || panelRoot.getAttribute("aria-labelledby") === "transcripts-tab") &&
      (cached.hasRowGroup || !cached.listHost.querySelector(ROWGROUP_SELECTOR))) {
      return cached;
    }
    if (!isViewerPanel(panelRoot)) {
      structureCache.delete(panelRoot);
      return null;
    }
    const searchInput = panelRoot.querySelector(SEARCH_SELECTOR);
    const searchContainer = panelRoot.querySelector('#search-transcripts[data-test-id="search-transcripts"]') ||
      searchInput?.closest?.('[data-test-id="search-transcripts"]') || null;
    const listHost = panelRoot.querySelector(LIST_SELECTOR);
    const rowGroup = listHost?.querySelector?.(ROWGROUP_SELECTOR) || listHost || null;
    const hasRowGroup = rowGroup !== listHost;
    if (!searchInput || String(searchInput.tagName).toLowerCase() !== "input" || !searchContainer || !listHost || !rowGroup) {
      structureCache.delete(panelRoot);
      return null;
    }
    const structure = { root: panelRoot, searchInput, searchContainer, listHost, rowGroup, hasRowGroup };
    structureCache.set(panelRoot, structure);
    return structure;
  }

  function findPanelRoots(root = document) {
    const scope = root?.querySelectorAll ? root : document;
    const own = scope.matches?.(PANEL_SELECTOR) ? [scope] : [];
    const seen = new Set();
    return [...own, ...Array.from(scope.querySelectorAll(PANEL_SELECTOR))]
      .filter((panel) => {
        if (seen.has(panel)) return false;
        seen.add(panel);
        return true;
      })
      .filter(isViewerPanel);
  }

  function findSearchInput(panelRoot) {
    const structure = getPanelStructure(panelRoot);
    return structure?.searchInput || null;
  }

  function findSearchContainer(panelRoot) {
    return getPanelStructure(panelRoot)?.searchContainer || null;
  }

  function findScrollContainer(panelRoot) {
    const list = getPanelStructure(panelRoot)?.listHost;
    if (!list || !list.matches(LIST_SELECTOR)) return null;
    // The List host owns the actual overflow/scroll position.  Keep the
    // rowgroup separate for cue enumeration and absolute-row lookup.
    return list;
  }

  function findRowGroup(panelRoot) {
    return getPanelStructure(panelRoot)?.rowGroup || null;
  }

  function findListHost(panelRoot) {
    const list = getPanelStructure(panelRoot)?.listHost;
    if (!list || !list.matches(LIST_SELECTOR)) return null;
    return list;
  }

  function findCueCandidates(panelRoot) {
    const rowgroup = getPanelStructure(panelRoot)?.rowGroup;
    if (!rowgroup?.querySelectorAll) return [];
    return Array.from(rowgroup.querySelectorAll(CUE_SELECTOR)).filter((candidate) => {
      const content = candidate.closest?.('[data-test-component="Content"]');
      return content === candidate && candidate.title && /\s(?:min|sec)$/i.test(candidate.title);
    });
  }

  function ownTranslationNodes(candidate) {
    return Array.from(candidate?.querySelectorAll?.('[data-echo360-transcript-translation="1"]') || []);
  }

  function extractCueText(candidate) {
    if (!candidate) return "";
    // Walk text nodes in place instead of cloning/replacing Echo's English DOM.
    // Search highlighting may split one cue into several sibling spans; the
    // walker naturally joins those pieces while excluding our own translation.
    const parts = [];
    const walker = (candidate.ownerDocument || document).createTreeWalker(candidate, 4);
    let node = walker.nextNode();
    while (node) {
      if (!node.parentElement?.closest?.('[data-echo360-transcript-translation="1"]')) {
        parts.push(node.nodeValue || "");
      }
      node = walker.nextNode();
    }
    return parts.join("").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/\s+/g, " ").trim();
  }

  function findClickableCue(candidate) {
    if (!candidate || !candidate.matches?.('[data-test-component="Content"]')) return null;
    const originalText = extractCueText(candidate);
    const clickable = Array.from(candidate.querySelectorAll?.('span[role="button"]') || [])
      .filter((node) => node !== candidate)
      .find((node) => normalizeText(node.textContent) === normalizeText(originalText));
    // The verified new-player DOM puts the native React click handler on the
    // single role=button span inside Content.  Only use it when it contains
    // the complete English cue; split search-highlight spans must fall back to
    // Content rather than moving the translation into the middle of the cue.
    return clickable || candidate;
  }

  function findTranslationMount(candidate) {
    if (!candidate) return null;
    // Keep the extension node as a sibling of Echo's React-owned clickable
    // span.  React is allowed to reconcile that span's children without ever
    // seeing or inheriting our Chinese text; the renderer uses
    // findClickableCue() as a guarded click-proxy target when necessary.
    return candidate;
  }

  function findRowWrapper(candidate, panelRoot) {
    const rowgroup = findRowGroup(panelRoot);
    if (!candidate || !rowgroup) return null;
    let node = candidate.parentElement;
    while (node && node !== rowgroup) {
      if (node.parentElement === rowgroup) {
        const style = node.style || {};
        const position = style.position || "";
        const hasTop = style.top !== "" || node.hasAttribute("data-top");
        const hasHeight = style.height !== "" || node.hasAttribute("data-height");
        if (position === "absolute" && hasTop && hasHeight) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function parseCueTimeTitle(title) {
    const match = String(title || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+(min|sec)$/i);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return null;
    return Math.round(value * (match[2].toLowerCase() === "min" ? 60000 : 1000));
  }

  // Historical API name retained for integrations; Echo's first minute uses
  // `sec`, while later cues use `min`.
  const parseCueMinuteTitle = parseCueTimeTitle;

  function extractCueApproxStartMs(candidate) {
    return parseCueMinuteTitle(candidate?.getAttribute?.("title") || candidate?.title || "");
  }

  function hasVirtualizedLayout(panelRoot) {
    const list = getPanelStructure(panelRoot)?.listHost;
    return !!(list && list.classList.contains("ReactVirtualized__Grid") &&
      list.classList.contains("ReactVirtualized__List") &&
      getPanelStructure(panelRoot)?.hasRowGroup);
  }

  function getPanelDescriptor(panelRoot) {
    const structure = getPanelStructure(panelRoot);
    if (!structure) return null;
    return {
      root: panelRoot,
      token: panelRoot.getAttribute("data-echo360-transcript-panel-token") || "",
      searchInput: structure.searchInput,
      searchContainer: structure.searchContainer,
      listHost: structure.listHost,
      scrollContainer: structure.listHost,
      rowGroup: structure.rowGroup,
      virtualized: hasVirtualizedLayout(panelRoot),
      cueCandidates: findCueCandidates(panelRoot),
    };
  }

  ns.transcriptPanelAdapter = {
    name: "new-player-v1",
    PANEL_SELECTOR,
    SEARCH_SELECTOR,
    LIST_SELECTOR,
    ROWGROUP_SELECTOR,
    CUE_SELECTOR,
    findPanelRoots,
    findSearchInput,
    findSearchContainer,
    findScrollContainer,
    findRowGroup,
    findListHost,
    findCueCandidates,
    extractCueText,
    findClickableCue,
    findTranslationMount,
    findRowWrapper,
    parseCueTimeTitle,
    parseCueMinuteTitle,
    extractCueApproxStartMs,
    extractCueTime: extractCueApproxStartMs,
    hasVirtualizedLayout,
    isViewerPanel,
    getPanelDescriptor,
    // Kept explicit for diagnostics/hidden tests: no legacy selector guesses
    // are made until a real legacy fixture is available.
    supportsLegacy: () => false,
    normalizeText: (value) => modelApi()?.normalizeSearchText?.(value) || String(value || "").trim().toLowerCase(),
    invalidate: (panelRoot) => {
      if (panelRoot) structureCache.delete(panelRoot);
    },
  };
})();
