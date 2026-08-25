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

  function findPanelRoots(root = document) {
    const scope = root?.querySelectorAll ? root : document;
    const own = scope.matches?.(PANEL_SELECTOR) ? [scope] : [];
    return [...own, ...Array.from(scope.querySelectorAll(PANEL_SELECTOR))]
      .filter((panel, index, all) => all.indexOf(panel) === index)
      .filter(isViewerPanel);
  }

  function findSearchInput(panelRoot) {
    if (!panelRoot?.querySelector) return null;
    const input = panelRoot.querySelector(SEARCH_SELECTOR);
    if (!input || String(input.tagName).toLowerCase() !== "input") return null;
    return input;
  }

  function findSearchContainer(panelRoot) {
    return panelRoot?.querySelector?.('#search-transcripts[data-test-id="search-transcripts"]') ||
      findSearchInput(panelRoot)?.closest?.("[data-test-id=search-transcripts]") || null;
  }

  function findScrollContainer(panelRoot) {
    if (!panelRoot?.querySelector) return null;
    const list = panelRoot.querySelector(LIST_SELECTOR);
    if (!list || !list.matches(LIST_SELECTOR)) return null;
    // The List host owns the actual overflow/scroll position.  Keep the
    // rowgroup separate for cue enumeration and absolute-row lookup.
    return list;
  }

  function findRowGroup(panelRoot) {
    const list = findScrollContainer(panelRoot);
    return list?.querySelector?.(ROWGROUP_SELECTOR) || list || null;
  }

  function findListHost(panelRoot) {
    if (!panelRoot?.querySelector) return null;
    const list = panelRoot.querySelector(LIST_SELECTOR);
    if (!list || !list.matches(LIST_SELECTOR)) return null;
    return list;
  }

  function findCueCandidates(panelRoot) {
    const rowgroup = findRowGroup(panelRoot);
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
    const list = findListHost(panelRoot);
    return !!(list && list.classList.contains("ReactVirtualized__Grid") &&
      list.classList.contains("ReactVirtualized__List") &&
      list.querySelector(ROWGROUP_SELECTOR));
  }

  function getPanelDescriptor(panelRoot) {
    if (!isViewerPanel(panelRoot)) return null;
    return {
      root: panelRoot,
      token: panelRoot.getAttribute("data-echo360-transcript-panel-token") || "",
      searchInput: findSearchInput(panelRoot),
      searchContainer: findSearchContainer(panelRoot),
      listHost: findListHost(panelRoot),
      scrollContainer: findScrollContainer(panelRoot),
      rowGroup: findRowGroup(panelRoot),
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
  };
})();
