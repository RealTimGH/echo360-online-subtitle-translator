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

  // Canvas's Instructure Media player has existed in two DOM generations.
  // The newer Vidstack generation exposes [data-media-player], while the
  // older Echo360-hosted embed uses a class-only player shell.  The video is
  // absolutely positioned inside `.studio-player-container__player`; the
  // larger `.studio-player-container` around it is the lesson's inner scroll
  // surface, not the player that owns the controls.  Returning that outer
  // shell was the reason the floating UI was calculated against the wrong
  // edge (and why no stable per-video anchor was found at all).
  const PLAYER_SELECTOR = [
    "[data-media-player]",
    "#player",
    ".studio-player-container__player",
    '[class*="studio-player-container__player"]',
  ].join(",");

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
    return video?.closest?.(PLAYER_SELECTOR) || document.querySelector(PLAYER_SELECTOR);
  }

  function isInstructureVideo(video) {
    return !!(
      video?.closest?.("[data-media-player]") ||
      video?.closest?.('.studio-player-container__player,[class*="studio-player-container__player"]') ||
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
