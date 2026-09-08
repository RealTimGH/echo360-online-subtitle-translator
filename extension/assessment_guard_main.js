(() => {
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.Echo360AssessmentGuard) return;

  const CANVAS_HOST_RE = /(^|\.)canvas\.sydney\.edu\.au$/i;
  const CANVAS_ASSESSMENT_PATHS = [
    /^\/courses\/[^/]+\/quizzes(?:\/|$)/i,
    /^\/courses\/[^/]+\/assignments(?:\/|$)/i,
    /^\/courses\/[^/]+\/(?:take|activity_builder|submission-screen|submission-confirmation)(?:\/|$)/i,
    /\/(?:new[-_]?quizzes?|quiz[-_]?lti|assessments?|exams?)(?:\/|$)/i,
  ];
  // This is intentionally an allowlist. Canvas can launch assessments through
  // assignments and LTI routes whose names are not stable. A media frame is
  // enabled only when its immediate Canvas referrer is clearly course content
  // or a standalone course external-tool launch.
  const CANVAS_COURSE_CONTENT_PATHS = [
    /^\/courses\/[^/]+\/pages\/[^/]+\/?$/i,
    /^\/courses\/[^/]+\/external_tools\/[^/]+\/?$/i,
  ];
  const COURSE_BRIDGE_SOURCE = "echo360-translator-canvas-course-bridge";
  const COURSE_BRIDGE_VERSION = 1;
  let canvasBridgeVerified = false;
  let canvasBridgeVerification = null;

  function parseUrl(value, base = "https://invalid.local/") {
    try {
      return new URL(String(value || ""), base);
    } catch (_) {
      return null;
    }
  }

  function isCanvasHost(hostname) {
    return CANVAS_HOST_RE.test(String(hostname || "").toLowerCase());
  }

  function isAssessmentPath(pathname) {
    const path = String(pathname || "/");
    return CANVAS_ASSESSMENT_PATHS.some((pattern) => pattern.test(path));
  }

  function isAllowedCourseContentPath(pathname) {
    const path = String(pathname || "/");
    return CANVAS_COURSE_CONTENT_PATHS.some((pattern) => pattern.test(path));
  }

  function ancestorOriginsFrom(locationLike) {
    try {
      return Array.from(locationLike?.ancestorOrigins || []).map(String);
    } catch (_) {
      return [];
    }
  }

  function canvasAncestorOrigins(locationLike) {
    return ancestorOriginsFrom(locationLike).filter((value) => {
      const parsed = parseUrl(value);
      return parsed && isCanvasHost(parsed.hostname);
    });
  }

  function evaluate(options = {}) {
    const locationLike = options.location || root.location;
    const current = parseUrl(locationLike?.href || "", "https://invalid.local/");
    const referrerValue = options.referrer !== undefined
      ? options.referrer
      : (root.document?.referrer || "");
    const referrer = parseUrl(referrerValue, current?.href || "https://invalid.local/");
    const embedded = options.embedded !== undefined
      ? !!options.embedded
      : (() => {
          try { return root.top !== root; } catch (_) { return true; }
        })();
    const canvasAncestors = options.ancestorOrigins !== undefined
      ? Array.from(options.ancestorOrigins || []).filter((value) => {
          const parsed = parseUrl(value);
          return parsed && isCanvasHost(parsed.hostname);
        })
      : canvasAncestorOrigins(locationLike);

    if (current && isCanvasHost(current.hostname)) {
      return {
        allowed: false,
        reason: isAssessmentPath(current.pathname) ? "canvas-assessment-page" : "canvas-top-level-page",
      };
    }

    if (!embedded && canvasAncestors.length === 0) {
      return { allowed: true, reason: "top-level-media-page" };
    }

    if (referrer && isCanvasHost(referrer.hostname)) {
      if (isAssessmentPath(referrer.pathname)) {
        return { allowed: false, reason: "canvas-assessment-referrer" };
      }
      if (isAllowedCourseContentPath(referrer.pathname)) {
        return { allowed: true, reason: "allowlisted-canvas-course-content" };
      }
      return { allowed: false, reason: "canvas-referrer-not-allowlisted" };
    }

    if (canvasAncestors.length > 0) {
      return { allowed: false, reason: "canvas-ancestor-without-verified-course-referrer" };
    }

    // Empty referrers are common with strict privacy policies. For embedded
    // media, allowing one would make a Canvas exam indistinguishable from an
    // ordinary embed, so fail closed. A directly opened media page is handled
    // by the top-level branch above.
    if (embedded && !String(referrerValue || "").trim()) {
      return { allowed: false, reason: "embedded-media-without-referrer" };
    }

    return { allowed: true, reason: "non-canvas-media-context" };
  }

  function currentDecision() {
    if (canvasBridgeVerified) {
      return { allowed: true, reason: "verified-canvas-course-page-bridge" };
    }
    return evaluate();
  }

  function isAllowedDocument() {
    return currentDecision().allowed;
  }

  function randomRequestId() {
    try {
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 18)}`;
    }
  }

  function canvasVerificationOrigin() {
    const referrer = parseUrl(root.document?.referrer || "", root.location?.href || "https://invalid.local/");
    if (referrer && isCanvasHost(referrer.hostname)) return referrer.origin;
    const ancestor = canvasAncestorOrigins(root.location)[0];
    return parseUrl(ancestor)?.origin || "";
  }

  function verifyAllowedDocument(timeoutMs = 1500) {
    const decision = currentDecision();
    if (decision.allowed) return Promise.resolve(true);
    if (!["canvas-referrer-not-allowlisted", "canvas-ancestor-without-verified-course-referrer"].includes(decision.reason)) {
      return Promise.resolve(false);
    }
    if (canvasBridgeVerification) return canvasBridgeVerification;

    const canvasOrigin = canvasVerificationOrigin();
    if (!canvasOrigin) return Promise.resolve(false);
    const requestId = randomRequestId();

    canvasBridgeVerification = new Promise((resolve) => {
      let settled = false;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        root.removeEventListener?.("message", onMessage, false);
        root.clearTimeout?.(timer);
        canvasBridgeVerified = allowed === true;
        resolve(canvasBridgeVerified);
      };
      const onMessage = (event) => {
        const data = event?.data;
        if (event.source !== root.top || event.origin !== canvasOrigin) return;
        if (!data || data.source !== COURSE_BRIDGE_SOURCE || data.version !== COURSE_BRIDGE_VERSION ||
            data.action !== "course-page-verified" || data.requestId !== requestId) return;
        finish(true);
      };
      const timer = root.setTimeout?.(() => finish(false), Math.max(250, Number(timeoutMs) || 1500));
      root.addEventListener?.("message", onMessage, false);
      try {
        root.top.postMessage({
          source: COURSE_BRIDGE_SOURCE,
          version: COURSE_BRIDGE_VERSION,
          action: "verify-course-page",
          requestId,
        }, canvasOrigin);
      } catch (_) {
        finish(false);
      }
    });
    return canvasBridgeVerification;
  }

  root.Echo360AssessmentGuard = Object.freeze({
    evaluate,
    currentDecision,
    isAllowedDocument,
    verifyAllowedDocument,
    isCanvasHost,
    isAssessmentPath,
    isAllowedCourseContentPath,
  });
})();
