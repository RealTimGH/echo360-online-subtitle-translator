(() => {
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.Echo360CanvasCourseBridge) return;

  const SOURCE = "echo360-translator-canvas-course-bridge";
  const VERSION = 1;
  const CANVAS_HOST_RE = /(^|\.)canvas\.sydney\.edu\.au$/i;
  const COURSE_PAGE_PATH_RE = /^\/courses\/[^/]+\/(?:pages\/[^/]+|external_tools\/[^/]+)\/?$/i;
  const INSTRUCTURE_MEDIA_HOST_RE = /(^|\.)instructuremedia\.com$/i;
  const ECHO360_HOST_RE = /(^|\.)echo360\.(?:org|com|net|net\.au)$/i;

  function parseUrl(value) {
    try { return new URL(String(value || "")); } catch (_) { return null; }
  }

  function isSafeCoursePage(value = root.location?.href) {
    const url = parseUrl(value);
    return !!url && CANVAS_HOST_RE.test(url.hostname) && COURSE_PAGE_PATH_RE.test(url.pathname);
  }

  function isSupportedMediaOrigin(value) {
    const url = parseUrl(value);
    return !!url && (INSTRUCTURE_MEDIA_HOST_RE.test(url.hostname) || ECHO360_HOST_RE.test(url.hostname));
  }

  function hasActiveAssessmentSurface(doc = root.document) {
    try {
      return !!doc?.querySelector?.([
        "form#submit_quiz_form",
        "#quiz_questions",
        "#questions.assessment_results",
        "[data-testid='new-quiz-taking-page']",
        "[data-testid='quiz-taking-page']",
      ].join(","));
    } catch (_) {
      return true;
    }
  }

  function handleMessage(event) {
    const data = event?.data;
    if (!data || data.source !== SOURCE || data.version !== VERSION || data.action !== "verify-course-page") return false;
    if (event.source === root || !isSupportedMediaOrigin(event.origin)) return false;
    if (!isSafeCoursePage() || hasActiveAssessmentSurface()) return false;
    if (typeof data.requestId !== "string" || !/^[A-Za-z0-9_-]{12,96}$/.test(data.requestId)) return false;

    try {
      event.source?.postMessage?.({
        source: SOURCE,
        version: VERSION,
        action: "course-page-verified",
        requestId: data.requestId,
      }, event.origin);
      return true;
    } catch (_) {
      return false;
    }
  }

  const api = Object.freeze({
    source: SOURCE,
    version: VERSION,
    isSafeCoursePage,
    isSupportedMediaOrigin,
    hasActiveAssessmentSurface,
    handleMessage,
  });
  root.Echo360CanvasCourseBridge = api;

  // The manifest injects this file only into top-level Canvas course-content
  // and external-tool routes. Re-check the live URL for every request so a
  // same-document navigation can never turn a stale course-page bridge into
  // proof for an assessment route.
  if (root.top === root && isSafeCoursePage()) {
    root.addEventListener("message", handleMessage, false);
  }
})();
