(() => {
  const ns = window.Echo360Translator;

  // Facade over the ui_* modules: wires the ball, slide-out panel, settings
  // popover and first-run onboarding together, and exposes the same small
  // public surface controller.js has always depended on. Each concern
  // (theme tokens, stylesheet, ball, panel, popover, onboarding) lives in
  // its own file — see extension/ui_*.js.
  let handlers = {
    onTranslate: null,
    onForceTranslate: null,
    onPrefsChanged: null,
    onTargetChanged: null,
  };

  let activePanel = null;
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
    document.body.appendChild(root);

    function showPanel() {
      onboarding.dismiss();
      ball.hide();
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
      activePanel?.setStatusLive?.(true);
      ball.show();
    }

    const ball = ns.uiBall.create(root, { onActivate: showPanel });
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
  }

  function updateActionButtons(text, disabled = false) {
    activePanel?.updateActionButtons(text, disabled);
  }

  function appendLog(level, ...values) {
    return activeFailureActions?.appendLog(level, ...values) || null;
  }

  function clearLogs() {
    activeFailureActions?.clearLogs?.();
  }

  function showTranslationFailureActions(options) {
    activePopover?.hide();
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

  ns.ui = {
    ensurePanel,
    readPanelPrefs,
    setStatusText,
    setStatusLive: (enabled) => activePanel?.setStatusLive?.(enabled),
    updateActionButtons,
    appendLog,
    clearLogs,
    showTranslationFailureActions,
    hideTranslationFailureActions,
    showError,
    clearError,
  };
})();
