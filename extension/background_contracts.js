(() => {
  function normalizeTargetCode(target = "ZH") {
    const code = String(target || "ZH").trim().toUpperCase();
    return code === "CANTONESE" ? "YUE" : code;
  }

  function isAllowedProxyRoute(path, method) {
    const normalizedMethod = String(method || "GET").trim().toUpperCase();
    return (path === "/health" && normalizedMethod === "GET") ||
      (path === "/translate" && normalizedMethod === "POST") ||
      (path === "/translate-async" && normalizedMethod === "POST") ||
      (/^\/translate-async\/[A-Za-z0-9_-]{1,128}$/.test(String(path || "")) && normalizedMethod === "GET");
  }

  function isTrustedRuntimeSender(expectedExtensionId, sender) {
    const expected = String(expectedExtensionId || "").trim();
    return !expected || sender?.id === expected;
  }

  globalThis.Echo360BackgroundContracts = Object.freeze({
    normalizeTargetCode,
    isAllowedProxyRoute,
    isTrustedRuntimeSender,
  });
})();
