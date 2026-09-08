import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

function installGuard() {
  delete window.Echo360AssessmentGuard;
  evalModule("assessment_guard.js");
  return window.Echo360AssessmentGuard;
}

describe("assessment_guard", () => {
  beforeEach(() => {
    delete window.Echo360AssessmentGuard;
  });

  it("blocks every Canvas top-level page, including classic and New Quiz routes", () => {
    const guard = installGuard();

    expect(guard.evaluate({
      location: { href: "https://canvas.sydney.edu.au/courses/12/quizzes/34/take" },
      embedded: false,
    })).toEqual({ allowed: false, reason: "canvas-assessment-page" });

    expect(guard.evaluate({
      location: { href: "https://canvas.sydney.edu.au/courses/12/assignments/34/taking/56" },
      embedded: false,
    })).toEqual({ allowed: false, reason: "canvas-assessment-page" });

    expect(guard.evaluate({
      location: { href: "https://canvas.sydney.edu.au/courses/12/pages/lecture-1" },
      embedded: false,
    })).toEqual({ allowed: false, reason: "canvas-top-level-page" });
  });

  it("blocks media frames whose Canvas referrer is an assessment or assignment", () => {
    const guard = installGuard();
    const location = { href: "https://sydney.instructuremedia.com/lti-app/embed/player" };

    expect(guard.evaluate({
      location,
      referrer: "https://canvas.sydney.edu.au/courses/12/quizzes/34/take",
      embedded: true,
    })).toEqual({ allowed: false, reason: "canvas-assessment-referrer" });

    expect(guard.evaluate({
      location,
      referrer: "https://canvas.sydney.edu.au/courses/12/assignments/34",
      embedded: true,
    })).toEqual({ allowed: false, reason: "canvas-assessment-referrer" });
  });

  it("allows explicit Canvas course-content and external-tool referrers", () => {
    const guard = installGuard();
    const location = { href: "https://sydney.instructuremedia.com/lti-app/embed/player" };

    for (const referrer of [
      "https://canvas.sydney.edu.au/courses/12/pages/week-1",
      "https://canvas.sydney.edu.au/courses/12/pages/week-1?module_item_id=56",
      "https://canvas.sydney.edu.au/courses/12/external_tools/11653",
      "https://canvas.sydney.edu.au/courses/12/external_tools/11653?display=borderless",
    ]) {
      expect(guard.evaluate({ location, referrer, embedded: true })).toEqual({
        allowed: true,
        reason: "allowlisted-canvas-course-content",
      });
    }

    for (const referrer of [
      "https://canvas.sydney.edu.au/courses/12/modules/items/56",
      "https://canvas.sydney.edu.au/courses/12/files/78",
      "https://canvas.sydney.edu.au/courses/12/syllabus",
    ]) {
      expect(guard.evaluate({ location, referrer, embedded: true }).allowed).toBe(false);
    }
  });

  it("fails closed when Canvas exposes only its origin or only appears as an ancestor", () => {
    const guard = installGuard();
    const location = { href: "https://sydney.instructuremedia.com/lti-app/embed/player" };

    expect(guard.evaluate({
      location,
      referrer: "https://canvas.sydney.edu.au/",
      embedded: true,
    })).toEqual({ allowed: false, reason: "canvas-referrer-not-allowlisted" });

    expect(guard.evaluate({
      location,
      referrer: "https://sydney.instructuremedia.com/intermediate",
      embedded: true,
      ancestorOrigins: ["https://canvas.sydney.edu.au"],
    })).toEqual({
      allowed: false,
      reason: "canvas-ancestor-without-verified-course-referrer",
    });

    expect(guard.evaluate({ location, referrer: "", embedded: true })).toEqual({
      allowed: false,
      reason: "embedded-media-without-referrer",
    });
  });

  it("allows directly opened players and non-Canvas embeds", () => {
    const guard = installGuard();
    const location = { href: "https://sydney.instructuremedia.com/lti-app/embed/player" };

    expect(guard.evaluate({ location, embedded: false })).toEqual({
      allowed: true,
      reason: "top-level-media-page",
    });
    expect(guard.evaluate({
      location,
      referrer: "https://learning.example.edu/lecture/1",
      embedded: true,
    })).toEqual({ allowed: true, reason: "non-canvas-media-context" });
  });

  it("prevents both MAIN-world probes from installing in a blocked document", () => {
    window.Echo360AssessmentGuard = { isAllowedDocument: () => false };
    delete window.__echo360Probe;
    delete window.__echo360TranscriptPageBridge;
    const interval = vi.spyOn(globalThis, "setInterval");
    const documentListener = vi.spyOn(document, "addEventListener");
    const windowListener = vi.spyOn(window, "addEventListener");

    evalModule("page_probe.js");

    expect(window.__echo360Probe).toBeUndefined();
    expect(window.__echo360TranscriptPageBridge).toBeUndefined();
    expect(interval).not.toHaveBeenCalled();
    expect(documentListener).not.toHaveBeenCalled();
    expect(windowListener).not.toHaveBeenCalled();
  });

  it("does not initialize the isolated-world controller in safe mode", () => {
    const init = vi.fn();
    window.Echo360Translator = makeFullNs({ controller: { init } });
    window.Echo360AssessmentGuard = {
      currentDecision: () => ({ allowed: false, reason: "canvas-assessment-referrer" }),
    };

    evalModule("content.js");

    expect(init).not.toHaveBeenCalled();
  });

  it("reports a missing isolated-world guard instead of failing silently", () => {
    const init = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    window.Echo360Translator = makeFullNs({ controller: { init } });

    evalModule("content.js");

    expect(init).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[echo360-translator][content] assessment guard was not injected",
      { href: window.location.href }
    );
    consoleError.mockRestore();
  });

  it("initializes the controller after the course-page bridge verifies an ambiguous referrer", async () => {
    const init = vi.fn();
    window.Echo360Translator = makeFullNs({ controller: { init } });
    window.Echo360AssessmentGuard = {
      isAllowedDocument: () => false,
      verifyAllowedDocument: vi.fn(async () => true),
    };

    evalModule("content.js");
    await Promise.resolve();
    await Promise.resolve();

    expect(window.Echo360AssessmentGuard.verifyAllowedDocument).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("accepts an origin-only Canvas referrer only after a verified page bridge response", async () => {
    setLocationForHandshake();
    Object.defineProperty(document, "referrer", {
      value: "https://canvas.sydney.edu.au/",
      configurable: true,
    });
    const guard = installGuard();
    const post = vi.spyOn(window, "postMessage").mockImplementation((request, targetOrigin) => {
      expect(targetOrigin).toBe("https://canvas.sydney.edu.au");
      queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", {
        source: window,
        origin: targetOrigin,
        data: {
          source: "echo360-translator-canvas-course-bridge",
          version: 1,
          action: "course-page-verified",
          requestId: request.requestId,
        },
      })));
    });

    await expect(guard.verifyAllowedDocument(500)).resolves.toBe(true);
    expect(guard.currentDecision()).toEqual({
      allowed: true,
      reason: "verified-canvas-course-page-bridge",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

function setLocationForHandshake() {
  Object.defineProperty(window, "location", {
    value: {
      href: "https://sydney.instructuremedia.com/lti-app/embed/player",
      hostname: "sydney.instructuremedia.com",
      pathname: "/lti-app/embed/player",
      origin: "https://sydney.instructuremedia.com",
      ancestorOrigins: ["https://canvas.sydney.edu.au"],
    },
    configurable: true,
    writable: true,
  });
}
