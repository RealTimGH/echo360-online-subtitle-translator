(() => {
  const ns = window.Echo360Translator;

  const INSTRUCTURE_MEDIA_HOST_RE = /(^|\.)instructuremedia\.com$/i;

  function hostname() {
    return String(location?.hostname || "").toLowerCase();
  }

  function isEcho360Document() {
    return hostname().includes("echo360.");
  }

  function isInstructureMediaHost() {
    return INSTRUCTURE_MEDIA_HOST_RE.test(hostname());
  }

  function isInstructureMediaDocument() {
    return isInstructureMediaHost() &&
      /\/lti-app\/embed\//i.test(String(location?.pathname || ""));
  }

  function isSupportedPlayerDocument() {
    if (window.Echo360AssessmentGuard?.isAllowedDocument?.() === false) return false;
    // Instructure has changed the path used by its embedded player before,
    // while the dedicated media host and the player DOM contract remain the
    // stable boundaries. The manifest already limits injection to that host;
    // do not silently skip a real player solely because its launch route is
    // no longer /lti-app/embed/.
    return isEcho360Document() || isInstructureMediaHost();
  }

  function getPlayer(video) {
    return video?.closest?.("[data-media-player]") ||
      video?.closest?.("#player") ||
      document.querySelector("[data-media-player]") ||
      document.querySelector("#player");
  }

  function isInstructureVideo(video) {
    return !!(
      video?.closest?.("[data-media-player]") ||
      (isInstructureMediaHost() && video)
    );
  }

  function getCaptionSurface(video) {
    const player = getPlayer(video);
    return player?.querySelector?.('[data-part="captions"]') || null;
  }

  ns.hostSupport = {
    isEcho360Document,
    isInstructureMediaHost,
    isInstructureMediaDocument,
    isSupportedPlayerDocument,
    getAssessmentDecision: () => window.Echo360AssessmentGuard?.currentDecision?.() || {
      allowed: false,
      reason: "assessment-guard-unavailable",
    },
    getPlayer,
    isInstructureVideo,
    getCaptionSurface,
  };
})();
