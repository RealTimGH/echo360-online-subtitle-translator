(() => {
  const ns = window.Echo360Translator;

  const OVERLAY_ATTR = "data-echo360-echo-caption";
  const LINE_ATTR = "data-echo360-echo-caption-line";
  const STACK_ATTR = "data-echo360-echo-caption-stack";
  const SIZE_MAP = { small: 0.88, medium: 1, large: 1.14 };
  const CAPTION_GAP_PX = 6;
  const LAYOUT_REFRESH_MS = 900;
  // Echo360 inserts/removes the native cue node asynchronously after the
  // media cue has become active.  Do not expose a temporary fallback position
  // during that short interval: it is the source of the visible "jump" before
  // the English line appears.
  const NATIVE_CUE_GRACE_MS = 420;

  let state = null;

  function parseTime(value) {
    const parts = String(value || "").trim().split(":");
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
      if (time >= cue.start && time < cue.end) return previous;
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
    const result = [];
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
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
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
      if (!element || candidates.has(element)) return;
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

  function findNativeCaption(cue, captionState) {
    if (!state?.player) return null;
    // When Echo's CC control is explicitly off there should be no attempt to
    // infer a native caption from arbitrary English text elsewhere in the
    // player.  This also clears the old-position path when the user turns CC
    // off between cues.
    if (captionState === false) return null;
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
        rect.width < 80 || rect.height < 8) continue;
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
    return candidates[0]?.element || null;
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
    overlay.style.inset = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.overflow = "visible";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2147483000";
    overlay.style.fontFamily = "inherit";
    overlay.style.textAlign = "center";
    state.overlay = overlay;
    return overlay;
  }

  function copyNativeStyle(line, nativeCaption) {
    const computed = nativeCaption ? getComputedStyle(nativeCaption) : null;
    const baseSize = Number.parseFloat(computed?.fontSize || "") || 24;
    const scale = SIZE_MAP[state?.size] || SIZE_MAP.medium;
    line.style.fontFamily = computed?.fontFamily || "sans-serif";
    line.style.fontSize = `${baseSize * scale}px`;
    line.style.fontWeight = computed?.fontWeight || "600";
    line.style.fontStyle = computed?.fontStyle || "normal";
    line.style.lineHeight = computed?.lineHeight && computed.lineHeight !== "normal"
      ? computed.lineHeight
      : "1.2";
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

  function ensureStack(overlay, lines) {
    const stack = document.createElement("div");
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
    stack.append(...lines);
    overlay.replaceChildren(stack);
    return stack;
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

  function setStackWidth(stack, left, width, playerRect) {
    const boundedLeft = Math.max(0, Math.min(playerRect.width, left));
    const boundedWidth = Math.max(80, Math.min(playerRect.width - boundedLeft, width));
    stack.style.left = `${boundedLeft}px`;
    stack.style.width = `${boundedWidth}px`;
    stack.style.right = "auto";
    return { left: boundedLeft, width: boundedWidth };
  }

  function styleFallback(stack, playerRect) {
    const media = mediaBounds(state.player);
    const mediaLeft = Math.max(0, media.left - playerRect.left);
    const mediaWidth = Math.max(80, Math.min(playerRect.width - mediaLeft, media.width || playerRect.width));
    setStackWidth(stack, mediaLeft, mediaWidth, playerRect);
    stack.style.top = "auto";

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
    const visibleBottom = Math.min(media.bottom, controlsTop) - CAPTION_GAP_PX;
    const stackHeight = measuredStackHeight(stack);
    const topLimit = media.top - playerRect.top + CAPTION_GAP_PX;
    const bottom = Math.max(0, playerRect.bottom - playerRect.top - visibleBottom);
    const maxBottom = Math.max(0, playerRect.height - topLimit - stackHeight);
    stack.style.bottom = `${Math.min(bottom, maxBottom)}px`;
    stack.dataset.echo360Placement = "fallback";
  }

  function positionAboveNative(stack, nativeCaption, playerRect) {
    return positionAboveNativeRect(stack, nativeCaption.getBoundingClientRect(), playerRect);
  }

  function positionAboveNativeRect(stack, nativeRect, playerRect) {
    const placement = setStackWidth(
      stack,
      nativeRect.left - playerRect.left,
      Math.max(80, nativeRect.width),
      playerRect
    );
    const stackHeight = measuredStackHeight(stack);
    const media = mediaBounds(state.player);
    const top = Math.max(
      media.top - playerRect.top + CAPTION_GAP_PX,
      nativeRect.top - playerRect.top - stackHeight - CAPTION_GAP_PX
    );
    stack.style.left = `${placement.left}px`;
    stack.style.width = `${placement.width}px`;
    stack.style.top = `${top}px`;
    stack.style.bottom = "auto";
    stack.dataset.echo360Placement = "native-above";
    return { left: placement.left, width: placement.width, top };
  }

  function render() {
    if (!state) return;
    const overlay = ensureOverlay();
    if (!overlay) return;
    if (!state.visible) {
      overlay.hidden = true;
      overlay.replaceChildren();
      return;
    }
    const index = findCueIndex(Number(state.video.currentTime || 0));
    state.currentCueIndex = index;
    const cue = index >= 0 ? state.cues[index] : null;
    if (!cue?.translated) {
      overlay.hidden = true;
      overlay.replaceChildren();
      return;
    }
    const captionState = captionToggleState(state.player, state.video);
    const cueChanged = state.lastNativeCueIndex !== index || state.lastNativeVideo !== state.video;
    if (cueChanged) {
      // A native node belongs to one cue and one video pane. Never carry its
      // geometry into the next cue: doing so is what placed Chinese in the
      // middle of the player while the next English cue was still absent.
      state.lastNativeCueIndex = index;
      state.lastNativeVideo = state.video;
      state.lastNativeRect = null;
      state.nativeMissingSince = performance.now();
      state.nativeLastSeenAt = 0;
    }
    const nativeCaption = findNativeCaption(cue, captionState);
    const now = performance.now();
    if (nativeCaption) {
      state.nativeMissingSince = 0;
      state.nativeLastSeenAt = now;
      const nativeRect = nativeCaption.getBoundingClientRect();
      state.lastNativeRect = {
        top: nativeRect.top,
        bottom: nativeRect.bottom,
        left: nativeRect.left,
        right: nativeRect.right,
        width: nativeRect.width,
        height: nativeRect.height,
      };
    } else if (captionState === false) {
      state.nativeMissingSince = 0;
      state.nativeLastSeenAt = 0;
      state.lastNativeRect = null;
    } else if (!state.nativeMissingSince) {
      state.nativeMissingSince = now;
    }

    // A native CC toggle is authoritative. When it is on, wait briefly for
    // Echo360 to paint the matching English cue instead of rendering Chinese
    // at a temporary baseline and then visibly jumping it upward. If the
    // player has no native cue after the grace period, the normal fallback is
    // used so a broken lesson never leaves a blank translation forever.
    const sameCueNativeRect = captionState !== false && state.lastNativeRect &&
      state.lastNativeCueIndex === index && state.lastNativeVideo === state.video &&
      now - state.nativeLastSeenAt < NATIVE_CUE_GRACE_MS;
    const waitingForNative = !nativeCaption && !sameCueNativeRect && captionState !== false
      && now - state.nativeMissingSince < NATIVE_CUE_GRACE_MS;
    const lines = [];
    if (!waitingForNative) {
      if (nativeCaption || !state.bilingual) {
        lines.push(createLine("translated", cue.translated, nativeCaption));
      } else {
        const ordered = state.reverseOrder
          ? [["original", cue.original], ["translated", cue.translated]]
          : [["translated", cue.translated], ["original", cue.original]];
        for (const [kind, text] of ordered) if (text) lines.push(createLine(kind, text));
      }
    }
    const stack = lines.length > 0 ? ensureStack(overlay, lines) : null;
    if (!stack) {
      overlay.hidden = true;
      // Do not leave the previous cue visible while waiting for Echo360 to
      // insert the next native English node. Keeping the old child in the DOM
      // made cue-boundary tests (and, visibly, the player) show stale Chinese
      // during the hand-off.
      overlay.replaceChildren();
      return;
    }
    const playerRect = state.player.getBoundingClientRect();
    if (nativeCaption && playerRect.width > 0 && playerRect.height > 0) {
      positionAboveNative(stack, nativeCaption, playerRect);
    } else if (sameCueNativeRect && playerRect.width > 0 && playerRect.height > 0) {
      // Echo360 briefly removes the old English node before inserting the new
      // cue. Keep the last confirmed caption baseline during that hand-off so
      // Chinese does not flash at the fallback position and then jump upward.
      positionAboveNativeRect(stack, state.lastNativeRect, playerRect);
    } else {
      styleFallback(stack, playerRect);
    }
    overlay.hidden = false;
  }

  function requestFrame(callback) {
    return typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 16);
  }

  function cancelFrame(handle) {
    if (handle == null) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
    clearTimeout(handle);
  }

  function scheduleLayoutRefresh() {
    if (!state) return;
    state.refreshUntil = Math.max(state.refreshUntil, performance.now() + LAYOUT_REFRESH_MS);
    if (state.refreshFrame != null) return;
    const refresh = () => {
      if (!state) return;
      state.refreshFrame = null;
      render();
      if (performance.now() < state.refreshUntil) state.refreshFrame = requestFrame(refresh);
    };
    state.refreshFrame = requestFrame(refresh);
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
      overlay: null,
      listeners: [],
      interactionListeners: [],
      observer: null,
      resizeObserver: null,
      frameHandle: null,
      refreshFrame: null,
      refreshUntil: 0,
      playerPositionSaved: false,
      previousPlayerPosition: null,
      handlingMutation: false,
      nativeMissingSince: 0,
      lastNativeCueIndex: -1,
      lastNativeVideo: null,
      lastNativeRect: null,
      nativeLastSeenAt: 0,
    };

    for (const eventName of ["timeupdate", "seeked", "play", "pause", "loadedmetadata"]) {
      video.addEventListener(eventName, render);
      state.listeners.push([eventName, render]);
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
      if (!state || state.handlingMutation || records.length === 0 || records.every(isOwnMutation)) return;
      state.handlingMutation = true;
      try {
        render();
        scheduleLayoutRefresh();
      } finally {
        state.handlingMutation = false;
      }
    });
    state.observer.observe(player, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
      childList: true,
      characterData: true,
      subtree: true,
    });
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
    render();
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
    cancelFrame(state.refreshFrame);
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
