(() => {
  const ns = window.Echo360Translator;

  // The slide-out control panel (collapse / translate / re-translate /
  // settings / diagnostics buttons) also owns the single status/live-region
  // surface used by the content page. Holds direct references to its own
  // button elements so `updateActionButtons()` never has to re-query the DOM
  // by id.
  function create(root, handlers, { onCollapse, onToggleSettings, onToggleDiagnostics } = {}) {
    const panel = document.createElement("div");
    panel.id = "echo360-translator-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "字幕翻译控制面板");

    const toolbar = document.createElement("div");
    toolbar.className = "echo360-panel-controls";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "字幕翻译操作");

    const collapseBtn = document.createElement("button");
    collapseBtn.id = "echo360-translator-collapse-btn";
    collapseBtn.className = "echo360-panel-btn echo360-panel-btn--collapse";
    collapseBtn.innerHTML = "›";
    collapseBtn.title = "收起控制面板";
    collapseBtn.setAttribute("aria-label", "收起控制面板");
    collapseBtn.addEventListener("click", () => onCollapse?.());

    const translateBtn = document.createElement("button");
    translateBtn.id = "echo360-translator-btn";
    translateBtn.className = "echo360-panel-btn";
    translateBtn.textContent = "加载翻译字幕";
    translateBtn.title = "加载或复用当前录播的翻译字幕";
    translateBtn.setAttribute("aria-label", "加载翻译字幕");
    translateBtn.addEventListener("click", () => handlers.onTranslate?.());

    const forceBtn = document.createElement("button");
    forceBtn.id = "echo360-translator-force-btn";
    forceBtn.className = "echo360-panel-btn";
    forceBtn.textContent = "重新翻译";
    forceBtn.title = "清除当前字幕缓存并重新翻译";
    forceBtn.setAttribute("aria-label", "重新翻译字幕");

    const settingsBtn = document.createElement("button");
    settingsBtn.id = "echo360-translator-settings-btn";
    settingsBtn.className = "echo360-panel-btn";
    settingsBtn.textContent = "字幕设置";
    settingsBtn.title = "打开字幕显示设置";
    settingsBtn.setAttribute("aria-label", "打开字幕设置");
    settingsBtn.setAttribute("aria-controls", "echo360-translator-popover");
    settingsBtn.setAttribute("aria-expanded", "false");
    settingsBtn.addEventListener("click", () => onToggleSettings?.());

    const diagnosticsBtn = document.createElement("button");
    diagnosticsBtn.id = "echo360-translator-failure-toggle";
    diagnosticsBtn.className = "echo360-panel-btn echo360-panel-btn--diagnostics";
    diagnosticsBtn.dataset.action = "toggle-diagnostics";
    diagnosticsBtn.textContent = "运行诊断";
    diagnosticsBtn.title = "查看翻译失败详情和运行诊断";
    diagnosticsBtn.setAttribute("aria-label", "打开运行诊断");
    diagnosticsBtn.setAttribute("aria-controls", "echo360-translator-diagnostics-extension");
    diagnosticsBtn.setAttribute("aria-expanded", "false");
    diagnosticsBtn.hidden = true;
    diagnosticsBtn.setAttribute("aria-hidden", "true");
    diagnosticsBtn.addEventListener("click", () => onToggleDiagnostics?.());

    const statusText = document.createElement("div");
    statusText.id = "echo360-status-text";
    statusText.className = "echo360-status-text";
    statusText.setAttribute("role", "status");
    statusText.setAttribute("aria-live", "polite");
    statusText.setAttribute("aria-atomic", "true");

    let forceConfirmTimer = null;
    let forceConfirmSnapshot = null;

    function setStatusText(text, kind = "info") {
      statusText.textContent = String(text || "");
      statusText.setAttribute("aria-live", kind === "error" ? "off" : "polite");
      statusText.classList.remove(
        "echo360-status-error",
        "echo360-status-warning",
        "echo360-status-success"
      );
      if (kind === "error") statusText.classList.add("echo360-status-error");
      if (kind === "warning") statusText.classList.add("echo360-status-warning");
      if (kind === "success") statusText.classList.add("echo360-status-success");
    }

    function statusKind() {
      if (statusText.classList.contains("echo360-status-error")) return "error";
      if (statusText.classList.contains("echo360-status-warning")) return "warning";
      if (statusText.classList.contains("echo360-status-success")) return "success";
      return "info";
    }

    function resetForceConfirmation({ restoreStatus = true } = {}) {
      if (forceConfirmTimer) clearTimeout(forceConfirmTimer);
      forceConfirmTimer = null;
      forceBtn.dataset.confirming = "false";
      forceBtn.textContent = "重新翻译";
      forceBtn.title = "清除当前字幕缓存并重新翻译";
      forceBtn.setAttribute("aria-label", "重新翻译字幕");
      if (restoreStatus && forceConfirmSnapshot) {
        setStatusText(forceConfirmSnapshot.text, forceConfirmSnapshot.kind);
      }
      forceConfirmSnapshot = null;
    }

    function requestForceTranslate() {
      if (forceBtn.dataset.confirming === "true") {
        resetForceConfirmation({ restoreStatus: false });
        handlers.onForceTranslate?.();
        return;
      }
      forceConfirmSnapshot = { text: statusText.textContent || "", kind: statusKind() };
      forceBtn.dataset.confirming = "true";
      forceBtn.textContent = "再次点击确认";
      forceBtn.title = "再次点击以清除缓存并重新发起翻译";
      forceBtn.setAttribute("aria-label", "确认清除缓存并重新翻译字幕");
      setStatusText("重新翻译会清除当前字幕缓存，并可能再次产生 API 费用。请在 6 秒内再次点击确认。", "warning");
      forceConfirmTimer = setTimeout(() => resetForceConfirmation(), 6000);
    }

    forceBtn.addEventListener("click", requestForceTranslate);

    toolbar.appendChild(collapseBtn);
    toolbar.appendChild(translateBtn);
    toolbar.appendChild(forceBtn);
    toolbar.appendChild(settingsBtn);
    toolbar.appendChild(diagnosticsBtn);
    panel.appendChild(toolbar);
    panel.appendChild(statusText);
    root.appendChild(panel);

    const actionButtons = [translateBtn, forceBtn, settingsBtn];

    return {
      el: panel,
      diagnosticsButton: diagnosticsBtn,
      settingsButton: settingsBtn,
      show() {
        panel.classList.add("echo360-panel-visible");
      },
      hide() {
        resetForceConfirmation();
        panel.classList.remove("echo360-panel-visible");
      },
      updateActionButtons(text, disabled = false) {
        resetForceConfirmation({ restoreStatus: false });
        for (const btn of actionButtons) {
          if (btn === translateBtn) btn.textContent = text;
          btn.disabled = disabled;
          btn.style.opacity = disabled ? "0.75" : "1";
        }
      },
      setStatusText,
      setStatusLive(enabled = true) {
        statusText.setAttribute("aria-live", enabled ? "polite" : "off");
      },
    };
  }

  ns.uiPanel = { create };
})();
