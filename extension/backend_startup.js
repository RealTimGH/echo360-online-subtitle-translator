(() => {
  const root = globalThis;
  const DEFAULT_BACKEND_URL = "http://127.0.0.1:8765";
  const DEFAULT_TIMEOUT_MS = 75000;
  const DEFAULT_RELAUNCH_DELAYS_MS = Object.freeze([0, 5000, 15000]);

  function makeStartupError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.phase = "backend";
    Object.assign(error, details);
    return error;
  }

  function normalizeBackendUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl || DEFAULT_BACKEND_URL);
    } catch (_) {
      throw makeStartupError("Argos 自动启动收到的 Backend 地址无效", "BACKEND_URL_INVALID", { status: 400 });
    }
    const hostname = String(url.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw makeStartupError("Argos 自动启动只允许使用本机 HTTP Backend 地址", "BACKEND_URL_INVALID", { status: 400 });
    }
    const port = Number(url.port || 80);
    if (port !== 8765) {
      throw makeStartupError("Argos 自动启动当前只支持默认端口 8765", "ARGOS_BACKEND_PORT_UNSUPPORTED", { status: 400 });
    }
    // The packaged server intentionally binds IPv4 loopback only. Browsers
    // may resolve localhost to ::1 first, so retaining the spelling supplied
    // by the user creates an intermittent health-check/request failure.
    return DEFAULT_BACKEND_URL;
  }

  function createManager({
    healthCheck,
    launch,
    close = async () => {},
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    relaunchDelaysMs = DEFAULT_RELAUNCH_DELAYS_MS,
  } = {}) {
    if (typeof healthCheck !== "function" || typeof launch !== "function") {
      throw new TypeError("backend startup manager requires healthCheck and launch functions");
    }

    // Keep one attempt per normalized endpoint, rather than one global
    // promise. This prevents a request for an unsupported/custom URL from
    // poisoning a concurrent request for the real Argos endpoint.
    const attempts = new Map();

    async function startAndWait(rawBackendUrl) {
      const backendUrl = normalizeBackendUrl(rawBackendUrl);
      if (await healthCheck(backendUrl)) {
        return { ready: true, launched: false, launchAttempts: 0, backendUrl };
      }

      const startedAt = now();
      const launchTabs = [];
      const launchErrors = [];
      let launches = 0;
      let nextLaunchIndex = 0;

      try {
        while (now() - startedAt < timeoutMs) {
          const elapsed = now() - startedAt;
          if (
            nextLaunchIndex < relaunchDelaysMs.length &&
            elapsed >= Number(relaunchDelaysMs[nextLaunchIndex] || 0)
          ) {
            nextLaunchIndex += 1;
            try {
              const launchedTab = await launch();
              launches += 1;
              if (launchedTab != null) launchTabs.push(launchedTab);
            } catch (error) {
              launchErrors.push(error);
            }
          }

          if (await healthCheck(backendUrl)) {
            return {
              ready: true,
              launched: launches > 0,
              launchAttempts: launches,
              backendUrl,
            };
          }
          await delay(350);
        }
      } finally {
        await Promise.all(launchTabs.map((tab) => Promise.resolve(close(tab)).catch(() => {})));
      }

      if (launches === 0 && launchErrors.length > 0) {
        throw makeStartupError(
          "无法调用 Argos 后端启动协议；请重新安装或手动打开 Echo360 Subtitle Backend",
          "ARGOS_BACKEND_LAUNCH_UNAVAILABLE",
          { cause: launchErrors[launchErrors.length - 1], launchErrors }
        );
      }
      throw makeStartupError(
        `已请求操作系统启动 Argos 后端，但 ${Math.round(timeoutMs / 1000)} 秒内没有连接成功`,
        "ARGOS_BACKEND_START_TIMEOUT",
        { launchAttempts: launches, launchErrors }
      );
    }

    function ensure(rawBackendUrl) {
      const backendUrl = normalizeBackendUrl(rawBackendUrl);
      if (!attempts.has(backendUrl)) {
        const attempt = startAndWait(backendUrl).finally(() => attempts.delete(backendUrl));
        attempts.set(backendUrl, attempt);
      }
      return attempts.get(backendUrl);
    }

    return { ensure, startAndWait, pendingCount: () => attempts.size };
  }

  root.Echo360BackendStartup = {
    DEFAULT_BACKEND_URL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_RELAUNCH_DELAYS_MS,
    normalizeBackendUrl,
    createManager,
  };
})();
