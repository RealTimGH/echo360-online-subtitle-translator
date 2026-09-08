(() => {
  const ns = window.Echo360Translator;
  const { DARK, LIGHT, toCssVars } = ns.uiTheme;

  // Width of the slide-out control panel; also used to offset the popover
  // and ball so they stay clear of the panel when it's open.
  const PANEL_W = 164;

  function inject() {
    if (document.getElementById("echo360-ui-styles")) return;
    const style = document.createElement("style");
    style.id = "echo360-ui-styles";
    style.textContent = `
      /* ===== Theme-variable container ===== */
      /* #echo360-ui-root is pointer-events:none so it never intercepts clicks;
         interactive children re-enable pointer-events individually. */
      #echo360-ui-root {
        pointer-events: none;
        ${toCssVars(DARK)}
      }
      .echo360-sr-only {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        padding: 0 !important;
        margin: -1px !important;
        overflow: hidden !important;
        clip: rect(0, 0, 0, 0) !important;
        white-space: nowrap !important;
        border: 0 !important;
      }

      /* Light theme – explicit "light" override */
      #echo360-ui-root[data-echo360-appearance="light"] {
        ${toCssVars(LIGHT)}
      }

      /* Light theme – auto mode (follow system, unless "dark" is forced) */
      @media (prefers-color-scheme: light) {
        #echo360-ui-root:not([data-echo360-appearance="dark"]) {
          ${toCssVars(LIGHT)}
        }
      }

      /* ===== Floating ball ===== */
      /*
       * The reveal/hide and pulse animations below are deliberately written to
       * touch only "transform" and "opacity". Echo360's own player can pin the
       * main thread for hundreds of ms at a time (e.g. its own CSS-in-JS style
       * churn during playback); animating "right" or "box-shadow" instead would
       * require a synchronous layout/paint on that same main thread every
       * frame, so this UI would visibly stutter in lockstep with the page's
       * own jank. transform/opacity changes are handled by the compositor on
       * their own thread, so they keep animating smoothly even while the page
       * is busy - it won't fix the underlying page-side lag, but our own UI
       * stops adding to the perceived stutter.
       */
      #echo360-translator-ball {
        position: fixed;
        right: 6px;
        bottom: 120px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        background: var(--echo360-ball-bg);
        color: var(--echo360-ball-fg);
        border: 1px solid var(--echo360-ball-border);
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 2147483647;
        pointer-events: auto;
        box-shadow: -3px 2px 14px var(--echo360-ball-shadow);
        transform: translateX(32px);
        will-change: transform;
        transition: transform 0.28s cubic-bezier(0.34,1.4,0.64,1),
                    opacity 0.2s ease,
                    box-shadow 0.2s;
        user-select: none;
        outline: none;
      }
      #echo360-translator-ball:hover {
        transform: translateX(0);
        box-shadow: -5px 4px 22px var(--echo360-ball-shadow-hover);
      }
      /* Immediate, JS-independent press feedback so clicks feel responsive
         even if the actual click handler has to wait behind a busy main thread. */
      #echo360-translator-ball:hover:active {
        transform: translateX(0) scale(0.92);
      }
      /*
       * Extend the hover-sensitive zone 30 px to the right.
       * Without this, the 6 px gap between the ball and the viewport edge
       * causes the ball to flicker (mouseleave → retract → re-enter → repeat).
       */
      #echo360-translator-ball::after {
        content: "";
        position: absolute;
        top: -10px;
        right: -30px;
        bottom: -10px;
        left: 0;
      }
      #echo360-translator-ball.echo360-ball-hidden {
        transform: translateX(70px);
        opacity: 0;
        pointer-events: none;
      }

      /* ===== First-run onboarding ===== */
      @keyframes echo360-ball-pulse-ring {
        0% { transform: scale(1); opacity: 0.55; }
        70% { transform: scale(1.55); opacity: 0; }
        100% { transform: scale(1.55); opacity: 0; }
      }
      /* A ::before ripple instead of an animated box-shadow: same "radar ping"
         look, but scale+opacity can run on the compositor thread instead of
         forcing a main-thread repaint every frame.
         Loops until the user dismisses the onboarding bubble (no auto-hide timer). */
      #echo360-translator-ball.echo360-ball-pulse::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: var(--echo360-ball-shadow-hover);
        animation: echo360-ball-pulse-ring 1.8s ease-out infinite;
        will-change: transform, opacity;
        pointer-events: none;
      }
      #echo360-onboarding-bubble {
        position: fixed;
        right: 70px;
        bottom: 122px;
        z-index: 2147483647;
        pointer-events: auto;
        max-width: 240px;
        background: var(--echo360-panel-bg);
        backdrop-filter: var(--echo360-panel-backdrop);
        -webkit-backdrop-filter: var(--echo360-panel-backdrop);
        color: var(--echo360-popover-fg);
        border: 1px solid var(--echo360-panel-border-color);
        border-radius: 12px;
        padding: 14px 16px;
        font-size: 14px;
        font-weight: 500;
        line-height: 1.5;
        box-shadow: -6px 4px 32px var(--echo360-panel-shadow);
        opacity: 0;
        transform: translateX(6px);
        transition: opacity 0.25s ease, transform 0.25s ease;
      }
      #echo360-onboarding-bubble.echo360-onboarding-visible {
        opacity: 1;
        transform: translateX(0);
      }
      #echo360-onboarding-bubble::after {
        content: "";
        position: absolute;
        top: 50%;
        right: -7px;
        width: 12px;
        height: 12px;
        margin-top: -6px;
        background: inherit;
        border-right: 1px solid var(--echo360-panel-border-color);
        border-bottom: 1px solid var(--echo360-panel-border-color);
        transform: rotate(-45deg);
      }
      .echo360-onboarding-text {
        padding-right: 18px;
      }
      #echo360-onboarding-bubble-close {
        position: absolute;
        top: 4px;
        right: 6px;
        background: transparent;
        border: 0;
        color: inherit;
        opacity: 0.5;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        padding: 4px;
      }
      #echo360-onboarding-bubble-close:hover {
        opacity: 1;
      }

      /* ===== Control panel ===== */
      /* Same reasoning as the ball above: slide via transform (compositor-only)
         instead of animating "right" (main-thread layout every frame). */
      #echo360-translator-panel {
        position: fixed;
        right: 12px;
        bottom: 80px;
        width: ${PANEL_W}px;
        box-sizing: border-box;
        z-index: 2147483647;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
        background: var(--echo360-panel-bg);
        backdrop-filter: var(--echo360-panel-backdrop);
        -webkit-backdrop-filter: var(--echo360-panel-backdrop);
        border: 1px solid var(--echo360-panel-border-color);
        border-radius: 12px;
        padding: 10px;
        box-shadow: -4px 2px 24px var(--echo360-panel-shadow);
        color: var(--echo360-popover-fg);
        transform: translateX(${PANEL_W + 52}px);
        will-change: transform;
        transition: transform 0.32s cubic-bezier(0.34,1.15,0.64,1);
      }
      #echo360-translator-panel.echo360-panel-visible {
        transform: translateX(0);
      }
      #echo360-translator-panel.echo360-panel-has-diagnostics {
        width: min(380px, calc(100vw - 24px));
        max-height: calc(100vh - 96px);
        overflow-y: auto;
      }
      #echo360-translator-panel.echo360-panel-has-diagnostics .echo360-panel-controls {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      #echo360-translator-panel.echo360-panel-has-diagnostics .echo360-panel-btn--collapse {
        grid-column: 1 / -1;
      }

      .echo360-panel-controls {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }

      /* ===== Panel buttons ===== */
      .echo360-panel-btn {
        padding: 8px 10px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        font-size: 13px;
        font-weight: var(--echo360-btn-font-weight);
        font-family: ui-sans-serif, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
        background: var(--echo360-btn-bg);
        color: var(--echo360-btn-fg);
        transition: filter 0.15s, opacity 0.15s, transform 0.1s;
      }
      .echo360-panel-btn:hover:not(:disabled) {
        filter: var(--echo360-btn-hover-filter);
      }
      /* Applied by the browser on mousedown, independent of our click handler
         actually running - gives instant tactile feedback even if the real
         action is stuck waiting behind a busy main thread. */
      .echo360-panel-btn:active:not(:disabled) {
        transform: scale(0.96);
      }
      .echo360-panel-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .echo360-panel-btn--collapse {
        background: var(--echo360-btn-collapse-bg);
        color: var(--echo360-btn-collapse-fg);
        font-size: 15px;
        text-align: center;
        padding: 6px 0;
      }
      .echo360-panel-btn--diagnostics {
        border: 1px solid var(--echo360-diagnostic-border);
        background: var(--echo360-diagnostic-subtle);
        color: var(--echo360-diagnostic-secondary-text);
      }
      .echo360-panel-btn--diagnostics:hover:not(:disabled) {
        border-color: var(--echo360-diagnostic-accent);
        color: var(--echo360-popover-fg);
      }
      .echo360-panel-btn--diagnostics-error {
        border-color: var(--echo360-diagnostic-error-border);
        color: var(--echo360-diagnostic-error-strong);
      }
      .echo360-panel-btn--diagnostics-warning {
        border-color: var(--echo360-diagnostic-warning-border);
        color: var(--echo360-diagnostic-warning-muted);
      }

      /* ===== Settings popover ===== */
      #echo360-translator-popover {
        position: fixed;
        right: ${PANEL_W + 28}px;
        bottom: 80px;
        z-index: 2147483647;
        pointer-events: auto;
        width: 280px;
        background: var(--echo360-popover-bg);
        backdrop-filter: var(--echo360-popover-backdrop);
        -webkit-backdrop-filter: var(--echo360-popover-backdrop);
        color: var(--echo360-popover-fg);
        border: 1px solid var(--echo360-popover-border-color);
        border-radius: 10px;
        padding: 12px;
        box-shadow: 0 6px 18px var(--echo360-popover-shadow);
      }
      .echo360-popover-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .echo360-popover-title {
        font-weight: 600;
      }
      .echo360-popover-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        padding: 0;
        border: 1px solid var(--echo360-popover-border-color);
        border-radius: 7px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: 20px/1 ui-sans-serif, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
      }
      .echo360-popover-close:hover {
        background: var(--echo360-diagnostic-subtle);
      }
      .echo360-popover-provider-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        opacity: .85;
        margin-bottom: 10px;
        padding-bottom: 9px;
        border-bottom: 1px solid var(--echo360-divider-color);
      }
      .echo360-popover-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 8px 0;
        transition: opacity 0.15s;
      }
      .echo360-popover-row.is-disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .echo360-beta-pref-label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .echo360-beta-notice-icon {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        box-sizing: border-box;
        border: 1px solid currentColor;
        border-radius: 50%;
        font-size: 10px;
        font-weight: 700;
        line-height: 1;
        /* Do not use opacity here: the tip is a child of this icon, and
           parent opacity would make the solid tip background translucent. */
        cursor: help;
        outline: none;
      }
      .echo360-beta-notice-tip {
        position: absolute;
        left: 0;
        bottom: calc(100% + 6px);
        z-index: 2;
        width: max-content;
        max-width: 220px;
        padding: 7px 8px;
        border-radius: 6px;
        border: 1px solid var(--echo360-tip-border-color);
        background: var(--echo360-tip-bg);
        color: var(--echo360-popover-fg);
        box-shadow: 0 4px 12px var(--echo360-tip-shadow);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        font-size: 11px;
        font-weight: 400;
        line-height: 1.4;
        white-space: normal;
        text-align: left;
        visibility: hidden;
        pointer-events: none;
      }
      .echo360-beta-notice-icon:hover .echo360-beta-notice-tip,
      .echo360-beta-notice-icon:focus-visible .echo360-beta-notice-tip {
        visibility: visible;
      }
      .echo360-popover-block-label {
        display: block;
        margin: 8px 0;
      }
      .echo360-popover-select {
        width: 100%;
        margin-top: 4px;
      }
      .echo360-popover-divider {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid var(--echo360-divider-color);
      }
      .echo360-status-text {
        font-size: 12px;
        opacity: .9;
        margin-top: 8px;
        min-height: 18px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .echo360-status-text.echo360-status-error {
        color: var(--echo360-diagnostic-error);
        font-weight: 700;
      }
      .echo360-status-text.echo360-status-warning {
        color: var(--echo360-diagnostic-warning);
        font-weight: 700;
      }
      .echo360-status-text.echo360-status-success {
        color: #9ce6b0;
      }
      .echo360-popover-link-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 0;
        background: transparent;
        color: inherit;
        font-size: 12px;
        cursor: pointer;
        padding: 2px 0;
        opacity: .6;
        transition: opacity .15s, transform 0.1s;
      }
      .echo360-popover-link-btn:hover {
        opacity: 1;
      }
      .echo360-popover-link-btn:active {
        transform: scale(0.95);
      }
      .echo360-popover-link-btn--underline {
        text-decoration: underline;
      }
      .echo360-panel-btn:focus-visible,
      .echo360-popover-close:focus-visible,
      .echo360-popover-link-btn:focus-visible,
      .echo360-popover-row input:focus-visible,
      .echo360-popover-select:focus-visible {
        outline: 2px solid var(--echo360-diagnostic-accent);
        outline-offset: 2px;
      }

      /* ===== Diagnostics extension (inside the control panel) ===== */
      .echo360-diagnostics-extension {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 5px;
      }
      .echo360-diagnostics-extension[hidden] {
        display: none;
      }

      /* ===== Structured translation error panel ===== */
      #echo360-translator-failure-actions {
        position: static;
        transform: none;
        z-index: auto;
        pointer-events: auto;
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        width: auto;
        max-height: min(48vh, 520px);
        overflow: auto;
        margin-top: 0;
        padding: 9px 0 0;
        border: 0;
        border-top: 1px solid var(--echo360-diagnostic-error-border);
        border-radius: 0;
        background: transparent;
        color: var(--echo360-popover-fg);
        font-size: 13px;
        line-height: 1.35;
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
      #echo360-translator-failure-actions.echo360-error-warning {
        border-color: var(--echo360-diagnostic-warning-border);
        background: transparent;
      }
      .echo360-error-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
      }
      .echo360-error-heading {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .echo360-error-context {
        margin-bottom: 5px;
        color: var(--echo360-diagnostic-muted-text);
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .06em;
        text-transform: uppercase;
      }
      .echo360-error-historical .echo360-error-context {
        color: var(--echo360-diagnostic-accent);
      }
      .echo360-error-severity {
        color: var(--echo360-diagnostic-error);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .04em;
        text-transform: uppercase;
      }
      .echo360-error-warning .echo360-error-severity {
        color: var(--echo360-diagnostic-warning);
      }
      .echo360-error-empty .echo360-error-severity {
        color: var(--echo360-diagnostic-accent);
      }
      .echo360-error-code {
        padding: 2px 6px;
        border: 1px solid var(--echo360-diagnostic-border);
        border-radius: 5px;
        color: var(--echo360-diagnostic-error-muted);
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .echo360-error-close {
        flex: 0 0 auto;
        border: 0;
        background: transparent;
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 20px;
        line-height: 1;
        font-weight: 600;
        cursor: pointer;
        padding: 0 2px;
      }
      .echo360-error-close:hover {
        color: var(--echo360-popover-fg);
      }
      .echo360-error-title {
        margin-top: 6px;
        font-size: 17px;
        font-weight: 800;
      }
      .echo360-error-summary {
        margin-top: 5px;
        color: var(--echo360-diagnostic-error-strong);
        font-size: 14px;
      }
      .echo360-error-recommendation {
        margin-top: 8px;
        padding: 8px 10px;
        border-left: 3px solid var(--echo360-diagnostic-error);
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-diagnostic-error-muted);
      }
      .echo360-error-warning .echo360-error-recommendation {
        border-left-color: var(--echo360-diagnostic-warning);
        color: var(--echo360-diagnostic-warning-muted);
      }
      .echo360-error-empty .echo360-error-summary {
        color: var(--echo360-diagnostic-secondary-text);
      }
      .echo360-error-empty .echo360-error-recommendation {
        border-left-color: var(--echo360-diagnostic-accent);
        color: var(--echo360-diagnostic-secondary-text);
      }
      .echo360-error-details {
        margin-top: 10px;
        border-top: 1px solid var(--echo360-diagnostic-border);
        padding-top: 8px;
      }
      .echo360-error-details summary {
        cursor: pointer;
        color: var(--echo360-diagnostic-secondary-text);
        font-weight: 700;
      }
      .echo360-error-detail-list {
        display: grid;
        gap: 5px;
        margin-top: 7px;
      }
      .echo360-error-detail-row {
        display: grid;
        grid-template-columns: minmax(92px, 132px) minmax(0, 1fr);
        gap: 8px;
        padding: 5px 7px;
        border-radius: 5px;
        background: var(--echo360-diagnostic-subtle);
      }
      .echo360-error-detail-label {
        color: var(--echo360-diagnostic-muted-text);
        font-weight: 700;
      }
      .echo360-error-detail-value {
        min-width: 0;
        color: var(--echo360-popover-fg);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: ui-sans-serif, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
      }
      .echo360-error-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--echo360-diagnostic-border);
      }
      .echo360-failure-link {
        border: 0;
        background: transparent;
        color: var(--echo360-diagnostic-accent);
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        text-decoration: underline;
        padding: 0;
      }
      .echo360-failure-link:hover {
        color: var(--echo360-diagnostic-accent-hover);
      }
      .echo360-failure-link:active {
        transform: scale(0.96);
      }
      .echo360-failure-sep {
        opacity: 0.55;
        user-select: none;
      }

      /* ===== Persistent runtime log panel ===== */
      .echo360-runtime-logs {
        display: block;
        margin-top: 0;
        padding-top: 8px;
        border-top: 1px solid var(--echo360-divider-color);
        color: var(--echo360-popover-fg);
      }
      .echo360-runtime-logs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .echo360-runtime-logs-toggle {
        display: inline-flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
        border: 0;
        padding: 3px 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        font-weight: 850;
        cursor: pointer;
      }
      .echo360-runtime-logs-toggle:hover,
      .echo360-runtime-logs-toggle:focus-visible {
        color: var(--echo360-diagnostic-accent);
      }
      .echo360-runtime-logs-total {
        display: inline-flex;
        min-width: 19px;
        height: 19px;
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 10px;
      }
      .echo360-runtime-logs-chevron {
        color: var(--echo360-diagnostic-muted-text);
        font-size: 11px;
      }
      .echo360-runtime-logs-actions {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .echo360-runtime-logs-copy,
      .echo360-runtime-logs-clear {
        border: 0;
        padding: 2px 0;
        background: transparent;
        color: var(--echo360-diagnostic-accent);
        font: inherit;
        font-size: 10px;
        font-weight: 750;
        cursor: pointer;
      }
      .echo360-runtime-logs-copy:hover,
      .echo360-runtime-logs-clear:hover {
        color: var(--echo360-diagnostic-accent-hover);
        text-decoration: underline;
      }
      .echo360-runtime-logs-clear[data-confirming="true"] {
        color: var(--echo360-diagnostic-error);
      }
      .echo360-runtime-logs-copy:disabled {
        cursor: default;
        opacity: .58;
        text-decoration: none;
      }
      .echo360-runtime-logs-content[hidden] {
        display: none;
      }
      .echo360-runtime-logs-overview {
        margin-top: 6px;
        color: var(--echo360-diagnostic-muted-text);
        font-size: 10px;
      }
      .echo360-runtime-logs-tools {
        display: grid;
        gap: 6px;
        margin-top: 7px;
      }
      .echo360-runtime-logs-search-wrap {
        display: block;
      }
      .echo360-runtime-logs-search {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--echo360-diagnostic-border);
        border-radius: 7px;
        padding: 7px 9px;
        background: var(--echo360-diagnostic-subtle);
        color: var(--echo360-popover-fg);
        font: 11px/1.25 ui-sans-serif, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
        outline: none;
      }
      .echo360-runtime-logs-search::placeholder {
        color: var(--echo360-diagnostic-muted-text);
      }
      .echo360-runtime-logs-search:focus {
        border-color: var(--echo360-diagnostic-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--echo360-diagnostic-accent) 22%, transparent);
      }
      .echo360-runtime-logs-filters {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 3px;
        padding: 3px;
        border-radius: 8px;
        background: var(--echo360-diagnostic-subtle);
      }
      .echo360-runtime-logs-filters button {
        border: 0;
        border-radius: 6px;
        padding: 5px 2px;
        background: transparent;
        color: var(--echo360-diagnostic-secondary-text);
        font: inherit;
        font-size: 9px;
        cursor: pointer;
      }
      .echo360-runtime-logs-filters button[aria-pressed="true"] {
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-popover-fg);
        font-weight: 800;
        box-shadow: 0 1px 3px var(--echo360-panel-shadow);
      }
      .echo360-runtime-logs-filters span {
        color: var(--echo360-diagnostic-muted-text);
        font-variant-numeric: tabular-nums;
      }
      .echo360-runtime-logs-empty {
        margin-top: 8px;
        padding: 12px 8px;
        border: 1px dashed var(--echo360-diagnostic-border);
        border-radius: 7px;
        color: var(--echo360-diagnostic-muted-text);
        font-size: 11px;
        text-align: center;
      }
      .echo360-runtime-logs-list {
        display: grid;
        gap: 5px;
        margin: 8px 0 0;
        padding: 0;
        max-height: min(28vh, 280px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        list-style: none;
      }
      .echo360-runtime-log-item {
        padding: 6px 8px;
        border-left: 3px solid var(--echo360-diagnostic-accent);
        border-radius: 5px;
        background: var(--echo360-diagnostic-subtle);
      }
      .echo360-runtime-log-item.is-debug {
        border-left-color: var(--echo360-diagnostic-muted-text);
      }
      .echo360-runtime-log-item.is-warn {
        border-left-color: var(--echo360-diagnostic-warning);
      }
      .echo360-runtime-log-item.is-error {
        border-left-color: var(--echo360-diagnostic-error);
      }
      .echo360-runtime-log-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .echo360-runtime-log-level {
        color: var(--echo360-diagnostic-accent);
        font-size: 9px;
        font-weight: 850;
        letter-spacing: .04em;
      }
      .is-debug .echo360-runtime-log-level {
        color: var(--echo360-diagnostic-muted-text);
      }
      .is-warn .echo360-runtime-log-level {
        color: var(--echo360-diagnostic-warning);
      }
      .is-error .echo360-runtime-log-level {
        color: var(--echo360-diagnostic-error);
      }
      .echo360-runtime-log-time {
        color: var(--echo360-diagnostic-muted-text);
        font-size: 9px;
        font-variant-numeric: tabular-nums;
      }
      .echo360-runtime-log-message {
        margin-top: 3px;
        color: var(--echo360-diagnostic-secondary-text);
        font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .echo360-runtime-logs-feedback {
        min-height: 14px;
        margin-top: 5px;
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 10px;
      }

      /* ===== Session error history (inside the same control panel) ===== */
      .echo360-error-history {
        display: none;
        margin-top: 0;
        padding-top: 8px;
        border-top: 1px solid var(--echo360-divider-color);
        color: var(--echo360-popover-fg);
      }
      .echo360-error-history-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .echo360-error-history-toggle {
        display: inline-flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
        border: 0;
        padding: 3px 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        font-weight: 850;
        cursor: pointer;
      }
      .echo360-error-history-toggle:hover,
      .echo360-error-history-toggle:focus-visible {
        color: var(--echo360-diagnostic-accent);
      }
      .echo360-error-history-total {
        display: inline-flex;
        min-width: 19px;
        height: 19px;
        box-sizing: border-box;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 10px;
      }
      .echo360-error-history-chevron {
        color: var(--echo360-diagnostic-muted-text);
        font-size: 11px;
      }
      .echo360-error-history-actions,
      .echo360-error-history-item-actions {
        display: flex;
        align-items: center;
        gap: 9px;
      }
      .echo360-error-history-clear,
      .echo360-error-history-copy,
      .echo360-error-history-view,
      .echo360-error-history-item-copy {
        border: 0;
        padding: 2px 0;
        background: transparent;
        color: var(--echo360-diagnostic-accent);
        font: inherit;
        font-size: 10px;
        font-weight: 750;
        cursor: pointer;
      }
      .echo360-error-history-clear:hover,
      .echo360-error-history-copy:hover,
      .echo360-error-history-view:hover,
      .echo360-error-history-item-copy:hover {
        color: var(--echo360-diagnostic-accent-hover);
        text-decoration: underline;
      }
      .echo360-error-history-clear[data-confirming="true"] {
        color: var(--echo360-diagnostic-error);
      }
      .echo360-error-history-copy:disabled,
      .echo360-error-history-view:disabled {
        cursor: default;
        opacity: .58;
        text-decoration: none;
      }
      .echo360-error-history-content[hidden] {
        display: none;
      }
      .echo360-error-history-overview {
        margin-top: 6px;
        color: var(--echo360-diagnostic-muted-text);
        font-size: 10px;
      }
      .echo360-error-history-tools {
        display: grid;
        gap: 6px;
        margin-top: 7px;
      }
      .echo360-error-history-search-wrap {
        display: block;
      }
      .echo360-error-history-search {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--echo360-diagnostic-border);
        border-radius: 7px;
        padding: 7px 9px;
        background: var(--echo360-diagnostic-subtle);
        color: var(--echo360-popover-fg);
        font: 11px/1.25 ui-sans-serif, "Avenir Next", "Helvetica Neue", Arial, sans-serif;
        outline: none;
      }
      .echo360-error-history-search::placeholder {
        color: var(--echo360-diagnostic-muted-text);
      }
      .echo360-error-history-search:focus {
        border-color: var(--echo360-diagnostic-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--echo360-diagnostic-accent) 22%, transparent);
      }
      .echo360-error-history-filters {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 3px;
        padding: 3px;
        border-radius: 8px;
        background: var(--echo360-diagnostic-subtle);
      }
      .echo360-error-history-filters button {
        border: 0;
        border-radius: 6px;
        padding: 5px 4px;
        background: transparent;
        color: var(--echo360-diagnostic-secondary-text);
        font: inherit;
        font-size: 10px;
        cursor: pointer;
      }
      .echo360-error-history-filters button[aria-pressed="true"] {
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-popover-fg);
        font-weight: 800;
        box-shadow: 0 1px 3px var(--echo360-panel-shadow);
      }
      .echo360-error-history-filters span {
        color: var(--echo360-diagnostic-muted-text);
        font-variant-numeric: tabular-nums;
      }
      .echo360-error-history-empty {
        margin-top: 8px;
        padding: 12px 8px;
        border: 1px dashed var(--echo360-diagnostic-border);
        border-radius: 7px;
        color: var(--echo360-diagnostic-muted-text);
        font-size: 11px;
        text-align: center;
      }
      .echo360-error-history-list {
        display: grid;
        gap: 7px;
        margin: 8px 0 0;
        padding: 0;
        max-height: min(30vh, 300px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        list-style: none;
      }
      .echo360-error-history-item {
        padding: 8px 9px;
        border: 1px solid var(--echo360-diagnostic-border);
        border-left: 3px solid var(--echo360-diagnostic-error-border);
        border-radius: 7px;
        background: var(--echo360-diagnostic-subtle);
        transition: border-color .15s, background .15s;
      }
      .echo360-error-history-item.is-warning {
        border-left-color: var(--echo360-diagnostic-warning-border);
      }
      .echo360-error-history-item.is-selected {
        border-color: var(--echo360-diagnostic-accent);
        background: var(--echo360-diagnostic-raised);
      }
      .echo360-error-history-line {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 5px;
      }
      .echo360-error-history-severity {
        flex: 0 0 auto;
        color: var(--echo360-diagnostic-error);
        font-size: 9px;
        font-weight: 850;
      }
      .is-warning .echo360-error-history-severity {
        color: var(--echo360-diagnostic-warning);
      }
      .echo360-error-history-code {
        min-width: 0;
        overflow: hidden;
        color: var(--echo360-diagnostic-secondary-text);
        font: 9px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .echo360-error-history-repeats {
        flex: 0 0 auto;
        padding: 1px 4px;
        border-radius: 999px;
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 9px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
      }
      .echo360-error-history-label {
        margin-top: 5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        font-weight: 800;
      }
      .echo360-error-history-time {
        margin-left: auto;
        color: var(--echo360-diagnostic-muted-text);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .echo360-error-history-summary {
        display: -webkit-box;
        margin-top: 4px;
        overflow: hidden;
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 11px;
        line-height: 1.35;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      .echo360-error-history-footer {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 8px;
        margin-top: 7px;
      }
      .echo360-error-history-meta {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        gap: 4px;
      }
      .echo360-error-history-meta span {
        max-width: 118px;
        overflow: hidden;
        padding: 2px 5px;
        border-radius: 4px;
        background: var(--echo360-diagnostic-raised);
        color: var(--echo360-diagnostic-muted-text);
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .echo360-error-history-item-actions {
        flex: 0 0 auto;
      }
      .echo360-error-history-feedback {
        min-height: 14px;
        margin-top: 5px;
        color: var(--echo360-diagnostic-secondary-text);
        font-size: 10px;
      }
      #echo360-translator-failure-actions button:focus-visible,
      .echo360-runtime-logs button:focus-visible,
      .echo360-runtime-logs input:focus-visible,
      .echo360-error-history button:focus-visible,
      .echo360-error-history input:focus-visible {
        outline: 2px solid var(--echo360-diagnostic-accent);
        outline-offset: 2px;
      }
      @media (max-width: 430px) {
        #echo360-translator-panel.echo360-panel-has-diagnostics {
          right: 8px;
          width: calc(100vw - 16px);
          max-height: calc(100vh - 88px);
        }
      }
    `;
    document.head.appendChild(style);
  }

  ns.uiStyles = { inject, PANEL_W };
})();
