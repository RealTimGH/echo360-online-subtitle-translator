(() => {
  const ns = window.Echo360Translator;

  const OVERLAY_ATTR = "data-echo360-echo-caption";
  const LINE_ATTR = "data-echo360-echo-caption-line";
  const STACK_ATTR = "data-echo360-echo-caption-stack";
  const SIZE_MAP = { small: 0.88, medium: 1, large: 1.14 };
  const CAPTION_GAP_PX = 6;
  const LAYOUT_REFRESH_MS = 900;
  const LAYOUT_REFRESH_INTERVAL_MS = 100;
  const MUTATION_OPTIONS = {
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-pressed", "aria-checked",
      "data-state", "data-active", "data-enabled"],
    childList: true,
    characterData: true,
    subtree: true,
  };

  let state = null;

  function parseTime(value) {
    const parts = String(value || "").trim().split(/\s+/)[0].split(":");
    if (parts.length !== 2 && parts.length !== 3) return NaN;
    const seconds = Number(parts[parts.length - 1]);
    const minutes = Number(parts[parts.length - 2]);
    const hours = parts.length === 3 ? Number(parts[0]) : 0;
    if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function cleanCueText(text) {
    return ns.vtt.cueTextToLine(text)
      .replace(/<v(?:\s+[^>]*)?>/gi, "")
      .replace(/<\/v>/gi, "")
      .replace(/<[^>]+>/g, "")
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
    return cues.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  function buildMaxEndPrefix(cues) {
    let maxEnd = -Infinity;
    return cues.map((cue) => {
      maxEnd = Math.max(maxEnd, cue.end);
      return maxEnd;
    });
  }

  function findCueIndex(time) {
    if (!state?.cues.length) return -1;
    const previous = state.currentCueIndex;
    if (previous >= 0) {
      const cue = state.cues[previous];
      if (time >= cue.start && time < cue.end &&
        (!state.cues[previous + 1] || state.cues[previous + 1].start > time)) return previous;
    }
    let low = 0;
    let high = state.cues.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (state.cues[middle].start <= time) low = middle + 1;
      else high = middle - 1;
    }
    for (let index = high; index >= 0 && state.maxEndThroughIndex[index] > time; index -= 1) {
      const cue = state.cues[index];
      if (time >= cue.start && time < cue.end) return index;
    }
    return -1;
  }

  function findPlayer(video) {
    return video?.closest?.("#player") ||
      (ns.hostSupport?.isEcho360Document?.() ? document.querySelector("#player") : null);
  }

  function isSupportedVideo(video) {
    return !!(ns.hostSupport?.isEcho360Document?.() && findPlayer(video));
  }

  function isVisible(element) {
    if (!element?.isConnected || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    let style;
    try { style = getComputedStyle(element); } catch (_) { return false; }
    if (style.display === "none" || style.visibility === "hidden" ||
      (style.opacity !== "" && Number(style.opacity) === 0)) return false;
    const rect = element.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function normalizeForMatch(text) {
    return cleanCueText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
  }

  function matchScore(text, expected) {
    const actual = normalizeForMatch(text);
    const target = normalizeForMatch(expected);
    if (!actual || !target) return 0;
    if (actual === target) return 1000 + target.length;
    if (actual.includes(target) || target.includes(actual)) return 700 + Math.min(actual.length, target.length);
    const words = normalizeForMatch(expected).match(/[\p{L}\p{N}]{2,}/gu) || [];
    const hits = words.filter((word) => actual.includes(word)).length;
    return hits ? 300 + hits * 20 : 0;
  }

  function mediaBounds(player) {
    const videos = queryElementsDeep(player, "video")
      .map((video) => video.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (videos.length === 0) {
      const rect = player.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    }
    const top = Math.min(...videos.map((rect) => rect.top));
    const bottom = Math.max(...videos.map((rect) => rect.bottom));
    const left = Math.min(...videos.map((rect) => rect.left));
    const right = Math.max(...videos.map((rect) => rect.right));
    return {
      top,
      bottom,
      left,
      right,
      width: right - left,
      height: bottom - top,
    };
  }

  // Echo360's player has used both light-DOM nodes and open shadow roots for
  // controls/captions across its player revisions.  Keep the traversal local
  // to the player; walking the whole document on every cue would be needlessly
  // expensive on Canvas pages containing several embeds.
  function queryElementsDeep(root, selector) {
    const cacheable = state?.player === root;
    if (cacheable) {
      if (state.deepQueryCacheDirty) {
        state.deepQueryCache.clear();
        state.deepQueryCacheDirty = false;
      }
      const cached = state.deepQueryCache.get(selector);
      if (cached) return cached;
    }
    const result = [];
    const shadowRoots = new Set();
    const seen = new Set();
    const visit = (container) => {
      const descendants = Array.from(container?.querySelectorAll?.("*") || []);
      for (const element of descendants) {
        if (element.matches?.(selector) && !seen.has(element)) {
          seen.add(element);
          result.push(element);
        }
        // A shadow host is not necessarily itself a match for `selector`.
        // Traverse every host so a caption toggle or cue in an open shadow
        // root is not mistaken for “not present”.
        if (element.shadowRoot) {
          shadowRoots.add(element.shadowRoot);
          visit(element.shadowRoot);
        }
      }
    };
    visit(root);
    if (cacheable) {
      // Observers do not cross shadow boundaries. Subscribe once per live root,
      // and release detached roots instead of retaining old player subtrees.
      if ([...state.observedShadowRoots].some((root) => !shadowRoots.has(root))) {
        state.observer?.disconnect();
        state.observer?.observe(root, MUTATION_OPTIONS);
        state.observedShadowRoots.clear();
      }
      for (const shadowRoot of shadowRoots) {
        if (!state.observedShadowRoots.has(shadowRoot)) {
          state.observer?.observe(shadowRoot, MUTATION_OPTIONS);
          state.observedShadowRoots.add(shadowRoot);
        }
      }
      state.deepQueryCache.set(selector, result);
    }
    return result;
  }

  function captionToggleState(player, video) {
    // The Echo360 player exposes its CC state on the toggle button in the
    // normal DOM. Prefer that explicit state over guessing from the presence
    // of a cue node, because the cue node is intentionally lazy.
    const controls = queryElementsDeep(
      player,
      "button,[role=button],[aria-label],[title],[data-testid]"
    );
    for (const element of controls) {
      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
        element.textContent,
        String(element.className || ""),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!/(?:caption|subtitle|closed.?caption|\bcc\b)/.test(label)) continue;
      const pressed = element.getAttribute("aria-pressed");
      if (pressed === "true" || pressed === "false") return pressed === "true";
      const checked = element.getAttribute("aria-checked");
      if (checked === "true" || checked === "false") return checked === "true";
      const stateValue = [
        element.getAttribute("data-state"),
        element.getAttribute("data-active"),
        element.getAttribute("data-enabled"),
      ].find((value) => value != null);
      if (stateValue != null) {
        if (/^(?:on|true|active|showing|enabled)$/i.test(stateValue)) return true;
        if (/^(?:off|false|inactive|hidden|disabled)$/i.test(stateValue)) return false;
      }
      const className = String(element.className || "");
      if (/(?:^|[-_\s])(active|selected|checked|on)(?:$|[-_\s])/i.test(className)) return true;
    }

    for (const track of Array.from(video?.textTracks || [])) {
      if (String(track.label || "").includes("翻译")) continue;
      if (track.mode === "showing") return true;
      if (track.mode === "disabled") return false;
    }
    return null;
  }

  function findControls(player) {
    if (!player) return null;
    const playerRect = player.getBoundingClientRect?.();
    if (!playerRect || playerRect.width <= 0 || playerRect.height <= 0) return null;
    const explicit = queryElementsDeep(player,
      '[data-part="controls"], [data-media-controls], media-controls, '
        + '[class*="control-bar"], [class*="controls"], [class*="ControlBar"]');
    const controls = queryElementsDeep(player, 'button,[role="button"],input[type="range"]');
    const candidates = new Map();

    const add = (element, sourceWeight = 0) => {
      // A toolbar ancestor can be the whole player (especially while the
      // actual controls are hidden). It must not exclude every native cue or
      // become the fallback baseline just because it contains a CC button.
      if (!element || element === player || element.contains?.(state.video) || candidates.has(element)) return;
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (rect.right < playerRect.left || rect.left > playerRect.right) return;
      if (rect.bottom < playerRect.top || rect.top > playerRect.bottom + 96) return;
      const nearBottom = rect.top >= playerRect.top + playerRect.height * 0.5 ||
        rect.bottom >= playerRect.bottom - 32;
      if (!nearBottom && sourceWeight === 0) return;
      const widthRatio = Math.min(1.5, rect.width / Math.max(1, playerRect.width));
      const heightPenalty = rect.height > Math.max(120, playerRect.height * 0.35) ? 80 : 0;
      const score = sourceWeight + widthRatio * 100 + Math.min(40,
        Math.max(0, rect.top - playerRect.top) / Math.max(1, playerRect.height) * 40)
        - heightPenalty;
      candidates.set(element, { rect, score });
    };

    explicit.forEach((element) => add(element, 80));
    for (const control of controls) {
      let element = control;
      for (let depth = 0; element && depth < 7; depth += 1, element = element.parentElement) {
        add(element, 30);
        if (element === player) break;
      }
    }
    return [...candidates.values()].sort((left, right) => right.score - left.score)[0]?.rect || null;
  }

  function cachedNativeCaptionMatches(element, cue) {
    if (!element?.isConnected || element === state.overlay ||
      element.closest?.(`[${OVERLAY_ATTR}="1"], #echo360-ui-root`)) return false;
    const tag = String(element.tagName || "").toLowerCase();
    if (["button", "input", "select", "textarea", "svg"].includes(tag)) return false;
    const text = String(element.textContent || "").trim();
    if (!text || text.length > 500 || matchScore(text, cue?.original || "") <= 0) return false;
    const classText = `${element.id || ""} ${String(element.className || "")} `
      + `${element.getAttribute?.("part") || ""} ${element.getAttribute?.("data-part") || ""}`;
    if (/(?:control|timeline|volume|settings|bookmark|transcript|fullscreen)/i.test(classText)) return false;
    const rect = element.getBoundingClientRect?.();
    const playerRect = state.player.getBoundingClientRect?.();
    if (!rect || !playerRect || rect.width <= 0 || rect.height < 8 ||
      rect.top < playerRect.top - 8 || rect.bottom > playerRect.bottom + 8 ||
      rect.right < playerRect.left || rect.left > playerRect.right) return false;
    return isVisible(element);
  }

  function mutationMayAffectNativeCaption(record, cue) {
    const anchor = state.nativeCaption;
    const target = record.target?.nodeType === Node.TEXT_NODE
      ? record.target.parentElement
      : record.target;
    if (anchor && (target === anchor || anchor.contains?.(target))) return true;
    const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])];
    return nodes.some((node) => {
      if (node === anchor || node.contains?.(anchor) || anchor?.contains?.(node)) return true;
      const text = node.nodeType === Node.TEXT_NODE ? node.textContent : node.textContent;
      return matchScore(text || "", cue?.original || "") > 0;
    }) || (!anchor && matchScore(target?.textContent || "", cue?.original || "") > 0);
  }

  function findNativeCaption(cue, captionState) {
    if (!state?.player) return null;
    // When Echo's CC control is explicitly off there should be no attempt to
    // infer a native caption from arbitrary English text elsewhere in the
    // player.  This also clears the old-position path when the user turns CC
    // off between cues.
    const cueIndex = state.currentCueIndex;
    const sameCacheKey = state.nativeCaptionCueIndex === cueIndex &&
      Object.is(state.nativeCaptionToggleState, captionState);
    if (captionState === false) {
      state.nativeCaptionCueIndex = cueIndex;
      state.nativeCaptionToggleState = captionState;
      state.nativeCaption = null;
      state.nativeCaptionScanComplete = true;
      state.nativeCaptionDirty = false;
      return null;
    }
    if (sameCacheKey && !state.nativeCaptionDirty) {
      // Once a cue has been scanned, keep the stable native anchor (or the
      // negative result) for subsequent video frames.  DOM mutations that can
      // introduce/replace a caption explicitly mark the cache dirty below;
      // geometry-only changes continue through this one-node validation path.
      if (state.nativeCaptionScanComplete) {
        return state.nativeCaption && cachedNativeCaptionMatches(state.nativeCaption, cue)
          ? state.nativeCaption
          : null;
      }
    }
    state.nativeCaptionCueIndex = cueIndex;
    state.nativeCaptionToggleState = captionState;
    state.nativeCaptionDirty = false;
    const player = state.player;
    const playerRect = player.getBoundingClientRect();
    const videoRect = state.video?.getBoundingClientRect?.();
    const controls = findControls(player);
    const candidates = [];
    for (const element of queryElementsDeep(player, "*")) {
      if (element === state.overlay || element.closest?.(`[${OVERLAY_ATTR}="1"]`)) continue;
      if (element.closest?.("#echo360-ui-root")) continue;
      if (!isVisible(element)) continue;
      const tag = String(element.tagName || "").toLowerCase();
      if (["button", "input", "select", "textarea", "svg"].includes(tag)) continue;
      const text = String(element.textContent || "").trim();
      if (!text || text.length > 500) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top < playerRect.top - 8 || rect.bottom > playerRect.bottom + 8 ||
        rect.width <= 0 || rect.height < 8) continue;
      if (videoRect?.width > 0 && videoRect?.height > 0) {
        const overlap = Math.max(0, Math.min(rect.right, videoRect.right) - Math.max(rect.left, videoRect.left));
        const overlapRatio = overlap / Math.min(rect.width, videoRect.width);
        // Echo can render two video panes side by side. A cue from the other
        // pane must never become the anchor for the selected video's Chinese
        // line. Require meaningful horizontal ownership by the selected
        // video, while still allowing Echo's shared full-player caption.
        if (overlapRatio < 0.55) continue;
      }
      if (controls && rect.top >= controls.top - 4 && rect.bottom <= controls.bottom + 4) continue;
      const classText = `${element.id || ""} ${String(element.className || "")} `
        + `${element.getAttribute?.("part") || ""} ${element.getAttribute?.("data-part") || ""}`;
      const normalizedClassText = classText.toLowerCase();
      if (/(?:control|timeline|volume|settings|bookmark|transcript|fullscreen)/.test(normalizedClassText)) continue;
      // A wrapper is useful only when the player marks it as a caption-like
      // surface. Otherwise inspect the leaf: this avoids selecting an
      // arbitrary page title or control label while the real English cue is
      // still being inserted.
      const captionHint = /(?:caption|subtitle|cue|track)/.test(normalizedClassText);
      if (element.children.length > 0 && !captionHint) continue;
      const score = matchScore(text, cue?.original || "");
      if (score <= 0) continue;
      const panePenalty = videoRect?.width > 0
        // A lesson may render one shared English caption over two side-by-
        // side videos. Keep that full-player cue eligible; only use the
        // width penalty to prefer a pane-local cue when both are present.
        ? Math.max(0, rect.width / videoRect.width - 1) * 8
        : 0;
      candidates.push({ element, rect, score: score - panePenalty });
    }
    candidates.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.element.children.length !== right.element.children.length) {
        return left.element.children.length - right.element.children.length;
      }
      return right.rect.bottom - left.rect.bottom;
    });
    state.nativeCaption = candidates[0]?.element || null;
    state.nativeCaptionScanComplete = true;
    return state.nativeCaption;
  }

  function ensurePositionedPlayer() {
    const player = state?.player;
    if (!player || state.playerPositionSaved) return;
    let position = "";
    try { position = getComputedStyle(player).position; } catch (_) {}
    if (position !== "static") return;
    state.playerPositionSaved = true;
    state.previousPlayerPosition = {
      value: player.style.getPropertyValue("position"),
      priority: player.style.getPropertyPriority("position"),
    };
    player.style.setProperty("position", "relative");
  }

  function restorePlayerPosition() {
    if (!state?.player || !state.playerPositionSaved) return;
    const previous = state.previousPlayerPosition;
    if (previous.value) state.player.style.setProperty("position", previous.value, previous.priority);
    else state.player.style.removeProperty("position");
    state.playerPositionSaved = false;
  }

  function ensureOverlay() {
    if (!state?.player?.isConnected) return null;
    ensurePositionedPlayer();
    let overlay = state.overlay?.isConnected && state.overlay.parentElement === state.player
      ? state.overlay
      : state.player.querySelector(`:scope > [${OVERLAY_ATTR}="1"]`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.setAttribute(OVERLAY_ATTR, "1");
      state.player.appendChild(overlay);
    }
    if (state.overlay !== overlay || !state.overlayConfigured) {
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.width = "100%";
      overlay.style.height = "100%";
      overlay.style.overflow = "visible";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2147483000";
      overlay.style.fontFamily = "inherit";
      overlay.style.textAlign = "center";
      state.overlayConfigured = true;
    }
    state.overlay = overlay;
    return overlay;
  }

  function copyNativeStyle(line, nativeCaption) {
    let computed = state.nativeCaptionExpected ? state.lastNativeStyle : null;
    if (nativeCaption) {
      const nativeStyle = getComputedStyle(nativeCaption);
      // Keep plain values, never a live CSSStyleDeclaration tied to a removed node.
      computed = Object.fromEntries(["fontSize", "fontFamily", "fontWeight", "fontStyle", "lineHeight", "textShadow"]
        .map((key) => [key, nativeStyle[key]]));
      state.lastNativeStyle = computed;
    }
    // Translation typography must not change when a delayed native node is
    // acquired: doing so reflows already visible Chinese text.
    const baseSize = 24;
    const scale = SIZE_MAP[state?.size] || SIZE_MAP.medium;
    line.style.fontFamily = "sans-serif";
    line.style.fontSize = `${baseSize * scale}px`;
    line.style.fontWeight = "600";
    line.style.fontStyle = "normal";
    line.style.lineHeight = "1.2";
    // Echo360 lessons do not use one caption theme consistently: some
    // recordings render native English as dark text on a light translucent
    // plate. Copying that dark color onto the translator's deliberately dark
    // backing plate produces an apparent "missing" Chinese line. Keep the
    // translator line in the conventional high-contrast caption treatment;
    // its geometry still comes from the real native caption below it.
    line.style.color = "#fff";
    line.style.textShadow = computed?.textShadow && computed.textShadow !== "none"
      ? computed.textShadow
      : "0 1px 2px rgba(0, 0, 0, 0.95), 0 0 4px rgba(0, 0, 0, 0.85)";
    line.style.background = "rgba(0, 0, 0, 0.72)";
    line.style.borderRadius = "0.12em";
    line.style.padding = "0.06em 0.34em";
    line.style.whiteSpace = "pre-wrap";
    line.style.overflowWrap = "anywhere";
    line.style.boxSizing = "border-box";
  }

  function createLine(kind, text, nativeCaption = null) {
    const line = document.createElement("span");
    line.setAttribute(LINE_ATTR, kind);
    line.textContent = text || "";
    line.style.position = "relative";
    line.style.display = "block";
    line.style.maxWidth = "100%";
    line.style.margin = "0";
    line.style.transform = "none";
    copyNativeStyle(line, nativeCaption);
    if (kind === "original") line.style.opacity = "0.88";
    return line;
  }

  function ensureStack(overlay, specs) {
    const signature = specs.map((spec) => `${spec.kind}\u0000${spec.text || ""}`).join("\u0001");
    let stack = state.stack?.isConnected && state.stack.parentElement === overlay
      ? state.stack
      : overlay.querySelector(`:scope > [${STACK_ATTR}="1"]`);
    const cachedLines = stack === state.stack && Array.isArray(state.stackLines) &&
      state.stackLines.length === specs.length && state.stackLines.every((line) => line.parentElement === stack)
      ? state.stackLines
      : null;
    const existingLines = cachedLines || (stack
      ? Array.from(stack.querySelectorAll(`:scope > [${LINE_ATTR}]`))
      : []);
    let nextLines = existingLines;
    const reusable = !!stack && existingLines.length === specs.length && specs.every((spec, index) =>
      existingLines[index].getAttribute(LINE_ATTR) === spec.kind &&
      existingLines[index].textContent === (spec.text || ""));
    if (!reusable) {
      stack = document.createElement("div");
      stack.setAttribute(STACK_ATTR, "1");
      stack.style.position = "absolute";
      stack.style.display = "flex";
      stack.style.flexDirection = "column";
      stack.style.alignItems = "center";
      stack.style.gap = `${CAPTION_GAP_PX}px`;
      stack.style.margin = "0";
      stack.style.padding = "0";
      stack.style.boxSizing = "border-box";
      stack.style.pointerEvents = "none";
      const lines = specs.map((spec) => createLine(spec.kind, spec.text, spec.nativeCaption));
      stack.append(...lines);
      overlay.replaceChildren(stack);
      nextLines = lines;
    } else if (state.lastStackStyleSize !== state.size || state.lastStackNativeCaption !== specs[0]?.nativeCaption) {
      existingLines.forEach((line, index) => copyNativeStyle(line, specs[index].nativeCaption));
      existingLines.forEach((line, index) => {
        if (specs[index].kind === "original") line.style.opacity = "0.88";
      });
    }
    state.stack = stack;
    state.stackLines = nextLines;
    state.lastStackSignature = signature;
    state.lastStackStyleSize = state.size;
    state.lastStackNativeCaption = specs[0]?.nativeCaption || null;
    return stack;
  }

  function hideOverlay(overlay) {
    if (!overlay.hidden) overlay.hidden = true;
    if (overlay.firstChild) overlay.replaceChildren();
    state.stack = null;
    state.stackLines = null;
  }

  function setStyleValue(element, property, value) {
    if (element.style[property] !== value) element.style[property] = value;
  }

  function measuredStackHeight(stack) {
    const rect = stack.getBoundingClientRect?.();
    if (rect?.height > 0) return rect.height;
    const lineHeights = Array.from(stack.querySelectorAll(`[${LINE_ATTR}]`)).map((line) => {
      const lineRect = line.getBoundingClientRect?.();
      if (lineRect?.height > 0) return lineRect.height;
      const computed = getComputedStyle(line);
      const lineHeight = Number.parseFloat(computed.lineHeight);
      const fontSize = Number.parseFloat(computed.fontSize) || 24;
      return Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2;
    });
    return lineHeights.reduce((sum, height) => sum + height, 0)
      + Math.max(0, lineHeights.length - 1) * CAPTION_GAP_PX;
  }

  function setTranslationWidth(stack) {
    // English glyph bounds vary per cue and during DOM replacement. A fixed
    // player-relative text area is available before the first native cue.
    setStyleValue(stack, "left", "2%");
    setStyleValue(stack, "width", "96%");
    setStyleValue(stack, "right", "auto");
  }

  function styleFallback(stack, playerRect, reserveNative = false) {
    const media = mediaBounds(state.player);
    setTranslationWidth(stack);

    // The fallback belongs to the lower edge of the player-local video
    // surface. It is intentionally independent of any arbitrary visible text:
    // when native CC is off there is no English DOM node to measure. Echo360's
    // controls may extend a few pixels below the video, so use their top only
    // when it is actually inside the player and never let it move the line
    // toward the middle of the lesson.
    const controls = findControls(state.player);
    const controlsTop = controls && controls.top > playerRect.top + 4
      ? controls.top
      : Number.POSITIVE_INFINITY;
    // Before the first real anchor exists, keep translation visible with a
    // conservative two-line English reservation. This is an estimate only;
    // the next confirmed native cue establishes the exact anchor.
    const nativeReserve = reserveNative ? 2 * 24 * 1.2 + CAPTION_GAP_PX : 0;
    const visibleBottom = Math.min(media.bottom, controlsTop) - CAPTION_GAP_PX - nativeReserve;
    const stackHeight = measuredStackHeight(stack);
    const topLimit = media.top - playerRect.top + CAPTION_GAP_PX;
    const bottom = Math.max(0, playerRect.bottom - visibleBottom);
    const maxBottom = Math.max(0, playerRect.height - topLimit - stackHeight);
    setStyleValue(stack, "transform", "none");
    setStyleValue(stack, "top", "auto");
    setStyleValue(stack, "bottom", `${Math.min(bottom, maxBottom)}px`);
    if (stack.dataset.echo360Placement !== "fallback") stack.dataset.echo360Placement = "fallback";
  }

  function playerLocalSize(playerRect) {
    const scaleX = state.player.offsetWidth > 0 ? playerRect.width / state.player.offsetWidth : 1;
    const scaleY = state.player.offsetHeight > 0 ? playerRect.height / state.player.offsetHeight : 1;
    return {
      scaleX, scaleY,
      width: state.player.clientWidth || playerRect.width / scaleX,
      height: state.player.clientHeight || playerRect.height / scaleY,
    };
  }

  function rememberNativeAnchor(nativeRect, playerRect) {
    if (playerRect.width <= 0 || playerRect.height <= 0) return;
    const local = playerLocalSize(playerRect);
    // A virtual anchor belongs to this mounted player, not a transient cue
    // node. Normalized local coordinates survive scrolling, zoom and resize.
    state.lastNativeAnchor = {
      left: ((nativeRect.left - playerRect.left) / local.scaleX - state.player.clientLeft) / local.width,
      top: ((nativeRect.top - playerRect.top) / local.scaleY - state.player.clientTop) / local.height,
      width: nativeRect.width / local.scaleX / local.width,
    };
  }

  function positionAtNativeAnchor(stack, playerRect) {
    const anchor = state.lastNativeAnchor;
    const local = playerLocalSize(playerRect);
    setTranslationWidth(stack);
    // CSS moves the actual bottom edge, including after wrapping/font changes.
    setStyleValue(stack, "transform", "translateY(-100%)");
    setStyleValue(stack, "top", `${anchor.top * local.height - CAPTION_GAP_PX}px`);
    setStyleValue(stack, "bottom", "auto");
    if (stack.dataset.echo360Placement !== "native-above") stack.dataset.echo360Placement = "native-above";
  }

  function captionTime() {
    if (state.frameMediaTime != null && !state.video.seeking && !state.video.paused) return state.frameMediaTime;
    return Number(state.video.currentTime || 0);
  }

  function render() {
    if (!state) return;
    if (!state.video?.isConnected || !state.player?.isConnected) {
      unmount();
      return;
    }
    state.lastLayoutRenderAt = performance.now();
    const overlay = ensureOverlay();
    if (!overlay) return;
    if (!state.visible) {
      hideOverlay(overlay);
      return;
    }
    const captionState = captionToggleState(state.player, state.video);
    const timelineIndex = findCueIndex(captionTime());
    state.timelineCueIndex = timelineIndex;
    let index = timelineIndex;
    const previous = state.currentCueIndex;
    // Echo's visible English DOM is authoritative during asynchronous cue
    // hand-off. Inspect only the confirmed node, never scan on each frame.
    if (timelineIndex >= 0 && previous >= 0 && previous !== timelineIndex && captionState !== false && state.followNativeCaption &&
      !state.video.seeking && state.nativeCaption &&
      normalizeForMatch(state.nativeCaption.textContent) === normalizeForMatch(state.cues[previous]?.original) &&
      cachedNativeCaptionMatches(state.nativeCaption, state.cues[previous])) index = previous;
    state.currentCueIndex = index;
    const cue = index >= 0 ? state.cues[index] : null;
    if (captionState === false) {
      // CC can be toggled during a gap between translated cues as well.
      state.nativeCaptionExpected = false;
      state.lastNativeAnchor = null;
      state.lastNativeStyle = null;
    }
    if (!cue?.translated) {
      hideOverlay(overlay);
      return;
    }
    const cueChanged = state.lastNativeCueIndex !== index || state.lastNativeVideo !== state.video;
    if (cueChanged) {
      // Match the new cue's node afresh, but retain the player's virtual
      // anchor. Translation text follows media time even during a DOM hand-off.
      state.lastNativeCueIndex = index;
      state.lastNativeVideo = state.video;
      state.nativeCaptionCueIndex = -1;
      state.nativeCaption = null;
      state.nativeCaptionScanComplete = false;
      state.nativeCaptionDirty = true;
    }
    let nativeCaption = findNativeCaption(cue, captionState);
    const now = performance.now();
    // The observer cannot see attachShadow() itself. Retry discovery only
    // while an anchor is missing; a stable visible anchor never needs a scan.
    if (!nativeCaption && captionState !== false && now - state.lastDiscoveryAt >= LAYOUT_REFRESH_MS) {
      state.lastDiscoveryAt = now;
      state.deepQueryCacheDirty = true;
      state.nativeCaptionDirty = true;
      nativeCaption = findNativeCaption(cue, captionState);
    }
    if (state.observedNativeCaption !== nativeCaption) {
      if (state.observedNativeCaption) state.resizeObserver?.unobserve(state.observedNativeCaption);
      if (nativeCaption) state.resizeObserver?.observe(nativeCaption);
      state.observedNativeCaption = nativeCaption;
    }
    const playerRect = state.player.getBoundingClientRect();
    if (nativeCaption) {
      state.nativeCaptionExpected = true;
      state.followNativeCaption = true;
      rememberNativeAnchor(nativeCaption.getBoundingClientRect(), playerRect);
    }

    // Keep the last confirmed position for this player with no expiry. A
    // missing anchor never hides an active translation, including acquisition.
    const retainedNativeAnchor = captionState !== false && state.lastNativeAnchor;
    const specs = [];
    if (nativeCaption || retainedNativeAnchor || captionState === true || !state.bilingual) {
      specs.push({ kind: "translated", text: cue.translated, nativeCaption });
    } else {
      const ordered = state.reverseOrder
        ? [["original", cue.original], ["translated", cue.translated]]
        : [["translated", cue.translated], ["original", cue.original]];
      for (const [kind, text] of ordered) if (text) specs.push({ kind, text, nativeCaption: null });
    }
    const stack = specs.length > 0 ? ensureStack(overlay, specs) : null;
    if (!stack) {
      hideOverlay(overlay);
      return;
    }
    if (retainedNativeAnchor && playerRect.width > 0 && playerRect.height > 0) {
      positionAtNativeAnchor(stack, playerRect);
    } else {
      styleFallback(stack, playerRect, captionState !== false);
    }
    if (overlay.hidden) overlay.hidden = false;
  }

  function scheduleLayoutRefresh() {
    if (!state?.visible) return;
    state.refreshUntil = Math.max(state.refreshUntil, performance.now() + LAYOUT_REFRESH_MS);
    if (state.refreshFrame != null) return;
    const mounted = state;
    const queue = () => {
      const delay = Math.max(0, LAYOUT_REFRESH_INTERVAL_MS - (performance.now() - state.lastLayoutRenderAt));
      state.refreshFrame = setTimeout(refresh, delay);
    };
    const refresh = () => {
      if (state !== mounted) return;
      state.refreshFrame = null;
      if (!state.visible) return;
      // Native cue changes render immediately; interactions and animated
      // controls share this bounded layout refresh, including while paused.
      if (performance.now() - state.lastLayoutRenderAt >= LAYOUT_REFRESH_INTERVAL_MS) render();
      if (state === mounted && state.visible && performance.now() < state.refreshUntil) queue();
    };
    queue();
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
    if (!state?.visible || state.frameHandle != null || typeof state.video.requestVideoFrameCallback !== "function") return;
    const mounted = state;
    const handle = state.video.requestVideoFrameCallback((_now, metadata) => {
      if (state !== mounted || state.frameHandle !== handle) return;
      state.frameHandle = null;
      if (Number.isFinite(metadata?.mediaTime)) state.frameMediaTime = metadata.mediaTime;
      const now = performance.now();
      const index = findCueIndex(captionTime());
      // Cue boundaries are immediate. Stable cues need only a bounded
      // fallback for CSS changes not represented by observed mutations.
      if (index !== state.timelineCueIndex || now - state.lastLayoutRenderAt >= LAYOUT_REFRESH_MS) {
        render();
      }
      scheduleVideoFrame();
    });
    state.frameHandle = handle;
  }

  function mount({ video, originalVtt, translatedVtt, size = "medium", bilingual = false, reverseOrder = false } = {}) {
    if (!isSupportedVideo(video)) return false;
    const player = findPlayer(video);
    const cues = buildCues(originalVtt, translatedVtt);
    if (!player || cues.length === 0) return false;
    unmount();
    state = {
      video,
      player,
      cues,
      maxEndThroughIndex: buildMaxEndPrefix(cues),
      size: SIZE_MAP[size] ? size : "medium",
      bilingual: !!bilingual,
      reverseOrder: !!reverseOrder,
      visible: true,
      currentCueIndex: -1,
      timelineCueIndex: -1,
      followNativeCaption: false,
      overlay: null,
      listeners: [],
      interactionListeners: [],
      observer: null,
      resizeObserver: null,
      frameHandle: null,
      frameMediaTime: null,
      lastDiscoveryAt: performance.now(),
      refreshFrame: null,
      lastLayoutRenderAt: -Infinity,
      refreshUntil: 0,
      playerPositionSaved: false,
      previousPlayerPosition: null,
      handlingMutation: false,
      nativeCaptionExpected: false,
      observedShadowRoots: new Set(),
      lastNativeCueIndex: -1,
      lastNativeVideo: null,
      lastNativeAnchor: null,
      lastNativeStyle: null,
      observedNativeCaption: null,
      nativeCaption: null,
      nativeCaptionCueIndex: -1,
      nativeCaptionToggleState: null,
      nativeCaptionScanComplete: false,
      nativeCaptionDirty: true,
      deepQueryCache: new Map(),
      deepQueryCacheDirty: false,
    };

    const onTimeUpdate = () => {
      if (!state?.visible) return;
      if (findCueIndex(captionTime()) !== state.timelineCueIndex ||
        performance.now() - state.lastLayoutRenderAt >= LAYOUT_REFRESH_MS) render();
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    state.listeners.push(["timeupdate", onTimeUpdate]);
    for (const eventName of ["seeking", "seeked", "play", "pause", "loadedmetadata", "emptied"]) {
      const listener = eventName === "emptied" ? () => unmount() : () => {
        if (eventName === "seeking" || eventName === "seeked" || eventName === "loadedmetadata") {
          state.frameMediaTime = null;
          state.followNativeCaption = false;
        }
        render();
      };
      video.addEventListener(eventName, listener);
      state.listeners.push([eventName, listener]);
    }
    for (const eventName of ["pointermove", "mouseenter", "mouseleave", "focusin", "focusout"]) {
      player.addEventListener(eventName, scheduleLayoutRefresh, { passive: true });
      state.interactionListeners.push([eventName, scheduleLayoutRefresh]);
    }
    if (typeof ResizeObserver === "function") {
      state.resizeObserver = new ResizeObserver(scheduleLayoutRefresh);
      state.resizeObserver.observe(player);
      state.resizeObserver.observe(video);
    }
    state.observer = new MutationObserver((records) => {
      if (!state?.visible || state.handlingMutation) return;
      const external = records.filter((record) => !isOwnMutation(record));
      if (external.length === 0) return;
      // Geometry/style mutations do not change selector membership. In
      // particular, a progress bar's per-frame style must not flush DOM caches.
      const structureChanged = external.some((record) => record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1));
      if (structureChanged || external.some((record) => record.attributeName === "class")) {
        state.deepQueryCacheDirty = true;
      }
      const cue = state.currentCueIndex >= 0 ? state.cues[state.currentCueIndex] : null;
      const captionChanged = cue && external.some((record) => mutationMayAffectNativeCaption(record, cue));
      const geometryChanged = external.some((record) => {
        const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
        if (target === player || target === video || target?.contains?.(state.nativeCaption)) return true;
        if (["aria-pressed", "aria-checked", "data-state", "data-active", "data-enabled"].includes(record.attributeName)) return true;
        return /caption|subtitle|cue|control|fullscreen/i.test(
          `${target?.id || ""} ${target?.className || ""} ${target?.getAttribute?.("data-part") || ""}`);
      });
      if (captionChanged) {
        state.nativeCaptionDirty = true;
        state.nativeCaptionScanComplete = false;
        state.lastStackNativeCaption = null;
      }
      if (!captionChanged && !geometryChanged && !structureChanged) return;
      state.handlingMutation = true;
      try {
        if (captionChanged && state.visible) render();
        scheduleLayoutRefresh();
      } finally {
        if (state) state.handlingMutation = false;
      }
    });
    state.observer.observe(player, MUTATION_OPTIONS);
    render();
    scheduleVideoFrame();
    console.info("[echo360-translator] mounted Echo360 caption overlay", { cueCount: cues.length });
    return true;
  }

  function update({ video, originalVtt, translatedVtt, size, bilingual, reverseOrder } = {}) {
    if (!state || video !== state.video || !state.video?.isConnected || !state.player?.isConnected) return false;
    const cues = buildCues(originalVtt, translatedVtt);
    if (cues.length === 0) return false;
    state.cues = cues;
    state.maxEndThroughIndex = buildMaxEndPrefix(cues);
    if (size) state.size = SIZE_MAP[size] ? size : "medium";
    if (bilingual !== undefined) state.bilingual = !!bilingual;
    if (reverseOrder !== undefined) state.reverseOrder = !!reverseOrder;
    state.currentCueIndex = -1;
    state.timelineCueIndex = -1;
    state.lastNativeCueIndex = -1;
    state.nativeCaptionDirty = true;
    state.deepQueryCacheDirty = true;
    render();
    return true;
  }

  function setVisible(visible) {
    if (!state) return;
    const next = !!visible;
    if (state.visible === next) return;
    state.visible = next;
    if (!next) {
      if (state.frameHandle != null) state.video.cancelVideoFrameCallback?.(state.frameHandle);
      state.frameHandle = null;
      state.frameMediaTime = null;
      clearTimeout(state.refreshFrame);
      state.refreshFrame = null;
      state.observer?.disconnect();
      state.resizeObserver?.disconnect();
      state.observedShadowRoots.clear();
      state.observedNativeCaption = null;
      state.nativeCaption = null;
      state.lastStackNativeCaption = null;
      state.deepQueryCache.clear();
    } else {
      state.observer?.observe(state.player, MUTATION_OPTIONS);
      state.resizeObserver?.observe(state.player);
      state.resizeObserver?.observe(state.video);
      state.deepQueryCacheDirty = true;
      state.nativeCaptionDirty = true;
      state.lastStackNativeCaption = null;
    }
    render();
    if (next) scheduleVideoFrame();
  }

  function applySize(size) {
    if (!state) return;
    const next = SIZE_MAP[size] ? size : "medium";
    if (state.size === next) return;
    state.size = next;
    render();
  }

  function ensureMounted() {
    if (!state) return false;
    if (!state.video?.isConnected || !state.player?.isConnected) {
      unmount();
      return false;
    }
    render();
    return !!state.overlay?.isConnected;
  }

  function isMounted() {
    return !!state;
  }

  function unmount() {
    if (!state) return;
    for (const [eventName, listener] of state.listeners) state.video.removeEventListener(eventName, listener);
    for (const [eventName, listener] of state.interactionListeners) state.player.removeEventListener(eventName, listener);
    clearTimeout(state.refreshFrame);
    if (state.frameHandle !== null && typeof state.video.cancelVideoFrameCallback === "function") {
      state.video.cancelVideoFrameCallback(state.frameHandle);
    }
    state.resizeObserver?.disconnect();
    state.observer?.disconnect();
    state.overlay?.remove();
    restorePlayerPosition();
    state = null;
  }

  function getDebugState() {
    if (!state) return { mounted: false };
    return {
      mounted: true,
      cueCount: state.cues.length,
      currentCueIndex: state.currentCueIndex,
      visible: state.visible,
      overlayAttached: !!state.overlay?.isConnected,
    };
  }

  ns.echoCaptionRenderer = {
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
