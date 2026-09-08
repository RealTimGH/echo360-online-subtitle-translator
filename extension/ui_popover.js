(() => {
  const ns = window.Echo360Translator;
  const { TARGET_OPTIONS, TARGET_LABELS, DEFAULT_SUBTITLE_SIZE, PROVIDER_LABELS, STORAGE_KEY } = ns.constants;

  function openOptionsPage() {
    try {
      const result = ns.browserApi?.runtime?.sendMessage
        ? ns.browserApi.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" })
        : chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
      const handleResponse = (response) => {
        if (response && response.ok === false) {
          ns.ui?.showError?.(response, { phase: "preferences" });
        }
        return response;
      };
      if (result && typeof result.then === "function") {
        result.then(handleResponse).catch((error) => ns.ui?.showError?.(error, { phase: "preferences" }));
      }
    } catch (error) {
      console.error("[echo360-translator][ui] opening options failed", ns.errorUtils?.serializeError?.(error, { phase: "preferences" }) || {
        code: "RUNTIME_MESSAGE_ERROR",
        message: String(error?.message || error || "打开设置失败"),
      });
      ns.ui?.showError?.(error, { phase: "preferences" });
    }
  }

  function styleDisabledControl(control, disabled) {
    if (!control) return;
    control.style.opacity = disabled ? "0.45" : "";
    control.style.cursor = disabled ? "not-allowed" : "";
    control.style.filter = disabled ? "grayscale(1)" : "";
  }

  // The "翻译字幕设置" popover: per-lesson display prefs, target language,
  // and a read-only summary of the active translation provider with a link
  // out to the full options page.
  function create(root, handlers, { trigger = null } = {}) {
    let browserModePrefs = { bilingual: false, reverseOrder: false };
    let previouslyFocused = null;

    const pop = document.createElement("div");
    pop.id = "echo360-translator-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-labelledby", "echo360-popover-title");
    // Explicit inline display:none so the JS toggle (=== "none") works correctly.
    pop.style.display = "none";
    pop.innerHTML = `
      <div class="echo360-popover-header">
        <div id="echo360-popover-title" class="echo360-popover-title" tabindex="-1">翻译字幕设置</div>
        <button type="button" class="echo360-popover-close" aria-label="关闭字幕设置" title="关闭字幕设置">×</button>
      </div>
      <div class="echo360-popover-provider-row">
        <span>翻译服务：<strong id="echo360-current-provider">-</strong></span>
        <button id="echo360-change-provider-btn" class="echo360-popover-link-btn echo360-popover-link-btn--underline">更改</button>
      </div>
      <label class="echo360-popover-row">
        <span>显示翻译字幕</span>
        <input id="echo360-pref-enabled" type="checkbox" />
      </label>
      <label class="echo360-popover-row">
        <span>增强 Transcript 面板</span>
        <input id="echo360-pref-transcript-panel" type="checkbox" />
      </label>
      <label id="echo360-pref-bilingual-label" class="echo360-popover-row">
        <span>双语字幕</span>
        <input id="echo360-pref-bilingual" type="checkbox" />
      </label>
      <label id="echo360-pref-reverse-label" class="echo360-popover-row">
        <span>反转字幕位置</span>
        <input id="echo360-pref-reverse" type="checkbox" />
      </label>
      <label class="echo360-popover-row">
        <span class="echo360-beta-pref-label">
          <span>使用原生字幕注入（Beta）</span>
          <span
            class="echo360-beta-notice-icon"
            role="img"
            tabindex="0"
            aria-label="该实验功能有开启须知"
            aria-describedby="echo360-beta-notice-tip"
          >
            !
            <span id="echo360-beta-notice-tip" class="echo360-beta-notice-tip" role="tooltip">
              实验功能：把译文注入 Echo360 播放器自带的 CC 区域，外观更贴近原生字幕。倍速播放时仍可能漏译；默认使用更稳定的浏览器字幕轨。本课程没有原生字幕位时会自动回退。
            </span>
          </span>
        </span>
        <input id="echo360-pref-echo360-native-cc" type="checkbox" />
      </label>
      <label id="echo360-pref-size-label" class="echo360-popover-block-label">字幕大小
        <select id="echo360-pref-size" class="echo360-popover-select">
          <option value="small">小</option>
          <option value="medium">中</option>
          <option value="large">大</option>
        </select>
      </label>
      <label class="echo360-popover-block-label">目标语言
        <select id="echo360-pref-target" class="echo360-popover-select">
          ${TARGET_OPTIONS.map((t) => `<option value="${t}">${(TARGET_LABELS && TARGET_LABELS[t]) || t}</option>`).join("")}
        </select>
      </label>
      <div class="echo360-popover-divider"></div>
      <button id="echo360-open-options-btn" class="echo360-popover-link-btn" title="打开完整设置">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.49.49 0 0 0 13.92 2h-3.84a.49.49 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.47c-.12.22-.07.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94L2.86 14.12c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"/>
        </svg>
        设置
      </button>
    `;
    (root || document.body).appendChild(pop);

    const refs = {
      currentProvider: pop.querySelector("#echo360-current-provider"),
      enabled: pop.querySelector("#echo360-pref-enabled"),
      transcriptPanelEnabled: pop.querySelector("#echo360-pref-transcript-panel"),
      bilingual: pop.querySelector("#echo360-pref-bilingual"),
      bilingualLabel: pop.querySelector("#echo360-pref-bilingual-label"),
      reverseOrder: pop.querySelector("#echo360-pref-reverse"),
      reverseOrderLabel: pop.querySelector("#echo360-pref-reverse-label"),
      nativeCc: pop.querySelector("#echo360-pref-echo360-native-cc"),
      size: pop.querySelector("#echo360-pref-size"),
      sizeLabel: pop.querySelector("#echo360-pref-size-label"),
      target: pop.querySelector("#echo360-pref-target"),
      close: pop.querySelector(".echo360-popover-close"),
      title: pop.querySelector("#echo360-popover-title"),
    };

    function isVisible() {
      return pop.style.display !== "none";
    }

    function hide({ restoreFocus = false } = {}) {
      if (!isVisible()) return;
      pop.style.display = "none";
      trigger?.setAttribute?.("aria-expanded", "false");
      if (restoreFocus) {
        const focusTarget = trigger || previouslyFocused;
        if (focusTarget?.isConnected !== false) focusTarget?.focus?.();
      }
      previouslyFocused = null;
    }

    refs.close.addEventListener("click", () => hide({ restoreFocus: true }));
    pop.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hide({ restoreFocus: true });
    });

    function syncRenderModeControls() {
      // Bilingual/reverse-order/size only apply to the browser <track>
      // renderer: native CC injection always adds a single translated line
      // into Echo360's own caption box, so those controls are only meaningful
      // (and editable) when the Beta native-CC checkbox is off.
      const nativeCcMode = !!refs.nativeCc.checked;
      refs.bilingual.disabled = nativeCcMode;
      refs.reverseOrder.disabled = nativeCcMode;
      refs.size.disabled = nativeCcMode;
      styleDisabledControl(refs.bilingual, nativeCcMode);
      styleDisabledControl(refs.reverseOrder, nativeCcMode);
      styleDisabledControl(refs.size, nativeCcMode);
      refs.bilingual.checked = !!browserModePrefs.bilingual;
      refs.reverseOrder.checked = !!browserModePrefs.reverseOrder;

      for (const label of [refs.bilingualLabel, refs.reverseOrderLabel, refs.sizeLabel]) {
        label.classList.toggle("is-disabled", nativeCcMode);
      }
    }

    // Reflects the currently configured provider in the read-only "翻译服务"
    // row. Called on open, and whenever config changes elsewhere (popup /
    // options page) so the label doesn't go stale without needing a re-open.
    function applyProviderLabel(cfg) {
      const providerKey = String(cfg.provider || "google-web").toLowerCase();
      refs.currentProvider.textContent = PROVIDER_LABELS[providerKey] || cfg.provider || "未知";
    }

    ns.browserApi.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      const newConfig = changes[STORAGE_KEY].newValue;
      if (newConfig) applyProviderLabel(newConfig);
    });

    pop.querySelector("#echo360-open-options-btn").addEventListener("click", openOptionsPage);
    pop.querySelector("#echo360-change-provider-btn").addEventListener("click", openOptionsPage);
    refs.enabled.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.transcriptPanelEnabled.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.bilingual.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.reverseOrder.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.nativeCc.addEventListener("change", () => {
      if (refs.nativeCc.checked) {
        // Switching into Beta native CC mode: snapshot the browser-mode
        // values before their controls become disabled, so they can be
        // restored if the user switches back later.
        browserModePrefs = {
          bilingual: refs.bilingual.checked,
          reverseOrder: refs.reverseOrder.checked,
        };
      }
      syncRenderModeControls();
      handlers.onPrefsChanged?.();
    });
    refs.size.addEventListener("change", () => handlers.onPrefsChanged?.());
    refs.target.addEventListener("change", (event) => handlers.onTargetChanged?.(event));

    async function toggle() {
      const show = !isVisible();
      if (!show) {
        hide({ restoreFocus: true });
        return false;
      }

      previouslyFocused = document.activeElement;
      pop.style.display = "block";
      trigger?.setAttribute?.("aria-expanded", "true");

      try {
        const prefs = await ns.storage.getPrefs();
        const cfg = await ns.storage.getConfig();
        browserModePrefs = {
          bilingual: prefs.browserBilingual ?? (prefs.useNativeSubtitles === true ? !!prefs.bilingual : false),
          reverseOrder: prefs.browserReverseOrder ?? (prefs.useNativeSubtitles === true ? !!prefs.reverseOrder : false),
        };
        applyProviderLabel(cfg);
        refs.enabled.checked = !!prefs.enabled;
        refs.transcriptPanelEnabled.checked = prefs.transcriptPanelEnabled !== false;
        refs.bilingual.checked = !!browserModePrefs.bilingual;
        refs.reverseOrder.checked = !!browserModePrefs.reverseOrder;
        // Checked = Beta native CC injection; unchecked = default browser track.
        // (prefs.useNativeSubtitles===true still means "use browser track".)
        refs.nativeCc.checked = prefs.useNativeSubtitles !== true;
        syncRenderModeControls();
        refs.size.value = prefs.size || DEFAULT_SUBTITLE_SIZE;
        refs.target.value = (cfg.target || "ZH").toUpperCase();
        // The user may close the popover while asynchronous storage reads are
        // in flight. Do not steal focus back into an element that is now
        // hidden after their explicit close action.
        if (!isVisible()) return false;
        refs.close.focus();
        return true;
      } catch (error) {
        console.error("[echo360-translator][ui] settings load failed", ns.errorUtils?.serializeError?.(error, { phase: "preferences" }) || {
          code: "STORAGE_ERROR",
          message: String(error?.message || error || "设置读取失败"),
        });
        hide({ restoreFocus: true });
        ns.ui?.showError?.(error, {
          phase: "preferences",
          code: "STORAGE_ERROR",
          onCancel: () => ns.ui?.clearError?.(),
        });
        return false;
      }
    }

    function readPrefs() {
      const nativeCcMode = !!refs.nativeCc.checked;
      const forceBrowserTrack = !nativeCcMode;
      if (forceBrowserTrack) {
        browserModePrefs = {
          bilingual: refs.bilingual.checked,
          reverseOrder: refs.reverseOrder.checked,
        };
      }
      return {
        enabled: refs.enabled.checked,
        transcriptPanelEnabled: refs.transcriptPanelEnabled.checked,
        bilingual: nativeCcMode ? true : browserModePrefs.bilingual,
        reverseOrder: nativeCcMode ? false : browserModePrefs.reverseOrder,
        browserBilingual: browserModePrefs.bilingual,
        browserReverseOrder: browserModePrefs.reverseOrder,
        useNativeSubtitles: forceBrowserTrack,
        size: refs.size.value || DEFAULT_SUBTITLE_SIZE,
      };
    }

    return {
      el: pop,
      toggle,
      hide,
      isVisible,
      readPrefs,
    };
  }

  ns.uiPopover = { create };
})();
