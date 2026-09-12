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

    const manualBtn = document.createElement("button");
    manualBtn.id = "echo360-translator-manual-btn";
    manualBtn.className = "echo360-panel-btn echo360-panel-btn--secondary";
    manualBtn.textContent = "AI 手动翻译";
    manualBtn.title = "下载完整字幕 JSON 和说明，让 AI 一次翻译并返回完整结果";
    manualBtn.setAttribute("aria-label", "打开 AI 手动翻译工作流");
    manualBtn.setAttribute("aria-controls", "echo360-manual-translation");
    manualBtn.setAttribute("aria-expanded", "false");

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
    toolbar.appendChild(manualBtn);
    toolbar.appendChild(settingsBtn);
    toolbar.appendChild(diagnosticsBtn);
    panel.appendChild(toolbar);

    const manual = document.createElement("section");
    manual.id = "echo360-manual-translation";
    manual.className = "echo360-manual-translation";
    manual.hidden = true;
    manual.setAttribute("aria-label", "AI 手动翻译");
    const manualHelp = document.createElement("p");
    manualHelp.textContent = "下载完整字幕 JSON 并复制简短说明，一次交给 AI 翻译并返回完整结果；若只有孤立的一条失败，扩展会先加载其余译文并标记待修复。不适合一次处理整份文件时，可切换逐批模式。扩展会检查 JSON、ID、数字和标记。";
    manual.appendChild(manualHelp);

    const exportRow = document.createElement("div");
    exportRow.className = "echo360-manual-row";
    const downloadVttBtn = document.createElement("button");
    downloadVttBtn.type = "button";
    downloadVttBtn.textContent = "手动下载完整 JSON";
    downloadVttBtn.disabled = true;
    let currentManualMode = null;
    let manualComplete = false;
    downloadVttBtn.addEventListener("click", () => currentManualMode === "file" && !manualComplete
      ? handlers.onManualPrepare?.() : handlers.onManualDownloadVtt?.());
    const copyPromptBtn = document.createElement("button");
    copyPromptBtn.type = "button";
    copyPromptBtn.textContent = "复制任务说明";
    copyPromptBtn.disabled = true;
    copyPromptBtn.addEventListener("click", () => handlers.onManualCopyPrompt?.());
    exportRow.append(downloadVttBtn, copyPromptBtn);
    const modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "echo360-manual-link";
    modeBtn.textContent = "AI 不能处理文件？改用逐批模式";
    modeBtn.hidden = true;
    modeBtn.addEventListener("click", () => handlers.onManualToggleMode?.());

    const downloadPromptBtn = document.createElement("button");
    downloadPromptBtn.type = "button";
    downloadPromptBtn.className = "echo360-manual-link";
    downloadPromptBtn.textContent = "剪贴板不可用？手动下载提示词 .txt";
    downloadPromptBtn.disabled = true;
    downloadPromptBtn.addEventListener("click", () => handlers.onManualDownloadPrompt?.());

    const importRow = document.createElement("div");
    importRow.className = "echo360-manual-row";
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "echo360-panel-btn echo360-panel-btn--secondary";
    importBtn.textContent = "从剪贴板导入";
    importBtn.disabled = true;
    const importFileBtn = document.createElement("button");
    importFileBtn.type = "button";
    importFileBtn.textContent = "从文件导入";
    importFileBtn.disabled = true;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".translated.json,.translate.json,.json,application/json,.vtt,text/vtt";
    fileInput.hidden = true;
    async function triggerClipboardImport() {
      let result = null;
      try {
        result = await handlers.onManualImport?.();
      } catch (error) {
        console.error("[echo360-translator][ui] manual clipboard import failed", error);
      }
      // Browsers can discard user activation while the clipboard promise is
      // pending, so do not synthesize a delayed file-input click here. Reveal
      // the explicit file action instead; it gets its own real user gesture.
      if (result === false) {
        if (!manual.hidden) importFileBtn.focus();
        return false;
      }
      return result;
    }
    importBtn.addEventListener("click", () => { void triggerClipboardImport(); });
    importFileBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0] || null;
      fileInput.value = "";
      if (file) handlers.onManualImport?.(file);
    });

    const manualStatus = document.createElement("div");
    manualStatus.className = "echo360-manual-status";
    manualStatus.setAttribute("role", "status");
    manualStatus.setAttribute("aria-live", "polite");
    importRow.append(importBtn, importFileBtn);
    manual.append(exportRow, downloadPromptBtn, modeBtn, importRow, fileInput, manualStatus);
    panel.appendChild(manual);
    panel.appendChild(statusText);
    root.appendChild(panel);

    function openManual({ prepare = true } = {}) {
      const opening = manual.hidden;
      manual.hidden = false;
      manualBtn.setAttribute("aria-expanded", "true");
      if (!opening || !prepare) return;
      // Preparation and the automatic export start from this user gesture.
      // The controller still leaves the manual download/copy controls enabled
      // as a recovery path when the browser blocks either action.
      try {
        const result = handlers.onManualPrepare?.();
        if (result && typeof result.catch === "function") result.catch((error) => {
          console.error("[echo360-translator][ui] manual preparation failed", error);
        });
      } catch (error) {
        console.error("[echo360-translator][ui] manual preparation failed", error);
      }
    }

    manualBtn.addEventListener("click", () => {
      if (manual.hidden) {
        openManual();
        return;
      }
      manual.hidden = true;
      manualBtn.setAttribute("aria-expanded", String(!manual.hidden));
    });

    const actionButtons = [translateBtn, forceBtn, manualBtn, settingsBtn];

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
      isVisible() {
        return panel.classList.contains("echo360-panel-visible");
      },
      openManual,
      triggerManualImport: triggerClipboardImport,
      focusManualFileImport() {
        importFileBtn.focus();
      },
      updateActionButtons(text, disabled = false) {
        resetForceConfirmation({ restoreStatus: false });
        for (const btn of actionButtons) {
          if (btn === translateBtn) btn.textContent = text;
          btn.disabled = disabled;
          btn.style.opacity = disabled ? "0.75" : "1";
        }
      },
      setManualReady({ cueCount = 0, targetLabel = "", warning = "", progress = null, mode = null } = {}) {
        currentManualMode = mode;
        manualComplete = !!progress?.complete;
        downloadVttBtn.disabled = false;
        downloadVttBtn.textContent = progress?.complete ? "下载完整译文 VTT" : (mode === "file" ? "手动下载完整 JSON" : "手动下载本批 JSON");
        copyPromptBtn.textContent = mode === "file" ? "复制任务说明" : "复制本批材料";
        modeBtn.hidden = !progress || !!progress.complete;
        modeBtn.disabled = false;
        modeBtn.textContent = mode === "file" ? "AI 不能一次处理整份文件？改用逐批模式" : "切回整份 JSON 模式（推荐）";
        copyPromptBtn.disabled = !!progress?.complete;
        downloadPromptBtn.disabled = !!progress?.complete;
        importBtn.disabled = !!progress?.complete;
        importFileBtn.disabled = !!progress?.complete;
        manualHelp.textContent = mode === "file" && progress
          ? `已接受 ${progress.completed}/${progress.total} 条。${progress.complete ? "完整译文可下载保存。" : "下载完整 JSON 和说明一次交给 AI，返回完整结果；扩展会检查 JSON、ID、数字和标记。"} 最近一节课的进度保存在本机。`
          : progress
          ? `已完成 ${progress.completed}/${progress.total} 条${progress.complete ? "，全部译文已准备好" : `，当前第 ${progress.part} 批`}。复制材料 → 粘贴给 AI → 导入结果；进度保存在本机（最近一节课），刷新后可继续。`
          : "复制材料 → 粘贴给 AI → 导入结果。长课自动分批，缺漏只需补译；全部完成后加载。";
        manualStatus.textContent = warning || (progress ? `已完成 ${progress.completed}/${progress.total} 条，目标：${targetLabel}` : `已准备 ${cueCount} 个 cue，目标：${targetLabel}`);
        manualStatus.dataset.kind = warning ? "warning" : "success";
      },
      setManualBusy(message = "处理中…") {
        modeBtn.disabled = true;
        downloadVttBtn.disabled = true;
        copyPromptBtn.disabled = true;
        downloadPromptBtn.disabled = true;
        importBtn.disabled = true;
        importFileBtn.disabled = true;
        manualStatus.textContent = message;
        manualStatus.dataset.kind = "info";
      },
      setManualMessage(message, kind = "info") {
        manualStatus.textContent = String(message || "");
        manualStatus.dataset.kind = kind;
      },
      setStatusText,
      setStatusLive(enabled = true) {
        statusText.setAttribute("aria-live", enabled ? "polite" : "off");
      },
    };
  }

  ns.uiPanel = { create };
})();
