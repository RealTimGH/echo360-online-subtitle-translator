(() => {
  const ns = window.Echo360Translator;

  // Facade over the ui_* modules: wires the ball, slide-out panel, settings
  // popover and first-run onboarding together, and exposes the same small
  // public surface controller.js has always depended on. Each concern
  // (theme tokens, stylesheet, ball, panel, popover, onboarding) lives in
  // its own file — see extension/ui_*.js.
  let handlers = {
    onTranslate: null,
    onQuickTranslate: null,
    onForceTranslate: null,
    onPrefsChanged: null,
    onTargetChanged: null,
    onManualPrepare: null,
    onManualDownloadVtt: null,
    onManualCopyPrompt: null,
    onManualDownloadPrompt: null,
    onManualImport: null,
    onManualToggleMode: null,
  };

  let activePanel = null;
  let activeBall = null;
  let activePopover = null;
  let activeFailureActions = null;

  const CONSOLE_CAPTURE_KEY = "__echo360TranslatorDiagnosticConsole__";
  const CONSOLE_LEVELS = ["debug", "info", "log", "warn", "error"];

  function isExtensionConsoleArgs(args) {
    const first = args?.[0];
    return typeof first === "string" && first.startsWith("[echo360-translator]");
  }

  function installConsoleCapture() {
    const target = globalThis.console;
    if (!target) return null;
    let registry = target[CONSOLE_CAPTURE_KEY];
    if (!registry) {
      registry = { pending: [], sink: null, installed: false, originals: {} };
      try {
        Object.defineProperty(target, CONSOLE_CAPTURE_KEY, {
          value: registry,
          configurable: true,
        });
      } catch (_) {
        try { target[CONSOLE_CAPTURE_KEY] = registry; } catch (_) {}
      }
    }
    if (registry.installed) return registry;

    for (const level of CONSOLE_LEVELS) {
      const original = target[level];
      if (typeof original !== "function") continue;
      registry.originals[level] = original;
      const wrapped = function (...args) {
        try {
          original.apply(target, args);
        } finally {
          if (!isExtensionConsoleArgs(args)) return;
          const record = {
            level,
            args: args.slice(0, 12),
            occurredAt: Date.now(),
          };
          if (typeof registry.sink === "function") {
            try { registry.sink(record); } catch (_) {}
          } else {
            registry.pending.push(record);
            if (registry.pending.length > 120) registry.pending.splice(0, registry.pending.length - 120);
          }
        }
      };
      try { target[level] = wrapped; } catch (_) {}
    }
    registry.installed = true;
    return registry;
  }

  const consoleCapture = installConsoleCapture();

  // Instructure Media is embedded inside a Canvas page and can contain more
  // than one player.  The controls therefore belong to the media document,
  // not to the top-level Canvas document.  Keep the extension root in this
  // frame and anchor its floating surfaces to the actual media controls in
  // viewport coordinates.  This is deliberately geometry based: the player
  // can swap its control-bar implementation without changing the extension's
  // DOM contract, and a scroll/transform on the host must not silently turn a
  // fixed control into a document-flow element.
  function installMediaAnchor(root) {
    if (!ns.hostSupport?.isInstructureMediaHost?.()) return null;

    let frame = null;
    let resizeObserver = null;
    let mutationObserver = null;
    let player = null;
    let controls = null;
    let anchorInitialized = false;
    let anchorShape = "";

    function schedule(force = false) {
      if (frame != null) return;
      const scheduleFrame = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback) => window.setTimeout(callback, 0);
      frame = scheduleFrame(() => {
        frame = null;
        sync(force);
      });
    }

    function visibleRect(element) {
      if (!element?.isConnected) return null;
      const rect = element.getBoundingClientRect?.();
      // A player can temporarily be outside the iframe viewport while its
      // inner lesson scroller moves. Its geometry is still the correct anchor
      // and must not be replaced with the generic viewport fallback.
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return rect;
    }

    function findPlayer() {
      if (player?.isConnected) return player;
      const video = ns.video?.getPrimaryVideo?.() || ns.video?.getAllVideos?.()[0] || null;
      return ns.hostSupport?.getPlayer?.(video) ||
        video?.closest?.("[data-media-player], #player") ||
        document.querySelector("[data-media-player], #player");
    }

    function deepQueryAll(nextPlayer, selector) {
      const direct = Array.from(nextPlayer?.querySelectorAll?.(selector) || []);
      const deep = ns.video?.querySelectorAllDeep?.(selector, nextPlayer) || direct;
      return Array.from(new Set([...direct, ...deep]));
    }

    function findControls(nextPlayer) {
      if (!nextPlayer) return null;
      const playerRect = visibleRect(nextPlayer);
      if (!playerRect) return null;
      const candidates = [
        '[data-part="controls"]',
        '[data-media-controls]',
        "media-controls",
        '[class*="media-controls"]',
        '[class*="player-controls"]',
        '[class*="control-bar"]',
        '[class*="ControlBar"]',
      ].flatMap((selector) => deepQueryAll(nextPlayer, selector));
      const controls = deepQueryAll(nextPlayer, 'button,[role="button"],input[type="range"]');
      const scored = new Map();

      const add = (candidate, sourceWeight = 0) => {
        if (!candidate || scored.has(candidate)) return;
        const rect = visibleRect(candidate);
        if (!rect || rect.right < playerRect.left || rect.left > playerRect.right) return;
        if (rect.bottom < playerRect.top || rect.top > playerRect.bottom + 96) return;
        const nearBottom = rect.top >= playerRect.top + playerRect.height * 0.5 ||
          rect.bottom >= playerRect.bottom - 32;
        if (!nearBottom && sourceWeight === 0) return;
        const widthRatio = Math.min(1.5, rect.width / Math.max(1, playerRect.width));
        const heightPenalty = rect.height > Math.max(120, playerRect.height * 0.35) ? 80 : 0;
        const score = sourceWeight + widthRatio * 100 + Math.min(40,
          Math.max(0, rect.top - playerRect.top) / Math.max(1, playerRect.height) * 40)
          - heightPenalty;
        scored.set(candidate, { candidate, rect, score });
      };

      candidates.forEach((candidate) => add(candidate, 80));
      for (const control of controls) {
        let candidate = control;
        for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
          add(candidate, 30);
          if (candidate === nextPlayer) break;
        }
      }
      return [...scored.values()].sort((left, right) => right.score - left.score)[0]?.candidate || null;
    }

    function setNumber(name, value) {
      root.style.setProperty(name, `${Math.round(value)}px`);
    }

    function sync(force = false) {
      const nextPlayer = findPlayer();
      const nextControls = findControls(nextPlayer);
      if (nextPlayer !== player || nextControls !== controls) {
        resizeObserver?.disconnect();
        player = nextPlayer;
        controls = nextControls;
        if (resizeObserver) {
          if (player) resizeObserver.observe(player);
          if (controls && controls !== player) resizeObserver.observe(controls);
        }
        anchorInitialized = false;
        anchorShape = "";
      }

      const playerRect = visibleRect(player);
      const controlsRect = visibleRect(controls) || playerRect;
      if (!controlsRect || !Number.isFinite(window.innerWidth) || !Number.isFinite(window.innerHeight)) {
        root.classList.remove("echo360-media-anchored");
        anchorInitialized = false;
        return;
      }

      // The media document can contain its own scrolling surface. A scroll
      // event must not turn the controls into a moving anchor: the compact
      // extension control is deliberately fixed in this media viewport and
      // is positioned once beside the selected player's control bar. Layout
      // changes (resize, player replacement, fullscreen, control-bar state)
      // still call sync(true) and are allowed to establish a new anchor.
      const shape = `${Math.round(controlsRect.width)}:${Math.round(controlsRect.height)}:`
        + `${Math.round(playerRect?.width || 0)}:${Math.round(playerRect?.height || 0)}`;
      // Do not recompute the viewport-fixed anchor from a scrolled control
      // rectangle.  The media document itself can scroll independently of its
      // iframe viewport; following that rectangle was the reason the control
      // moved while the user scrolled inside Canvas. A real control-bar size,
      // player replacement, resize, fullscreen or DOM-state change resets the
      // signature and is still allowed to establish a new anchor.
      if (anchorInitialized && nextPlayer === player && nextControls === controls && shape === anchorShape) return;

      const viewportWidth = Math.max(320, window.innerWidth);
      const viewportHeight = Math.max(240, window.innerHeight);
      const groupWidth = 84;
      const groupHeight = 52;
      const margin = 8;
      // Instructure Media embeds have their own player-local controls and the
      // surrounding Canvas page remains unobstructed. Keep the compact group
      // at its final player-local position and let hover/focus reveal the
      // secondary actions in place. The legacy Echo360 page still uses the
      // generic fixed, half-hidden group CSS because this anchor is installed
      // only for Instructure Media.
      const dockOffset = 0;
      // The player rectangle is the ownership boundary.  Instructure wraps
      // each media player in a much larger lesson/scroll shell; using the
      // iframe's right edge here makes the button look like a Canvas-level
      // control and makes a panel opened from one video affect the others.
      // Keep the compact group inside the selected player, aligned with the
      // right side of its actual control bar.
      const playerLeft = Math.max(margin, playerRect?.left || margin);
      const playerRight = Math.min(viewportWidth - margin, playerRect?.right || viewportWidth - margin);
      const maxPlayerLeft = Math.max(playerLeft, playerRight - groupWidth - dockOffset);
      const controlRight = Math.min(playerRight, Math.max(playerLeft, controlsRect.right));
      const left = Math.min(maxPlayerLeft, Math.max(playerLeft, controlRight - groupWidth - dockOffset));
      let top = controlsRect.bottom + margin;
      let direction = "below";
      if (top + groupHeight > viewportHeight - margin) {
        // The class-only Instructure player keeps its video surface and
        // control bar in adjacent siblings: the control bar can be just
        // outside `.studio-player-container__player` even though it belongs
        // to the same media instance. Use the viewport as the vertical
        // boundary, so the compact control remains directly below the real
        // bar instead of being incorrectly clamped back above it.
        top = Math.max(margin, controlsRect.top - groupHeight - margin);
        direction = "above";
      }
      top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - groupHeight - margin));

      // The panel and popover open toward the player rather than toward the
      // outer Canvas page. Their right edge follows the same control-bar edge
      // as the compact group, so every embedded video owns its own surface.
      setNumber("--echo360-floating-left", left);
      setNumber("--echo360-floating-top", top);
      // Secondary surfaces use the selected player's right/bottom edge too.
      // This keeps the panel local to the video and leaves room for another
      // independently injected player in the same Canvas lesson.
      setNumber("--echo360-surface-right", Math.max(margin, viewportWidth - playerRight + margin));
      setNumber("--echo360-surface-bottom", Math.max(margin, viewportHeight - controlsRect.top + margin));
      root.dataset.echo360AnchorDirection = direction;
      root.dataset.echo360AnchorPlayer = playerRect ? "1" : "0";
      root.classList.add("echo360-media-anchored");
      anchorInitialized = true;
      anchorShape = shape;
    }

    const onResize = () => schedule(true);
    const onPlayerInteraction = () => schedule(true);
    window.addEventListener("resize", onResize, false);
    window.addEventListener("orientationchange", onResize, false);
    document.addEventListener("fullscreenchange", onResize, true);
    document.addEventListener("pointermove", onPlayerInteraction, true);
    document.addEventListener("mouseenter", onPlayerInteraction, true);
    document.addEventListener("mouseleave", onPlayerInteraction, true);
    document.addEventListener("focusin", onPlayerInteraction, true);
    document.addEventListener("focusout", onPlayerInteraction, true);
    if (typeof ResizeObserver === "function") resizeObserver = new ResizeObserver(schedule);
    if (typeof MutationObserver === "function") {
      mutationObserver = new MutationObserver(() => schedule(true));
      mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "data-part", "data-media-controls"],
      });
    }
    sync();

    return () => {
      if (frame != null) {
        if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
        window.clearTimeout(frame);
      }
      window.removeEventListener("resize", onResize, false);
      window.removeEventListener("orientationchange", onResize, false);
      document.removeEventListener("fullscreenchange", onResize, true);
      document.removeEventListener("pointermove", onPlayerInteraction, true);
      document.removeEventListener("mouseenter", onPlayerInteraction, true);
      document.removeEventListener("mouseleave", onPlayerInteraction, true);
      document.removeEventListener("focusin", onPlayerInteraction, true);
      document.removeEventListener("focusout", onPlayerInteraction, true);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      root.classList.remove("echo360-media-anchored");
    };
  }

  function deliverConsoleRecord(record) {
    if (activeFailureActions?.appendLog) {
      activeFailureActions.appendLog(record.level, record.args, record.occurredAt);
      return;
    }
    if (!consoleCapture) return;
    consoleCapture.pending.push(record);
    if (consoleCapture.pending.length > 120) {
      consoleCapture.pending.splice(0, consoleCapture.pending.length - 120);
    }
  }

  if (consoleCapture) consoleCapture.sink = deliverConsoleRecord;

  function attachConsoleCapture() {
    if (!consoleCapture) return;
    consoleCapture.sink = deliverConsoleRecord;
    const pending = consoleCapture.pending.splice(0, consoleCapture.pending.length);
    for (const record of pending) deliverConsoleRecord(record);
  }

  function ensurePanel(nextHandlers) {
    // Keep the object identity stable: uiPanel/uiPopover retain this object in
    // their event-handler closures. Replacing it meant a later init/retry could
    // appear to update callbacks while the visible controls still invoked the
    // stale ones captured during the first injection.
    Object.assign(handlers, nextHandlers || {});
    const supportedPlayerDocument = ns.hostSupport?.isSupportedPlayerDocument?.() ||
      location.hostname.includes("echo360.");
    if (!supportedPlayerDocument) return;
    if (document.getElementById("echo360-translator-panel")) return;

    ns.uiStyles.inject();

    // Root wrapper — scopes CSS variable inheritance and keeps all UI elements
    // grouped. pointer-events:none is set in CSS; children re-enable as needed.
    const root = document.createElement("div");
    root.id = "echo360-ui-root";
    root.dataset.echo360Host = ns.hostSupport?.isInstructureMediaHost?.()
      ? "instructure-media"
      : "echo360";
    // Keep the fixed controls outside the player's body scroll container. The
    // controls themselves own their viewport positioning; the wrapper only
    // provides shared theme variables and event isolation.
    (document.documentElement || document.body).appendChild(root);
    installMediaAnchor(root);

    function showPanel() {
      onboarding.dismiss();
      ball.hide();
      ball.setPanelExpanded?.(true);
      panel.show();
      activePanel?.setStatusLive?.(activeFailureActions?.isVisible?.() !== true);
    }

    function hidePanel() {
      popover.hide();
      // Keep the diagnostics data, but collapse its extension whenever the
      // original floating window is collapsed. Reopening the ball starts from
      // the compact control surface and the user can explicitly open details.
      activeFailureActions?.collapse?.();
      panel.hide();
      ball.setPanelExpanded?.(false);
      activePanel?.setStatusLive?.(true);
      ball.show();
    }

    const ball = ns.uiBall.create(root, {
      onQuickTranslate: () => {
        onboarding.dismiss();
        return handlers.onQuickTranslate?.();
      },
      onOpenPanel: showPanel,
      onImport: async () => {
        const result = await panel.triggerManualImport?.();
        if (result === false) {
          showPanel();
          panel.openManual?.({ prepare: false });
          panel.focusManualFileImport?.();
        }
        return result;
      },
    });
    const onboarding = ns.uiOnboarding.create(root, ball);
    const panel = ns.uiPanel.create(root, handlers, {
      onCollapse: hidePanel,
      onToggleSettings: () => {
        // The settings surface uses the compact panel width as its anchor;
        // collapse an open diagnostics extension before showing it so the two
        // surfaces do not overlap.
        activeFailureActions?.collapse?.();
        activePanel?.setStatusLive?.(true);
        popover.toggle();
      },
      onToggleDiagnostics: () => {
        const visible = activeFailureActions?.toggle?.();
        // While the details extension is collapsed, the compact status line
        // remains the live announcement channel. Once the extension opens,
        // its structured alert owns the announcement instead.
        activePanel?.setStatusLive?.(visible !== true);
      },
    });
    const popover = ns.uiPopover.create(root, handlers, { trigger: panel.settingsButton });
    // Keep status, the compact diagnostics trigger, current diagnosis and
    // history inside the same right-side control panel as the three user
    // actions. The settings popover is configuration-only, so an error never
    // appears in a second unrelated surface.
    activeFailureActions = ns.uiFailureActions.create(panel.el, {
      toggleButton: panel.diagnosticsButton,
    });

    activePanel = panel;
    activeBall = ball;
    activePopover = popover;
    attachConsoleCapture();

    onboarding.maybeShow();

    // Apply stored appearance preference (async; safe to be slightly deferred).
    ns.storage.getConfig()
      .then((cfg) => ns.uiTheme.applyAppearance(cfg.appearance || "auto"))
      .catch((error) => {
        console.error(
          "[echo360-translator][ui] appearance load failed",
          ns.errorUtils?.serializeError?.(error, { phase: "preferences" }) || {
            code: "STORAGE_ERROR",
            message: String(error?.message || error || "设置读取失败"),
          }
        );
        activePanel?.show();
        activeFailureActions?.show({
          error,
          context: { phase: "preferences", code: "STORAGE_ERROR" },
          onCancel: () => activeFailureActions?.hide(),
        });
      });

    console.log("[echo360-translator] translate panel injected");
  }

  // -------------------------------------------------------------------------
  // Public API (surface unchanged)
  // -------------------------------------------------------------------------
  function readPanelPrefs() {
    return activePopover?.readPrefs();
  }

  function setStatusText(text, kind = "info") {
    activePanel?.setStatusText(text, kind);
    activeBall?.setStatus?.(text, kind);
  }

  function updateActionButtons(text, disabled = false) {
    activePanel?.updateActionButtons(text, disabled);
    activeBall?.setBusy?.(disabled);
  }

  function appendLog(level, ...values) {
    return activeFailureActions?.appendLog(level, ...values) || null;
  }

  function clearLogs() {
    activeFailureActions?.clearLogs?.();
  }

  function showTranslationFailureActions(options) {
    activePopover?.hide();
    activeBall?.hide();
    activeBall?.setPanelExpanded?.(true);
    activePanel?.show();
    activeFailureActions?.show(options);
    activePanel?.setStatusLive?.(true);
  }

  function hideTranslationFailureActions() {
    activeFailureActions?.hide();
    activePanel?.setStatusLive?.(true);
  }

  function showError(error, options = {}) {
    const model = ns.errorUtils?.normalizeError?.(error, options.context || options) || error;
    // Keep one diagnostic surface visible at a time. Settings remains a
    // configuration popover; it must not compete with the actionable error
    // card when a save/open/translation operation fails.
    activePopover?.hide();
    activeBall?.hide();
    activeBall?.setPanelExpanded?.(true);
    activePanel?.show();
    activeFailureActions?.show({ ...options, error: model, context: options.context || options });
    const summary = model?.summary || model?.message || "发生未知错误";
    activePanel?.setStatusText(`[${model?.code || "ERROR"}] ${summary}`, model?.severity === "warning" ? "warning" : "error");
    // The compact status line owns the live announcement while the details
    // extension is collapsed. If the user already had the extension open, the
    // structured failure card remains the sole announcement surface.
    activePanel?.setStatusLive?.(activeFailureActions?.isVisible?.() !== true);
    return model;
  }

  function clearError() {
    activeFailureActions?.hide();
    activePanel?.setStatusText?.("", "info");
    // showError() mutes the compact status while its structured alert is
    // visible. Restore the polite status channel after clearing so the next
    // progress update is announced to assistive technology.
    activePanel?.setStatusLive?.(true);
  }

  function showTranslationSummary(summary) {
    return activeFailureActions?.showTranslationSummary?.(summary) || null;
  }

  function clearTranslationSummary() {
    activeFailureActions?.clearTranslationSummary?.();
  }

  ns.ui = {
    ensurePanel,
    readPanelPrefs,
    setStatusText,
    setStatusLive: (enabled) => activePanel?.setStatusLive?.(enabled),
    updateActionButtons,
    setManualReady: (details) => {
      activePanel?.setManualReady?.(details);
      activeBall?.setImportReady?.(true);
    },
    setManualBusy: (message) => activePanel?.setManualBusy?.(message),
    setManualMessage: (message, kind) => activePanel?.setManualMessage?.(message, kind),
    showManualRecovery: () => {
      activePopover?.hide();
      activeBall?.hide();
      activeBall?.setPanelExpanded?.(true);
      activePanel?.show();
      activePanel?.openManual?.({ prepare: false });
    },
    appendLog,
    clearLogs,
    showTranslationFailureActions,
    hideTranslationFailureActions,
    showError,
    clearError,
    showTranslationSummary,
    clearTranslationSummary,
  };
})();
