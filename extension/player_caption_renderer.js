(() => {
  const ns = window.Echo360Translator;

  const OVERLAY_ATTR = "data-echo360-instructure-caption";
  const LINE_ATTR = "data-echo360-instructure-caption-line";
  const SIZE_MAP = { small: "0.88em", medium: "1em", large: "1.14em" };
  const DEFAULT_BOTTOM_PADDING = "calc(var(--media-controls-height, 48px) + 2%)";
  const NATIVE_CAPTION_GAP_PX = 8;

  let state = null;

  function parseTime(value) {
    const match = String(value || "").trim().match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
    if (!match) return NaN;
    return (
      Number(match[1] || 0) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / 1000
    );
  }

  function cleanCueText(text) {
    return ns.vtt.cueTextToLine(text)
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildCues(originalVtt, translatedVtt) {
    const original = ns.vtt.parseVttBlocks(originalVtt);
    const translated = ns.vtt.parseVttBlocks(translatedVtt);
    const count = Math.min(original.length, translated.length);
    const cues = [];
    for (let index = 0; index < count; index += 1) {
      const [startText, endText] = String(original[index].time || "").split("-->");
      const start = parseTime(startText);
      const end = parseTime(endText);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const originalText = cleanCueText(original[index].text);
      const translatedText = cleanCueText(translated[index].text);
      if (!originalText && !translatedText) continue;
      cues.push({ start, end, original: originalText, translated: translatedText });
    }
    // The binary lookup below requires start-time ordering. Most VTT files
    // already satisfy this, but sorting here keeps the custom renderer
    // correct for valid out-of-order or overlapping cue lists as well.
    return cues.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  function buildMaxEndPrefix(cues) {
    let maxEnd = -Infinity;
    return cues.map((cue) => {
      maxEnd = Math.max(maxEnd, cue.end);
      return maxEnd;
    });
  }

  function isSupportedVideo(video) {
    return !!(
      ns.hostSupport?.isInstructureVideo?.(video) ||
      video?.closest?.("[data-media-player]")
    );
  }

  function findSurface(video) {
    return ns.hostSupport?.getCaptionSurface?.(video) ||
      video?.closest?.("[data-media-player]")?.querySelector?.('[data-part="captions"]') ||
      null;
  }

  function findPlayer(video) {
    return ns.hostSupport?.getPlayer?.(video) ||
      video?.closest?.("[data-media-player]") ||
      null;
  }

  function findCueIndex(time) {
    if (!state?.cues.length) return -1;
    const previous = state.currentCueIndex;
    if (previous >= 0) {
      const cue = state.cues[previous];
      // WebVTT cue intervals are end-exclusive. At a shared boundary, the
      // next cue must replace the previous cue instead of lagging one frame.
      if (time >= cue.start && time < cue.end) return previous;
    }
    let low = 0;
    let high = state.cues.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (state.cues[middle].start <= time) low = middle + 1;
      else high = middle - 1;
    }
    if (high < 0) return -1;
    // The latest-starting cue may already have ended while an earlier,
    // overlapping cue is still active. Walk back only while the prefix says
    // an active cue can still exist; ordinary gaps remain O(log n).
    for (let index = high; index >= 0 && state.maxEndThroughIndex[index] > time; index -= 1) {
      const cue = state.cues[index];
      if (time >= cue.start && time < cue.end) return index;
    }
    return -1;
  }

  function isElementVisiblyRendered(element) {
    if (!element?.isConnected || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    try {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" ||
        (style.opacity !== "" && Number(style.opacity) === 0)) return false;
    } catch (_) {}
    const rect = element.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function nativeCaptionTop(surface, player) {
    if (!isElementVisiblyRendered(surface)) return null;
    const playerRect = player?.getBoundingClientRect?.();
    if (!playerRect || playerRect.height <= 0) return null;
    // Vidstack's captions surface commonly covers the entire player, so its
    // own rectangle cannot identify the visible cue box. Prefer known cue
    // parts, then visibly rendered leaf nodes for older player versions.
    const preferred = Array.from(surface.querySelectorAll?.(
      '[data-part="cue"], [data-part="cue-display"], [data-part="cue-box"], [data-part="caption-cue"]'
    ) || []);
    const candidates = preferred.length > 0
      ? preferred
      : Array.from(surface.querySelectorAll?.("*") || []).filter((node) => node.childElementCount === 0);
    const tops = candidates
      .filter(isElementVisiblyRendered)
      .map((node) => node.getBoundingClientRect().top)
      .filter((top) => Number.isFinite(top) && top >= playerRect.top && top <= playerRect.bottom);
    return tops.length > 0 ? Math.min(...tops) : null;
  }

  function styleOverlay(overlay, player, surface) {
    overlay.style.display = "flex";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.zIndex = "20";
    overlay.style.flexDirection = "column";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "flex-end";
    overlay.style.width = "100%";
    overlay.style.maxWidth = "100%";
    overlay.style.margin = "0 auto";
    // Keep the independent overlay above the transport controls. It must be
    // a sibling of Vidstack's native captions surface: that surface is often
    // display:none/aria-hidden while the CC toggle is off, which would make
    // any child translation invisible as well.
    const nativeTop = state?.nativeInjection ? null : nativeCaptionTop(surface, player);
    const playerRect = nativeTop == null ? null : player?.getBoundingClientRect?.();
    const nativeOffset = playerRect && Number.isFinite(playerRect.bottom)
      ? Math.max(0, Math.ceil(playerRect.bottom - nativeTop + NATIVE_CAPTION_GAP_PX))
      : 0;
    overlay.style.paddingTop = "0";
    overlay.style.paddingRight = "0.35em";
    overlay.style.paddingBottom = nativeOffset > 0 ? `${nativeOffset}px` : DEFAULT_BOTTOM_PADDING;
    overlay.style.paddingLeft = "0.35em";
    overlay.style.boxSizing = "border-box";
    overlay.style.pointerEvents = "none";
    overlay.style.textAlign = "center";
    overlay.style.whiteSpace = "pre-wrap";
    overlay.style.overflowWrap = "anywhere";
    overlay.style.fontSize = SIZE_MAP[state?.size] || SIZE_MAP.medium;
    overlay.style.lineHeight = "1.3";
    overlay.style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.9), 0 0 4px rgba(0, 0, 0, 0.75)";
  }

  function restoreNativeCaptionSurface(surface) {
    if (!surface || !state?.surfaceVisibility?.has(surface)) return;
    const previous = state.surfaceVisibility.get(surface);
    if (previous.value) surface.style.setProperty("visibility", previous.value, previous.priority);
    else surface.style.removeProperty("visibility");
    state.surfaceVisibility.delete(surface);
  }

  function restorePlayerPosition(player) {
    if (!player || !state?.playerPositions?.has(player)) return;
    const previous = state.playerPositions.get(player);
    if (previous.value) player.style.setProperty("position", previous.value, previous.priority);
    else player.style.removeProperty("position");
    state.playerPositions.delete(player);
  }

  function ensurePositionedPlayer(player) {
    if (!player || state.playerPositions.has(player)) return;
    let computedPosition = "";
    try { computedPosition = getComputedStyle(player).position; } catch (_) {}
    if (computedPosition && computedPosition !== "static") return;
    state.playerPositions.set(player, {
      value: player.style.getPropertyValue("position"),
      priority: player.style.getPropertyPriority("position"),
    });
    player.style.setProperty("position", "relative");
  }

  function hideNativeCaptionSurface(surface) {
    if (!surface) return;
    if (!state.surfaceVisibility.has(surface)) {
      state.surfaceVisibility.set(surface, {
        value: surface.style.getPropertyValue("visibility"),
        priority: surface.style.getPropertyPriority("visibility"),
      });
    }
    surface.style.setProperty("visibility", "hidden", "important");
  }

  function ensureOverlay() {
    if (!state) return null;
    const player = state.player?.isConnected ? state.player : findPlayer(state.video);
    if (!player) return null;
    if (state.player !== player) {
      state.observer?.disconnect();
      state.overlay?.remove();
      restorePlayerPosition(state.player);
      state.player = player;
      state.observer?.observe(player, { childList: true, characterData: true, subtree: true });
    }
    ensurePositionedPlayer(player);
    const surface = state.surface?.isConnected ? state.surface : findSurface(state.video);
    if (state.surface !== surface) {
      restoreNativeCaptionSurface(state.surface);
      state.surface = surface;
    }
    if (state.nativeInjection) hideNativeCaptionSurface(surface);
    else restoreNativeCaptionSurface(surface);
    let overlay = state.overlay?.isConnected && state.overlay.parentElement === player
      ? state.overlay
      : player.querySelector(`:scope > [${OVERLAY_ATTR}="1"]`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute(OVERLAY_ATTR, "1");
      player.appendChild(overlay);
    }
    styleOverlay(overlay, player, surface);
    state.overlay = overlay;
    return overlay;
  }

  function lineElement(kind, text) {
    const line = document.createElement("span");
    line.setAttribute(LINE_ATTR, kind);
    line.textContent = text || "";
    line.style.display = "block";
    line.style.maxWidth = "100%";
    line.style.font = "inherit";
    line.style.lineHeight = "inherit";
    line.style.color = "#fff";
    line.style.background = "rgba(0, 0, 0, 0.72)";
    line.style.borderRadius = "0.12em";
    line.style.padding = "0.06em 0.34em";
    line.style.whiteSpace = "pre-wrap";
    if (kind === "original") line.style.opacity = "0.88";
    return line;
  }

  function render() {
    if (!state) return;
    if (!state.visible) {
      // Disabling extension subtitles must also give Vidstack's own captions
      // back to the user. Keeping the native surface hidden here would make
      // the extension's visibility toggle disable both subtitle systems.
      for (const surface of Array.from(state.surfaceVisibility.keys())) {
        restoreNativeCaptionSurface(surface);
      }
      if (state.overlay) {
        state.overlay.hidden = true;
        state.overlay.replaceChildren();
      }
      return;
    }
    const overlay = ensureOverlay();
    if (!overlay) return;
    const index = findCueIndex(Number(state.video.currentTime || 0));
    const cue = index >= 0 ? state.cues[index] : null;
    state.currentCueIndex = index;
    if (!cue) {
      overlay.hidden = true;
      overlay.replaceChildren();
      return;
    }

    const lines = [];
    // When Vidstack is already showing the original CC, keep the extension
    // layer translation-only so bilingual mode does not duplicate the same
    // English line. If native CC is off, the user's bilingual preference still
    // works entirely inside the independent overlay.
    const nativeOriginalVisible = !state.nativeInjection &&
      nativeCaptionTop(state.surface, state.player) != null;
    if (state.bilingual && !nativeOriginalVisible) {
      const ordered = state.reverseOrder
        ? [["original", cue.original], ["translated", cue.translated]]
        : [["translated", cue.translated], ["original", cue.original]];
      for (const [kind, text] of ordered) if (text) lines.push(lineElement(kind, text));
    } else if (cue.translated) {
      lines.push(lineElement("translated", cue.translated));
    }
    overlay.replaceChildren(...lines);
    overlay.hidden = lines.length === 0;
  }

  function isOwnMutation(record) {
    const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
    if (target?.closest?.(`[${OVERLAY_ATTR}="1"]`)) return true;
    const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && (
      node.matches?.(`[${OVERLAY_ATTR}="1"], [${LINE_ATTR}]`) ||
      node.closest?.(`[${OVERLAY_ATTR}="1"]`)
    ));
  }

  function scheduleVideoFrame() {
    if (!state || typeof state.video.requestVideoFrameCallback !== "function") return;
    state.frameHandle = state.video.requestVideoFrameCallback(() => {
      if (!state) return;
      render();
      scheduleVideoFrame();
    });
  }

  function update({ video, originalVtt, translatedVtt, size, bilingual, reverseOrder, nativeInjection } = {}) {
    if (!state) return false;
    // Incremental updates can race with a SPA replacing the player. Never
    // report success after updating the detached video; the orchestrator will
    // unmount this stale state and mount again on the new video.
    if ((video && video !== state.video) || !state.video?.isConnected || !findPlayer(state.video)?.isConnected) {
      return false;
    }
    const cues = buildCues(originalVtt, translatedVtt);
    if (cues.length === 0) return false;
    state.cues = cues;
    state.maxEndThroughIndex = buildMaxEndPrefix(cues);
    if (size) state.size = SIZE_MAP[size] ? size : "medium";
    if (bilingual !== undefined) state.bilingual = !!bilingual;
    if (reverseOrder !== undefined) state.reverseOrder = !!reverseOrder;
    if (nativeInjection !== undefined) state.nativeInjection = !!nativeInjection;
    state.currentCueIndex = -1;
    render();
    return true;
  }

  function mount({ video, originalVtt, translatedVtt, size, bilingual = false, reverseOrder = false, nativeInjection = false }) {
    if (!isSupportedVideo(video)) return false;
    const player = findPlayer(video);
    const surface = findSurface(video);
    const cues = buildCues(originalVtt, translatedVtt);
    // The native captions element is lazy on some Vidstack builds. The
    // extension-owned overlay only needs the stable player root, so mounting
    // must not falsely fall back to an ignored HTML <track> while that native
    // element has not appeared yet.
    if (!player || cues.length === 0) return false;

    unmount();
    state = {
      video,
      player,
      surface,
      cues,
      maxEndThroughIndex: buildMaxEndPrefix(cues),
      size: SIZE_MAP[size] ? size : "medium",
      bilingual: !!bilingual,
      reverseOrder: !!reverseOrder,
      nativeInjection: !!nativeInjection,
      visible: true,
      currentCueIndex: -1,
      overlay: null,
      listeners: [],
      observer: null,
      frameHandle: null,
      handlingMutation: false,
      surfaceVisibility: new Map(),
      playerPositions: new Map(),
    };

    for (const eventName of ["timeupdate", "seeked", "play", "pause", "loadedmetadata"]) {
      video.addEventListener(eventName, render);
      state.listeners.push([eventName, render]);
    }
    state.observer = new MutationObserver((records) => {
      if (!state || state.handlingMutation || records.length === 0 || records.every(isOwnMutation)) return;
      state.handlingMutation = true;
      try { render(); } finally { state.handlingMutation = false; }
    });
    state.observer.observe(player, { childList: true, characterData: true, subtree: true });
    render();
    scheduleVideoFrame();
    console.info("[echo360-translator] mounted Instructure Media captions overlay", { cueCount: cues.length });
    return true;
  }

  function setVisible(visible) {
    if (!state) return;
    state.visible = !!visible;
    render();
  }

  function applySize(size) {
    if (!state) return;
    state.size = SIZE_MAP[size] ? size : "medium";
    render();
  }

  function ensureMounted() {
    if (!state) return false;
    if (!state.video?.isConnected || !findPlayer(state.video)?.isConnected) {
      unmount();
      return false;
    }
    const overlay = ensureOverlay();
    render();
    return !!overlay?.isConnected;
  }

  function isMounted() {
    return !!state;
  }

  function unmount() {
    if (!state) return;
    for (const [eventName, listener] of state.listeners) state.video.removeEventListener(eventName, listener);
    if (state.frameHandle !== null && typeof state.video.cancelVideoFrameCallback === "function") {
      state.video.cancelVideoFrameCallback(state.frameHandle);
    }
    state.observer?.disconnect();
    for (const surface of Array.from(state.surfaceVisibility.keys())) {
      restoreNativeCaptionSurface(surface);
    }
    for (const player of Array.from(state.playerPositions.keys())) {
      restorePlayerPosition(player);
    }
    state.overlay?.remove();
    state = null;
  }

  function getDebugState() {
    if (!state) return { mounted: false };
    return {
      mounted: true,
      cueCount: state.cues.length,
      currentCueIndex: state.currentCueIndex,
      visible: state.visible,
      bilingual: state.bilingual,
      nativeInjection: state.nativeInjection,
      surfaceAttached: !!state.surface?.isConnected,
      overlayAttached: !!state.overlay?.isConnected,
    };
  }

  ns.playerCaptionRenderer = {
    isSupportedVideo,
    mount,
    update,
    setVisible,
    applySize,
    ensureMounted,
    isMounted,
    unmount,
    getDebugState,
  };
})();
