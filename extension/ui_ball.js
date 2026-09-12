(() => {
  const ns = window.Echo360Translator;

  const QUICK_ICON = `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/>
    <path d="M8 9.2v5.6l4.7-2.8L8 9.2Z" fill="currentColor"/>
    <path d="M15.2 10h3M15.2 13h3M15.2 16h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  const PANEL_ICON = `<svg data-icon="controls" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 6h14M5 12h14M5 18h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    <circle cx="9" cy="6" r="2" fill="currentColor"/>
    <circle cx="15" cy="12" r="2" fill="currentColor"/>
    <circle cx="11" cy="18" r="2" fill="currentColor"/>
  </svg>`;
  const IMPORT_ICON = `<svg data-icon="import" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="5" y="4" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.8"/>
    <path d="M9 4V3h6v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 17v-7m0 0 3 3m-3-3-3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  function invoke(handler, label) {
    try {
      const result = handler?.();
      if (result && typeof result.catch === "function") {
        result.catch((error) => console.error(`[echo360-translator][ui] ${label} failed`, error));
      }
      return result;
    } catch (error) {
      console.error(`[echo360-translator][ui] ${label} failed`, error);
      return null;
    }
  }

  // Split floating action control: the large, easy-to-hit primary surface
  // performs the common one-click workflow. Two explicit secondary targets
  // retain panel access and provide direct AI JSON import without using
  // double-click, long-press, right-click, or another hidden gesture.
  function create(root, { onQuickTranslate, onOpenPanel, onImport } = {}) {
    const group = document.createElement("div");
    group.id = "echo360-translator-ball-group";

    const ball = document.createElement("button");
    ball.type = "button";
    ball.id = "echo360-translator-ball";
    ball.innerHTML = QUICK_ICON;
    ball.title = "一键加载翻译，并导出 AI 翻译材料";
    ball.setAttribute("aria-label", "一键加载翻译字幕并导出 AI 翻译材料");
    ball.addEventListener("click", () => invoke(onQuickTranslate, "quick translation"));

    const secondary = document.createElement("div");
    secondary.className = "echo360-ball-secondary";

    const panelButton = document.createElement("button");
    panelButton.type = "button";
    panelButton.id = "echo360-translator-ball-panel";
    panelButton.innerHTML = PANEL_ICON;
    panelButton.title = "展开字幕翻译控制面板";
    panelButton.setAttribute("aria-label", "展开字幕翻译控制面板");
    panelButton.setAttribute("aria-controls", "echo360-translator-panel");
    panelButton.setAttribute("aria-expanded", "false");
    panelButton.addEventListener("click", () => invoke(onOpenPanel, "panel open"));

    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.id = "echo360-translator-ball-import";
    importButton.innerHTML = IMPORT_ICON;
    importButton.title = "AI 材料准备完成后，可在这里快捷导入 AI 译文";
    importButton.setAttribute("aria-label", "快捷导入 AI 翻译后的 JSON 译文");
    importButton.disabled = true;
    importButton.addEventListener("click", () => invoke(onImport, "manual translation import"));

    secondary.append(panelButton, importButton);
    group.append(secondary, ball);
    root.appendChild(group);

    return {
      el: group,
      hide() {
        group.classList.add("echo360-ball-hidden");
      },
      show() {
        group.classList.remove("echo360-ball-hidden");
      },
      pulse() {
        group.classList.add("echo360-ball-pulse");
      },
      stopPulse() {
        group.classList.remove("echo360-ball-pulse");
      },
      setBusy(busy = false) {
        ball.disabled = busy;
        group.classList.toggle("echo360-ball-busy", busy);
        group.setAttribute("aria-busy", String(busy));
      },
      setStatus(message = "", kind = "info") {
        const text = String(message || "").trim();
        group.dataset.kind = kind;
        if (text) {
          ball.title = text;
          ball.setAttribute("aria-label", `一键字幕翻译：${text}`);
        } else {
          ball.title = "一键加载翻译，并导出 AI 翻译材料";
          ball.setAttribute("aria-label", "一键加载翻译字幕并导出 AI 翻译材料");
        }
      },
      setImportReady(ready = false) {
        importButton.disabled = !ready;
        importButton.title = ready
          ? "快捷导入 AI 翻译后的 JSON（也兼容旧 VTT；优先读取剪贴板）"
          : "字幕材料准备完成后即可快捷导入 AI 译文";
      },
      setPanelExpanded(expanded = false) {
        panelButton.setAttribute("aria-expanded", String(expanded));
      },
    };
  }

  ns.uiBall = { create };
})();
