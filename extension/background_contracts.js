(() => {
  function normalizeTargetCode(target = "ZH") {
    const code = String(target || "ZH").trim().toUpperCase();
    return code === "CANTONESE" ? "YUE" : code;
  }

  function isAllowedProxyRoute(path, method) {
    const normalizedMethod = String(method || "GET").trim().toUpperCase();
    const rawPath = String(path || "");
    const separator = rawPath.indexOf("?");
    const pathname = separator >= 0 ? rawPath.slice(0, separator) : rawPath;
    const query = separator >= 0 ? rawPath.slice(separator + 1) : "";
    const queryParams = new URLSearchParams(query);
    const queryKeys = Array.from(queryParams.keys());
    const partialRevisionQuery = queryKeys.length === 1 &&
      queryKeys[0] === "since_partial_revision" &&
      /^\d+$/.test(queryParams.get("since_partial_revision") || "");
    return (path === "/health" && normalizedMethod === "GET") ||
      (pathname === "/translate" && !query && normalizedMethod === "POST") ||
      (pathname === "/translate-async" && !query && normalizedMethod === "POST") ||
      (/^\/translate-async\/[A-Za-z0-9_-]{1,128}$/.test(pathname) &&
        normalizedMethod === "GET" && (!query || partialRevisionQuery));
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
