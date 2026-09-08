(() => {
  const ns = window.Echo360Translator;
  const { SUBTITLE_FAILURE_LABEL } = ns.constants;

  function fallbackModel() {
    return {
      code: "ERROR_DETAILS_MISSING",
      title: "错误详情缺失",
      summary: "界面收到失败通知，但没有收到可展示的错误码、原因或诊断详情。",
      recommendation: "请查看 Console，重新加载扩展和页面后重试。",
      severity: "error",
      details: [{ label: "诊断状态", value: "未提供结构化错误信息" }],
      copyText: "错误详情缺失 [ERROR_DETAILS_MISSING]",
    };
  }

  function readyModel() {
    return {
      kind: "ready",
      code: "READY",
      title: "运行诊断",
      summary: "当前没有错误。扩展的运行日志会显示在下方。",
      recommendation: "执行翻译或重试操作后，可在这里查看字幕查找、翻译和渲染过程。",
      severity: "info",
      details: [],
      copyText: "Echo360 字幕翻译运行诊断：当前没有错误。",
    };
  }

  async function copyText(text) {
    const value = String(text || "");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {
      console.warn("[echo360-translator][ui] clipboard API unavailable; trying legacy copy fallback");
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand?.("copy") === true;
      textarea.remove();
      if (!copied) {
        const copyError = new Error("浏览器拒绝了剪贴板写入");
        copyError.code = "CLIPBOARD_COPY_FAILED";
        console.error("[echo360-translator][ui] copying error diagnostics failed", copyError);
      }
      return copied;
    } catch (error) {
      const copyError = new Error(error?.message || "无法复制错误详情");
      copyError.code = "CLIPBOARD_COPY_FAILED";
      console.error("[echo360-translator][ui] copying error diagnostics failed", copyError);
      return false;
    }
  }

  // WebVTT/native CC text cannot host real links. This panel is the interactive
  // diagnosis extension of the floating control panel: it explains the
  // current problem, provides retry/copy/close actions, and keeps a short
  // session-only history beside the three translation controls. The history
  // is intentionally not stored in extension storage because it may contain
  // page-specific diagnostics.
  function create(root, { toggleButton } = {}) {
    const extension = document.createElement("div");
    extension.id = "echo360-translator-diagnostics-extension";
    extension.className = "echo360-diagnostics-extension";
    extension.setAttribute("aria-label", "字幕翻译运行诊断扩展");
    extension.style.display = "none";
    extension.hidden = true;
    extension.setAttribute("aria-hidden", "true");

    const panel = document.createElement("section");
    panel.id = "echo360-translator-failure-actions";
    panel.setAttribute("aria-label", "字幕翻译运行诊断");
    // Keep the interactive card out of the live region. `alert`/`status`
    // regions should announce the diagnosis, not re-announce every button
    // label and every expanded diagnostic row whenever the card changes.
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-live", "off");
    panel.setAttribute("aria-labelledby", "echo360-error-title");
    panel.setAttribute("aria-describedby", "echo360-error-summary echo360-error-recommendation");
    // Keep the extension mounted so the original floating panel remains its
    // layout owner, but do not expose the full diagnosis until the compact
    // trigger in that panel is clicked.
    panel.style.display = "none";
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <div class="echo360-error-header">
        <div class="echo360-error-announcement" role="status" aria-live="polite" aria-atomic="true">
          <div class="echo360-error-context">当前问题</div>
          <div class="echo360-error-heading">
            <span class="echo360-error-severity">翻译错误</span>
            <span class="echo360-error-code"></span>
          </div>
          <div id="echo360-error-title" class="echo360-error-title"></div>
          <div id="echo360-error-summary" class="echo360-error-summary"></div>
          <div id="echo360-error-recommendation" class="echo360-error-recommendation"></div>
        </div>
        <button type="button" class="echo360-error-close" data-action="close" aria-label="关闭错误详情">×</button>
      </div>
      <details class="echo360-error-details">
        <summary>诊断详情</summary>
        <div class="echo360-error-detail-list"></div>
      </details>
      <div class="echo360-error-actions">
        <button type="button" class="echo360-failure-link" data-action="retry">重新翻译</button>
        <button type="button" class="echo360-failure-link" data-action="copy">复制错误信息</button>
        <button type="button" class="echo360-failure-link" data-action="cancel">取消</button>
      </div>
    `;
    extension.appendChild(panel);

    const logsPanel = document.createElement("section");
    logsPanel.id = "echo360-translator-runtime-logs";
    logsPanel.className = "echo360-runtime-logs";
    logsPanel.setAttribute("role", "region");
    logsPanel.setAttribute("aria-labelledby", "echo360-runtime-logs-title");
    logsPanel.innerHTML = `
      <div class="echo360-runtime-logs-header">
        <button type="button" class="echo360-runtime-logs-toggle" aria-expanded="true" aria-controls="echo360-runtime-logs-content">
          <span id="echo360-runtime-logs-title">运行日志</span>
          <span class="echo360-runtime-logs-total" aria-hidden="true">0</span>
          <span class="echo360-runtime-logs-chevron" aria-hidden="true">⌃</span>
        </button>
        <div class="echo360-runtime-logs-actions">
          <button type="button" class="echo360-runtime-logs-copy">复制日志</button>
          <button type="button" class="echo360-runtime-logs-clear">清空</button>
        </div>
      </div>
      <div id="echo360-runtime-logs-content" class="echo360-runtime-logs-content">
        <div class="echo360-runtime-logs-overview" aria-live="polite">等待扩展日志…</div>
        <div class="echo360-runtime-logs-tools">
          <label class="echo360-runtime-logs-search-wrap">
            <span class="echo360-sr-only">搜索运行日志</span>
            <input type="search" class="echo360-runtime-logs-search" placeholder="搜索日志、阶段或运行 ID…" autocomplete="off" spellcheck="false">
          </label>
          <div class="echo360-runtime-logs-filters" role="group" aria-label="按日志级别筛选">
            <button type="button" data-log-filter="all" aria-pressed="true">全部 <span data-log-count="all">0</span></button>
            <button type="button" data-log-filter="debug" aria-pressed="false">调试 <span data-log-count="debug">0</span></button>
            <button type="button" data-log-filter="info" aria-pressed="false">信息 <span data-log-count="info">0</span></button>
            <button type="button" data-log-filter="warn" aria-pressed="false">警告 <span data-log-count="warn">0</span></button>
            <button type="button" data-log-filter="error" aria-pressed="false">错误 <span data-log-count="error">0</span></button>
          </div>
        </div>
        <div class="echo360-runtime-logs-empty" role="status">暂无运行日志</div>
        <ol class="echo360-runtime-logs-list" aria-label="扩展运行日志"></ol>
      </div>
      <div class="echo360-runtime-logs-feedback" role="status" aria-live="polite" aria-atomic="true"></div>
    `;
    extension.appendChild(logsPanel);

    const historyPanel = document.createElement("section");
    historyPanel.id = "echo360-translator-error-history";
    historyPanel.className = "echo360-error-history";
    historyPanel.setAttribute("role", "region");
    historyPanel.setAttribute("aria-labelledby", "echo360-error-history-title");
    historyPanel.style.display = "none";
    historyPanel.innerHTML = `
      <div class="echo360-error-history-header">
        <button type="button" class="echo360-error-history-toggle" aria-expanded="true" aria-controls="echo360-error-history-content">
          <span id="echo360-error-history-title">错误历史</span>
          <span class="echo360-error-history-total" aria-hidden="true">0</span>
          <span class="echo360-error-history-chevron" aria-hidden="true">⌃</span>
        </button>
        <div class="echo360-error-history-actions">
          <button type="button" class="echo360-error-history-copy">复制列表</button>
          <button type="button" class="echo360-error-history-clear">清空</button>
        </div>
      </div>
      <div id="echo360-error-history-content" class="echo360-error-history-content">
        <div class="echo360-error-history-overview" aria-live="polite"></div>
        <div class="echo360-error-history-tools">
          <label class="echo360-error-history-search-wrap">
            <span class="echo360-sr-only">搜索错误历史</span>
            <input type="search" class="echo360-error-history-search" placeholder="搜索错误码、原因、阶段…" autocomplete="off" spellcheck="false">
          </label>
          <div class="echo360-error-history-filters" role="group" aria-label="按严重程度筛选">
            <button type="button" data-filter="all" aria-pressed="true">全部 <span data-count="all">0</span></button>
            <button type="button" data-filter="error" aria-pressed="false">错误 <span data-count="error">0</span></button>
            <button type="button" data-filter="warning" aria-pressed="false">警告 <span data-count="warning">0</span></button>
          </div>
        </div>
        <div class="echo360-error-history-empty" role="status">当前页面还没有错误记录</div>
        <ol class="echo360-error-history-list" aria-label="错误历史记录"></ol>
      </div>
      <div class="echo360-error-history-feedback" role="status" aria-live="polite" aria-atomic="true"></div>
    `;
    extension.appendChild(historyPanel);
    root.appendChild(extension);

    const refs = {
      severity: panel.querySelector(".echo360-error-severity"),
      context: panel.querySelector(".echo360-error-context"),
      code: panel.querySelector(".echo360-error-code"),
      announcement: panel.querySelector(".echo360-error-announcement"),
      title: panel.querySelector(".echo360-error-title"),
      summary: panel.querySelector(".echo360-error-summary"),
      recommendation: panel.querySelector(".echo360-error-recommendation"),
      details: panel.querySelector(".echo360-error-details"),
      detailList: panel.querySelector(".echo360-error-detail-list"),
      actions: panel.querySelector(".echo360-error-actions"),
      retry: panel.querySelector('[data-action="retry"]'),
      copy: panel.querySelector('[data-action="copy"]'),
      cancel: panel.querySelector('[data-action="cancel"]'),
      close: panel.querySelector('[data-action="close"]'),
    };
    const historyRefs = {
      list: historyPanel.querySelector(".echo360-error-history-list"),
      empty: historyPanel.querySelector(".echo360-error-history-empty"),
      content: historyPanel.querySelector(".echo360-error-history-content"),
      toggle: historyPanel.querySelector(".echo360-error-history-toggle"),
      total: historyPanel.querySelector(".echo360-error-history-total"),
      chevron: historyPanel.querySelector(".echo360-error-history-chevron"),
      overview: historyPanel.querySelector(".echo360-error-history-overview"),
      search: historyPanel.querySelector(".echo360-error-history-search"),
      filters: Array.from(historyPanel.querySelectorAll("[data-filter]")),
      counts: {
        all: historyPanel.querySelector('[data-count="all"]'),
        error: historyPanel.querySelector('[data-count="error"]'),
        warning: historyPanel.querySelector('[data-count="warning"]'),
      },
      copy: historyPanel.querySelector(".echo360-error-history-copy"),
      clear: historyPanel.querySelector(".echo360-error-history-clear"),
      feedback: historyPanel.querySelector(".echo360-error-history-feedback"),
    };
    const logRefs = {
      list: logsPanel.querySelector(".echo360-runtime-logs-list"),
      empty: logsPanel.querySelector(".echo360-runtime-logs-empty"),
      content: logsPanel.querySelector(".echo360-runtime-logs-content"),
      toggle: logsPanel.querySelector(".echo360-runtime-logs-toggle"),
      total: logsPanel.querySelector(".echo360-runtime-logs-total"),
      chevron: logsPanel.querySelector(".echo360-runtime-logs-chevron"),
      overview: logsPanel.querySelector(".echo360-runtime-logs-overview"),
      search: logsPanel.querySelector(".echo360-runtime-logs-search"),
      filters: Array.from(logsPanel.querySelectorAll("[data-log-filter]")),
      counts: {
        all: logsPanel.querySelector('[data-log-count="all"]'),
        debug: logsPanel.querySelector('[data-log-count="debug"]'),
        info: logsPanel.querySelector('[data-log-count="info"]'),
        warn: logsPanel.querySelector('[data-log-count="warn"]'),
        error: logsPanel.querySelector('[data-log-count="error"]'),
      },
      copy: logsPanel.querySelector(".echo360-runtime-logs-copy"),
      clear: logsPanel.querySelector(".echo360-runtime-logs-clear"),
      feedback: logsPanel.querySelector(".echo360-runtime-logs-feedback"),
    };
    const actionHandlers = { onRetry: null, onCancel: null };
    let currentModel = readyModel();
    let liveModel = null;
    let hasLiveModel = false;
    const history = [];
    const maxHistoryEntries = 25;
    const logs = [];
    const maxLogEntries = 240;
    let nextHistoryId = 1;
    let nextLogId = 1;
    let activeFilter = "all";
    let searchQuery = "";
    let activeLogFilter = "all";
    let logSearchQuery = "";
    let selectedHistoryId = null;
    let clearConfirmationTimer = null;
    let logClearConfirmationTimer = null;
    let feedbackTimer = null;
    let logFeedbackTimer = null;

    function isPanelVisible() {
      return extension.style.display !== "none" && extension.hidden !== true;
    }

    function setPanelVisible(visible) {
      const nextVisible = visible === true;
      extension.style.display = nextVisible ? "flex" : "none";
      extension.hidden = !nextVisible;
      extension.setAttribute("aria-hidden", nextVisible ? "false" : "true");
      panel.style.display = nextVisible ? "flex" : "none";
      panel.hidden = !nextVisible;
      panel.setAttribute("aria-hidden", nextVisible ? "false" : "true");
      syncRootDiagnosticsState();
      return nextVisible;
    }

    function syncRootDiagnosticsState() {
      const owner = root?.closest?.("#echo360-translator-panel") || root;
      owner?.classList.toggle(
        "echo360-panel-has-diagnostics",
        isPanelVisible()
      );
      historyPanel.style.display = history.length > 0 ? "block" : "none";

      if (toggleButton) {
        const hasFailure = hasLiveModel;
        const hasHistory = history.length > 0;
        const warning = hasFailure && currentModel?.severity === "warning";
        const label = hasFailure
          ? (warning ? "查看翻译警告" : "查看失败详情")
          : (hasHistory ? "查看错误历史" : "运行诊断");
        // Keep one compact entry point available even before the first
        // failure so captured runtime logs remain inspectable. Only the
        // detailed extension is hidden until this button is activated.
        toggleButton.hidden = false;
        toggleButton.setAttribute("aria-hidden", "false");
        toggleButton.setAttribute("aria-expanded", isPanelVisible() ? "true" : "false");
        toggleButton.setAttribute("aria-label", isPanelVisible() ? `${label}（收起）` : label);
        toggleButton.title = isPanelVisible() ? "收起运行诊断" : "查看翻译失败详情和运行诊断";
        toggleButton.textContent = label;
        toggleButton.classList.toggle("echo360-panel-btn--diagnostics-error", hasFailure && !warning);
        toggleButton.classList.toggle("echo360-panel-btn--diagnostics-warning", warning);
      }
    }

    function modelFingerprint(model) {
      return [
        model?.code,
        model?.phase,
        model?.provider,
        model?.target,
        model?.status,
        model?.upstreamStatus,
        model?.runId,
        model?.jobId,
        model?.summary,
        model?.recommendation,
      ]
        .map((value) => String(value || ""))
        .join("\u0001");
    }

    function formatHistoryTime(timestamp) {
      try {
        return new Date(timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      } catch (_) {
        return "刚刚";
      }
    }

    function formatFullTimestamp(timestamp) {
      try {
        return new Date(timestamp).toLocaleString([], {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
      } catch (_) {
        return formatHistoryTime(timestamp);
      }
    }

    function setHistoryFeedback(message, duration = 2600) {
      historyRefs.feedback.textContent = String(message || "");
      if (feedbackTimer) clearTimeout(feedbackTimer);
      feedbackTimer = message && duration > 0
        ? setTimeout(() => { historyRefs.feedback.textContent = ""; }, duration)
        : null;
    }

    function setLogFeedback(message, duration = 2600) {
      logRefs.feedback.textContent = String(message || "");
      if (logFeedbackTimer) clearTimeout(logFeedbackTimer);
      logFeedbackTimer = message && duration > 0
        ? setTimeout(() => { logRefs.feedback.textContent = ""; }, duration)
        : null;
    }

    function normalizeLogLevel(level) {
      const value = String(level || "info").toLowerCase();
      if (value === "debug") return "debug";
      if (value === "warn" || value === "warning") return "warn";
      if (value === "error") return "error";
      return "info";
    }

    function formatLogMessage(values) {
      const args = Array.isArray(values) ? values : [values];
      const formatted = ns.errorUtils?.formatDebugLog?.(args);
      if (formatted) return formatted;
      return args.map((value) => {
        if (value == null) return "";
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch (_) {
          return String(value);
        }
      }).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 2_400);
    }

    function logSearchText(entry) {
      return [entry.level, entry.message, formatHistoryTime(entry.occurredAt)]
        .map((value) => String(value ?? "").toLocaleLowerCase())
        .join("\n");
    }

    function visibleLogs() {
      return logs.filter((entry) => {
        if (activeLogFilter !== "all" && entry.level !== activeLogFilter) return false;
        return !logSearchQuery || logSearchText(entry).includes(logSearchQuery);
      });
    }

    function logCopyText(entry) {
      return `[${formatFullTimestamp(entry.occurredAt)}] ${entry.level.toUpperCase()} ${entry.message}`;
    }

    function renderLogs() {
      logRefs.list.replaceChildren();
      const counts = {
        all: logs.length,
        debug: logs.filter((entry) => entry.level === "debug").length,
        info: logs.filter((entry) => entry.level === "info").length,
        warn: logs.filter((entry) => entry.level === "warn").length,
        error: logs.filter((entry) => entry.level === "error").length,
      };
      const visible = visibleLogs();
      logRefs.total.textContent = String(logs.length);
      for (const key of Object.keys(logRefs.counts)) {
        logRefs.counts[key].textContent = String(counts[key]);
      }
      logRefs.overview.textContent = logs.length === 0
        ? "等待扩展日志…"
        : `${logs.length} 条日志 · 调试 ${counts.debug} · 信息 ${counts.info} · 警告 ${counts.warn} · 错误 ${counts.error}`;
      logRefs.empty.hidden = visible.length > 0;
      logRefs.empty.textContent = logs.length === 0
        ? "暂无运行日志"
        : "没有符合当前筛选条件的日志";
      logRefs.copy.disabled = visible.length === 0;
      logRefs.copy.textContent = visible.length === logs.length ? "复制日志" : `复制结果 (${visible.length})`;

      for (const entry of visible) {
        const row = document.createElement("li");
        row.className = `echo360-runtime-log-item is-${entry.level}`;

        const line = document.createElement("div");
        line.className = "echo360-runtime-log-line";
        const level = document.createElement("span");
        level.className = "echo360-runtime-log-level";
        level.textContent = entry.level.toUpperCase();
        const time = document.createElement("time");
        time.className = "echo360-runtime-log-time";
        time.dateTime = new Date(entry.occurredAt).toISOString();
        time.textContent = formatHistoryTime(entry.occurredAt);
        time.title = formatFullTimestamp(entry.occurredAt);
        line.append(level, time);

        const message = document.createElement("div");
        message.className = "echo360-runtime-log-message";
        message.textContent = entry.message;
        row.append(line, message);
        logRefs.list.appendChild(row);
      }
    }

    function recordLog(level, values, occurredAt = Date.now()) {
      const message = formatLogMessage(values);
      if (!message) return null;
      const entry = {
        id: nextLogId,
        level: normalizeLogLevel(level),
        message,
        occurredAt: Number.isFinite(Number(occurredAt)) ? Number(occurredAt) : Date.now(),
      };
      nextLogId += 1;
      logs.push(entry);
      if (logs.length > maxLogEntries) logs.splice(0, logs.length - maxLogEntries);
      renderLogs();
      return entry;
    }

    function appendLog(level, ...values) {
      let occurredAt = Date.now();
      let args = values;
      // Console capture passes the original argument array and timestamp as
      // separate values. The public API also accepts appendLog(level, ...args).
      if (values.length === 2 && Array.isArray(values[0]) && Number.isFinite(Number(values[1]))) {
        args = values[0];
        occurredAt = Number(values[1]);
      } else if (values.length === 1 && Array.isArray(values[0])) {
        args = values[0];
      }
      return recordLog(level, args, occurredAt);
    }

    function clearLogs() {
      resetLogClearConfirmation();
      logs.splice(0, logs.length);
      activeLogFilter = "all";
      logSearchQuery = "";
      logRefs.search.value = "";
      for (const item of logRefs.filters) {
        item.setAttribute("aria-pressed", item.dataset.logFilter === "all" ? "true" : "false");
      }
      renderLogs();
    }

    function historySearchText(entry) {
      const model = entry?.model || {};
      return [
        model.code,
        model.title,
        model.summary,
        model.recommendation,
        model.phase,
        ns.errorUtils?.PHASE_LABELS?.[model.phase],
        model.provider,
        model.target,
        model.status,
        model.upstreamStatus,
        model.runId,
        model.jobId,
        ...(model.details || []).flatMap((detail) => [detail?.label, detail?.value]),
      ].map((value) => String(value ?? "").toLocaleLowerCase()).join("\n");
    }

    function visibleHistoryEntries() {
      return history.filter((entry) => {
        const severity = entry.model?.severity === "warning" ? "warning" : "error";
        if (activeFilter !== "all" && severity !== activeFilter) return false;
        return !searchQuery || historySearchText(entry).includes(searchQuery);
      });
    }

    function historyMeta(model) {
      const items = [];
      const phase = String(model?.phase || "");
      if (phase) items.push(ns.errorUtils?.PHASE_LABELS?.[phase] || phase);
      if (model?.provider) items.push(ns.constants?.PROVIDER_LABELS?.[model.provider] || model.provider);
      const status = Number(model?.upstreamStatus ?? model?.status);
      if (Number.isInteger(status) && status >= 100) items.push(`HTTP ${status}`);
      return items.slice(0, 3);
    }

    function historyCopyText(entry) {
      const countLine = entry.count > 1 ? `重复次数: ${entry.count}` : "";
      return [
        `记录时间: ${formatFullTimestamp(entry.occurredAt)}`,
        countLine,
        entry.model?.copyText || `[${entry.model?.code || "ERROR"}] ${entry.model?.summary || "没有摘要"}`,
      ].filter(Boolean).join("\n");
    }

    function selectHistoryEntry(entry) {
      if (!entry) return;
      selectedHistoryId = entry.id;
      currentModel = entry.model;
      render(currentModel, {
        historical: true,
        occurredAt: entry.occurredAt,
        count: entry.count,
      });
      setPanelVisible(true);
      refs.retry.hidden = true;
      refs.retry.setAttribute("aria-hidden", "true");
      refs.cancel.hidden = true;
      refs.cancel.setAttribute("aria-hidden", "true");
      renderHistory();
      syncRootDiagnosticsState();
      refs.close.focus?.({ preventScroll: true });
    }

    function restoreLiveDiagnosis() {
      selectedHistoryId = null;
      if (!hasLiveModel) {
        currentModel = readyModel();
        render(currentModel, { historical: false });
        refs.retry.hidden = true;
        refs.retry.setAttribute("aria-hidden", "true");
        refs.cancel.hidden = true;
        refs.cancel.setAttribute("aria-hidden", "true");
        setPanelVisible(true);
        renderHistory();
        syncRootDiagnosticsState();
        return;
      }
      render(liveModel, { historical: false });
      refs.retry.hidden = typeof actionHandlers.onRetry !== "function";
      refs.retry.setAttribute("aria-hidden", refs.retry.hidden ? "true" : "false");
      refs.cancel.hidden = typeof actionHandlers.onCancel !== "function";
      refs.cancel.setAttribute("aria-hidden", refs.cancel.hidden ? "true" : "false");
      setPanelVisible(true);
      renderHistory();
      syncRootDiagnosticsState();
    }

    function renderHistory() {
      historyRefs.list.replaceChildren();
      const errorCount = history.filter((entry) => entry.model?.severity !== "warning").length;
      const warningCount = history.length - errorCount;
      const visible = visibleHistoryEntries();
      historyRefs.total.textContent = String(history.length);
      historyRefs.counts.all.textContent = String(history.length);
      historyRefs.counts.error.textContent = String(errorCount);
      historyRefs.counts.warning.textContent = String(warningCount);
      historyRefs.overview.textContent = `${history.length} 条记录 · ${errorCount} 个错误 · ${warningCount} 个警告`;
      historyRefs.empty.hidden = visible.length > 0;
      historyRefs.empty.textContent = history.length === 0
        ? "当前页面还没有错误记录"
        : "没有符合当前筛选条件的记录";
      historyRefs.copy.disabled = visible.length === 0;
      historyRefs.copy.textContent = visible.length === history.length ? "复制列表" : `复制结果 (${visible.length})`;
      for (const entry of visible) {
        const row = document.createElement("li");
        const severity = entry.model.severity === "warning" ? "warning" : "error";
        row.className = `echo360-error-history-item is-${severity}${selectedHistoryId === entry.id ? " is-selected" : ""}`;
        row.dataset.historyId = String(entry.id);

        const line = document.createElement("div");
        line.className = "echo360-error-history-line";
        const severityLabel = document.createElement("span");
        severityLabel.className = "echo360-error-history-severity";
        severityLabel.textContent = severity === "warning" ? "警告" : "错误";
        const code = document.createElement("code");
        code.className = "echo360-error-history-code";
        code.textContent = entry.model.code || "ERROR";
        const repeats = document.createElement("span");
        repeats.className = "echo360-error-history-repeats";
        repeats.textContent = `×${entry.count}`;
        repeats.hidden = entry.count <= 1;
        repeats.setAttribute("aria-label", `重复 ${entry.count} 次`);
        const time = document.createElement("time");
        time.className = "echo360-error-history-time";
        time.dateTime = new Date(entry.occurredAt).toISOString();
        time.textContent = formatHistoryTime(entry.occurredAt);
        time.title = formatFullTimestamp(entry.occurredAt);
        line.append(severityLabel, code, repeats, time);

        const title = document.createElement("div");
        title.className = "echo360-error-history-label";
        title.textContent = entry.model.title || "翻译错误";
        const summary = document.createElement("div");
        summary.className = "echo360-error-history-summary";
        summary.textContent = entry.model.summary || "没有摘要";

        const footer = document.createElement("div");
        footer.className = "echo360-error-history-footer";
        const meta = document.createElement("div");
        meta.className = "echo360-error-history-meta";
        for (const item of historyMeta(entry.model)) {
          const chip = document.createElement("span");
          chip.textContent = item;
          meta.appendChild(chip);
        }
        const actions = document.createElement("div");
        actions.className = "echo360-error-history-item-actions";
        const view = document.createElement("button");
        view.type = "button";
        view.className = "echo360-error-history-view";
        view.textContent = selectedHistoryId === entry.id ? "正在查看" : "查看详情";
        view.disabled = selectedHistoryId === entry.id;
        view.setAttribute("aria-label", `查看 ${entry.model.code || "错误"} 详情`);
        view.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          selectHistoryEntry(history.find((item) => item.id === entry.id));
        });
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "echo360-error-history-item-copy";
        copy.textContent = "复制";
        copy.setAttribute("aria-label", `复制 ${entry.model.code || "错误"} 诊断信息`);
        copy.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const copied = await copyText(historyCopyText(entry));
          setHistoryFeedback(copied ? `已复制 ${entry.model.code || "错误"} 的诊断信息` : "复制失败，请查看 Console");
        });
        actions.append(view, copy);
        footer.append(meta, actions);
        row.append(line, title, summary, footer);
        historyRefs.list.appendChild(row);
      }
      syncRootDiagnosticsState();
    }

    function recordHistory(model) {
      const now = Date.now();
      const fingerprint = modelFingerprint(model);
      const previous = history[0];
      if (previous?.fingerprint === fingerprint) {
        // Progress callbacks and layered boundaries can report the same
        // diagnosis more than once. Refresh its time instead of filling the
        // history with duplicates.
        previous.occurredAt = now;
        previous.model = model;
        previous.count += 1;
      } else {
        history.unshift({ id: nextHistoryId, model, occurredAt: now, firstOccurredAt: now, count: 1, fingerprint });
        nextHistoryId += 1;
        if (history.length > maxHistoryEntries) history.length = maxHistoryEntries;
      }
      renderHistory();
    }

    historyRefs.toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = historyRefs.toggle.getAttribute("aria-expanded") !== "true";
      historyRefs.toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      historyRefs.content.hidden = !expanded;
      historyRefs.chevron.textContent = expanded ? "⌃" : "⌄";
    });

    historyRefs.search.addEventListener("input", () => {
      searchQuery = historyRefs.search.value.trim().toLocaleLowerCase();
      renderHistory();
    });

    for (const filter of historyRefs.filters) {
      filter.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        activeFilter = filter.dataset.filter || "all";
        for (const item of historyRefs.filters) {
          item.setAttribute("aria-pressed", item === filter ? "true" : "false");
        }
        renderHistory();
      });
    }

    historyRefs.copy.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const visible = visibleHistoryEntries();
      if (visible.length === 0) return;
      const report = [
        `Echo360 字幕翻译错误历史（${formatFullTimestamp(Date.now())}）`,
        `筛选结果: ${visible.length}/${history.length}`,
        ...visible.map((entry, index) => `\n# ${index + 1}\n${historyCopyText(entry)}`),
      ].join("\n");
      const copied = await copyText(report);
      setHistoryFeedback(copied ? `已复制 ${visible.length} 条诊断记录` : "复制失败，请查看 Console");
    });

    function resetClearConfirmation() {
      if (clearConfirmationTimer) clearTimeout(clearConfirmationTimer);
      clearConfirmationTimer = null;
      historyRefs.clear.dataset.confirming = "false";
      historyRefs.clear.textContent = "清空";
    }

    historyRefs.clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (historyRefs.clear.dataset.confirming !== "true") {
        historyRefs.clear.dataset.confirming = "true";
        historyRefs.clear.textContent = "确认清空";
        setHistoryFeedback("再次点击“确认清空”将删除本页会话中的全部错误历史", 4200);
        clearConfirmationTimer = setTimeout(resetClearConfirmation, 4200);
        return;
      }
      resetClearConfirmation();
      history.splice(0, history.length);
      const wasViewingHistory = selectedHistoryId != null;
      selectedHistoryId = null;
      activeFilter = "all";
      searchQuery = "";
      historyRefs.search.value = "";
      for (const item of historyRefs.filters) {
        item.setAttribute("aria-pressed", item.dataset.filter === "all" ? "true" : "false");
      }
      if (wasViewingHistory) restoreLiveDiagnosis();
      else renderHistory();
    });

    logRefs.toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = logRefs.toggle.getAttribute("aria-expanded") !== "true";
      logRefs.toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      logRefs.content.hidden = !expanded;
      logRefs.chevron.textContent = expanded ? "⌃" : "⌄";
    });

    logRefs.search.addEventListener("input", () => {
      logSearchQuery = logRefs.search.value.trim().toLocaleLowerCase();
      renderLogs();
    });

    for (const filter of logRefs.filters) {
      filter.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        activeLogFilter = filter.dataset.logFilter || "all";
        for (const item of logRefs.filters) {
          item.setAttribute("aria-pressed", item === filter ? "true" : "false");
        }
        renderLogs();
      });
    }

    logRefs.copy.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const visible = visibleLogs();
      if (visible.length === 0) return;
      const report = [
        `Echo360 字幕翻译运行日志（${formatFullTimestamp(Date.now())}）`,
        `筛选结果: ${visible.length}/${logs.length}`,
        ...visible.map(logCopyText),
      ].join("\n");
      const copied = await copyText(report);
      setLogFeedback(copied ? `已复制 ${visible.length} 条运行日志` : "复制失败，请查看 Console");
    });

    function resetLogClearConfirmation() {
      if (logClearConfirmationTimer) clearTimeout(logClearConfirmationTimer);
      logClearConfirmationTimer = null;
      logRefs.clear.dataset.confirming = "false";
      logRefs.clear.textContent = "清空";
    }

    logRefs.clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (logRefs.clear.dataset.confirming !== "true") {
        logRefs.clear.dataset.confirming = "true";
        logRefs.clear.textContent = "确认清空";
        setLogFeedback("再次点击“确认清空”将删除本页会话中的全部运行日志", 4200);
        logClearConfirmationTimer = setTimeout(resetLogClearConfirmation, 4200);
        return;
      }
      resetLogClearConfirmation();
      clearLogs();
    });

    const invokeCancel = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (selectedHistoryId != null) {
        restoreLiveDiagnosis();
        return;
      }
      if (actionHandlers.onCancel) actionHandlers.onCancel();
      else {
        hasLiveModel = false;
        liveModel = null;
        selectedHistoryId = null;
        restoreLiveDiagnosis();
      }
    };
    refs.retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      actionHandlers.onRetry?.();
    });
    refs.cancel.addEventListener("click", invokeCancel);
    refs.close.addEventListener("click", invokeCancel);
    refs.copy.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const copied = await copyText(currentModel.copyText);
      refs.copy.textContent = copied ? "已复制" : "复制失败，请查看 Console";
      setTimeout(() => { refs.copy.textContent = "复制错误信息"; }, 2200);
    });

    function render(model, { historical = false, occurredAt = null, count = 1 } = {}) {
      currentModel = model || fallbackModel();
      const warning = currentModel.severity === "warning";
      const empty = currentModel.kind === "ready";
      panel.classList.toggle("echo360-error-warning", warning);
      panel.classList.toggle("echo360-error-empty", empty);
      panel.classList.toggle("echo360-error-historical", historical);
      const assertive = !historical && !warning && !empty;
      refs.announcement.setAttribute("role", assertive ? "alert" : "status");
      refs.announcement.setAttribute("aria-live", assertive ? "assertive" : "polite");
      refs.close.setAttribute(
        "aria-label",
        historical ? (hasLiveModel ? "返回当前问题" : "关闭历史详情") : "关闭错误详情"
      );
      refs.close.hidden = empty && !historical;
      refs.close.setAttribute("aria-hidden", refs.close.hidden ? "true" : "false");
      refs.context.textContent = historical
        ? `历史记录 · ${formatFullTimestamp(occurredAt)}${count > 1 ? ` · 重复 ${count} 次` : ""}`
        : (empty ? "运行诊断" : "当前问题");
      refs.severity.textContent = empty ? "运行正常" : warning ? "翻译警告" : "翻译错误";
      refs.code.textContent = empty ? "" : `[${currentModel.code || "TRANSLATION_ERROR"}]`;
      refs.title.textContent = currentModel.title || (empty ? "运行诊断" : SUBTITLE_FAILURE_LABEL);
      refs.summary.textContent = currentModel.summary || (empty ? "当前没有错误。" : "翻译失败");
      refs.recommendation.textContent = empty
        ? currentModel.recommendation
        : `建议：${currentModel.recommendation || "请展开诊断详情后重试。"}`;
      refs.copy.hidden = empty;
      refs.copy.setAttribute("aria-hidden", refs.copy.hidden ? "true" : "false");
      refs.actions.hidden = empty;
      refs.detailList.replaceChildren();
      for (const detail of currentModel.details || []) {
        const row = document.createElement("div");
        row.className = "echo360-error-detail-row";
        const label = document.createElement("span");
        label.className = "echo360-error-detail-label";
        label.textContent = `${detail.label || "详情"}`;
        const value = document.createElement("span");
        value.className = "echo360-error-detail-value";
        value.textContent = String(detail.value ?? "未知");
        row.append(label, value);
        refs.detailList.appendChild(row);
      }
      refs.details.hidden = empty || (currentModel.details || []).length === 0;
    }

    // Render the neutral state immediately while keeping the extension
    // collapsed. This gives the log list a predictable place to receive early
    // console output without expanding the floating panel before the user
    // asks to inspect diagnostics.
    render(currentModel, { historical: false });
    refs.retry.hidden = true;
    refs.retry.setAttribute("aria-hidden", "true");
    refs.cancel.hidden = true;
    refs.cancel.setAttribute("aria-hidden", "true");
    renderLogs();
    renderHistory();
    syncRootDiagnosticsState();

    return {
      el: panel,
      show(options = {}) {
        selectedHistoryId = null;
        actionHandlers.onRetry = options.onRetry || null;
        actionHandlers.onCancel = options.onCancel || null;
        const raw = options.error;
        const model = raw
          ? (ns.errorUtils?.normalizeError?.(raw, options.context || options) || raw)
          : fallbackModel();
        liveModel = model;
        hasLiveModel = true;
        render(model, { historical: false });
        if (options.recordHistory !== false) recordHistory(model);
        refs.retry.hidden = typeof actionHandlers.onRetry !== "function";
        refs.retry.setAttribute("aria-hidden", refs.retry.hidden ? "true" : "false");
        refs.cancel.hidden = typeof actionHandlers.onCancel !== "function";
        refs.cancel.setAttribute("aria-hidden", refs.cancel.hidden ? "true" : "false");
        // A new failure updates the extension in place, but does not open it
        // automatically. The compact trigger is the explicit entry point.
        syncRootDiagnosticsState();
      },
      hide() {
        hasLiveModel = false;
        liveModel = null;
        selectedHistoryId = null;
        actionHandlers.onRetry = null;
        actionHandlers.onCancel = null;
        currentModel = readyModel();
        render(currentModel, { historical: false });
        refs.retry.hidden = true;
        refs.retry.setAttribute("aria-hidden", "true");
        refs.cancel.hidden = true;
        refs.cancel.setAttribute("aria-hidden", "true");
        setPanelVisible(false);
        // Hiding the current card does not discard history. The user can use
        // the compact trigger to inspect previous failures without forcing a
        // new translation attempt.
        renderHistory();
        syncRootDiagnosticsState();
      },
      isVisible() {
        return isPanelVisible();
      },
      toggle() {
        return setPanelVisible(!isPanelVisible());
      },
      collapse() {
        return setPanelVisible(false);
      },
      getModel() {
        return currentModel;
      },
      getHistory() {
        return history.map((entry) => ({
          ...entry,
          model: { ...entry.model, details: [...(entry.model.details || [])] },
        }));
      },
      appendLog,
      log: appendLog,
      getLogs() {
        return logs.map((entry) => ({ ...entry }));
      },
      clearLogs,
      clearHistory() {
        history.splice(0, history.length);
        const wasViewingHistory = selectedHistoryId != null;
        selectedHistoryId = null;
        activeFilter = "all";
        searchQuery = "";
        historyRefs.search.value = "";
        resetClearConfirmation();
        for (const item of historyRefs.filters) {
          item.setAttribute("aria-pressed", item.dataset.filter === "all" ? "true" : "false");
        }
        if (wasViewingHistory) restoreLiveDiagnosis();
        else renderHistory();
      },
    };
  }

  ns.uiFailureActions = { create };
})();
