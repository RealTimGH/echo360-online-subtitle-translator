/**
 * Branch-coverage tests for extension/translation_service.js (extension-only path)
 *
 * Store 构建默认走 translateInExtension，不调用本地 FastAPI 后端。
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

let svc;
let backendClientMock;
let sourceFinderMock;
let videoMock;

beforeAll(() => {
  backendClientMock = {
    createDirectTranslateJob: vi.fn(),
    waitDirectJob: vi.fn(),
    proxyRequest: vi.fn(),
    proxyTranslateSync: vi.fn(),
    waitJob: vi.fn(),
    ensureArgosBackend: vi.fn(),
    // translation_service.js deliberately fails closed when the shared
    // boundary validators are unavailable. Keep this unit-test double
    // faithful to the production dependency contract.
    validateSourceVtt: vi.fn((vtt) => vtt),
    validateTranslationResult: vi.fn((result) => result),
  };
  sourceFinderMock = {
    findBestTrackElement: vi.fn(() => null),
    exportVttFromTextTracks: vi.fn(async () => ""),
    fetchTranscriptFileVtt: vi.fn(async () => ({ text: "", sourceId: "", strongMapped: false, sourceMeta: null })),
    fetchBestVttFromCandidates: vi.fn(async () => ({ text: "", sourceId: "", strongMapped: false, sourceMeta: null })),
    collectCandidateSubtitleUrls: vi.fn(() => []),
    buildSourceMeta: vi.fn((sourceId, vttText) => ({ sourceId, mediaId: "", mapSource: "", stats: {} })),
    fetchTextResource: vi.fn(),
  };
  videoMock = {
    getPrimaryVideo: vi.fn(() => null),
  };
  const ns = makeFullNs({
    buildConfig: { buildTarget: "store", enableLocalBackend: false },
    backendClient: backendClientMock,
    storage: {
      sha256Text: vi.fn(async (text) => `hash-${text.length}`),
      buildConfigSignature: vi.fn((cfg) => `${cfg.provider}|${cfg.model}`),
    },
    sourceFinder: sourceFinderMock,
    video: videoMock,
  });
  window.Echo360Translator = ns;
  evalModule("vtt.js");
  evalModule("error_utils.js");
  evalModule("translation_service.js");
  svc = window.Echo360Translator.translationService;
});

beforeEach(() => {
  vi.clearAllMocks();
  sourceFinderMock.findBestTrackElement.mockReturnValue(null);
  sourceFinderMock.exportVttFromTextTracks.mockResolvedValue("");
  sourceFinderMock.fetchTranscriptFileVtt.mockResolvedValue({ text: "", sourceId: "", strongMapped: false, sourceMeta: null });
  sourceFinderMock.fetchBestVttFromCandidates.mockResolvedValue({ text: "", sourceId: "", strongMapped: false, sourceMeta: null });
  sourceFinderMock.collectCandidateSubtitleUrls.mockReturnValue([]);
  sourceFinderMock.fetchTextResource.mockReset();
  videoMock.getPrimaryVideo.mockReturnValue(null);
});

describe("resolveSourceVtt", () => {
  it("uses the allowlisted resource fetcher for an Instructure track source", async () => {
    const track = document.createElement("track");
    track.setAttribute("src", "https://apse2.nv.instructuremedia.com/captions/source.vtt");
    sourceFinderMock.findBestTrackElement.mockReturnValue(track);
    sourceFinderMock.fetchTextResource.mockResolvedValue({
      ok: true,
      text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHi\n",
      via: "service-worker",
    });

    const result = await svc.resolveSourceVtt({});

    expect(sourceFinderMock.fetchTextResource).toHaveBeenCalledWith(
      "https://apse2.nv.instructuremedia.com/captions/source.vtt"
    );
    expect(result.vttText).toContain("Hi");
  });

  it("uses the transcript-file API result when found, without falling through to the generic candidate scan", async () => {
    sourceFinderMock.fetchTranscriptFileVtt.mockResolvedValue({
      text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHi\n",
      sourceId: "https://echo360.net.au/api/ui/echoplayer/lessons/abc/medias/m1/transcript-file?format=vtt",
      strongMapped: true,
      sourceMeta: { sourceId: "x", mediaId: "m1", mapSource: "transcript-file", stats: {} },
    });

    const result = await svc.resolveSourceVtt({});

    expect(result.vttText).toContain("Hi");
    expect(result.sourceMeta.mapSource).toBe("transcript-file");
    expect(sourceFinderMock.fetchBestVttFromCandidates).not.toHaveBeenCalled();
  });

  it("falls back to the generic candidate scan when the transcript-file API finds nothing (e.g. institution doesn't expose it)", async () => {
    sourceFinderMock.fetchBestVttFromCandidates.mockResolvedValue({
      text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHi\n",
      sourceId: "https://example.com/captions.vtt",
      strongMapped: true,
      sourceMeta: { sourceId: "https://example.com/captions.vtt", mediaId: "", mapSource: "video", stats: {} },
    });

    const result = await svc.resolveSourceVtt({});

    expect(result.vttText).toContain("Hi");
    expect(sourceFinderMock.fetchTranscriptFileVtt).toHaveBeenCalled();
  });

  it("reports candidate-read failure when a candidate URL exists but no usable VTT is returned", async () => {
    vi.useFakeTimers();
    try {
      sourceFinderMock.collectCandidateSubtitleUrls.mockReturnValue([{ url: "https://example.com/x" }]);
      const promise = svc.resolveSourceVtt({}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(12000);
      const result = await promise;
      expect(result).toBeInstanceOf(Error);
      expect(result.code).toBe("SUBTITLE_FETCH_FAILED");
      expect(result.message).toContain("没有得到可用的字幕文件");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call a network failure 'no subtitle source' when a candidate was found", async () => {
    vi.useFakeTimers();
    try {
      sourceFinderMock.collectCandidateSubtitleUrls.mockReturnValue([{ url: "https://example.com/captions.vtt" }]);
      sourceFinderMock.fetchBestVttFromCandidates.mockResolvedValue({
        text: "",
        sourceId: "",
        sourceMeta: null,
        diagnostics: { attempts: [{ code: "RESOURCE_NETWORK_ERROR", outcome: "exception", error: "Load failed" }] },
      });
      const promise = svc.resolveSourceVtt({}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(12000);
      const result = await promise;
      expect(result.code).toBe("SUBTITLE_NETWORK_ERROR");
      expect(result.message).toContain("无法完成字幕文件请求");
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes repeated subtitle-server 5xx responses", async () => {
    vi.useFakeTimers();
    try {
      sourceFinderMock.collectCandidateSubtitleUrls.mockReturnValue([{ url: "https://example.com/captions.vtt" }]);
      sourceFinderMock.fetchBestVttFromCandidates.mockResolvedValue({
        text: "",
        sourceId: "",
        sourceMeta: null,
        diagnostics: { attempts: [{ code: "HTTP_503", status: 503, outcome: "fetch-failed", error: "HTTP 503" }] },
      });
      const promise = svc.resolveSourceVtt({}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(12000);
      const result = await promise;
      expect(result.code).toBe("SUBTITLE_SERVER_ERROR");
      expect(result.message).toContain("5xx");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not label mixed HTTP and network failures as one specific cause", async () => {
    vi.useFakeTimers();
    try {
      sourceFinderMock.collectCandidateSubtitleUrls.mockReturnValue([{ url: "https://example.com/captions.vtt" }]);
      sourceFinderMock.fetchBestVttFromCandidates.mockResolvedValue({
        text: "",
        sourceId: "",
        sourceMeta: null,
        diagnostics: {
          attempts: [
            { code: "HTTP_404", status: 404, outcome: "fetch-failed", error: "HTTP 404" },
            { code: "RESOURCE_NETWORK_ERROR", outcome: "exception", error: "Load failed" },
          ],
        },
      });
      const promise = svc.resolveSourceVtt({}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(12000);
      const result = await promise;
      expect(result.code).toBe("SUBTITLE_FETCH_FAILED");
      expect(result.message).toContain("所有读取尝试都失败");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("buildTranslatePayload", () => {
  it("maps non-zero config fields to snake_case payload", () => {
    const payload = svc.buildTranslatePayload(
      {
        apiKey: "sk-test",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        endpoint: "https://custom/v1",
        target: "ZH",
        maxParagraphs: 8,
        maxChars: 900,
        concurrency: 48,
        rps: 2,
        retries: 3,
        timeout: 15,
        reasoningEffort: "low",
        fallbackMode: "careful",
        repairConcurrency: 2,
        slowSplitThreshold: 1,
        deepseekThinkingMode: "enabled",
        deeplFormality: "more",
      },
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n",
      false
    );
    expect(payload.vtt_text).toContain("WEBVTT");
    // api_key is intentionally omitted from the payload; the service worker
    // reads and injects it directly from storage before executing the job.
    expect(payload.api_key).toBeUndefined();
    expect(payload.provider).toBe("deepseek");
    expect(payload.endpoint).toBe("https://custom/v1");
    expect(payload.max_paragraphs).toBe(8);
    expect(payload.max_chars).toBe(900);
    expect(payload.concurrency).toBe(48);
    expect(payload.rps).toBe(2);
    expect(payload.retries).toBe(3);
    expect(payload.timeout).toBe(15);
    expect(payload.reasoning_effort).toBe("low");
    expect(payload.fallback_mode).toBe("careful");
    expect(payload.repair_concurrency).toBe(2);
    expect(payload.slow_split_threshold).toBe(1);
    expect(payload.deepseek_thinking_mode).toBe("enabled");
    expect(payload.deepl_formality).toBe("more");
    expect(payload.bilingual).toBe(false);
    expect(payload.force_refresh).toBe(false);
  });

  it("uses defaults when numeric fields are missing", () => {
    const payload = svc.buildTranslatePayload({ provider: "google-web", target: "ZH" }, "WEBVTT\n\n", true);
    expect(payload.max_paragraphs).toBe(6);
    expect(payload.max_chars).toBe(1200);
    expect(payload.concurrency).toBe(96);
    expect(payload.rps).toBe(0);
    expect(payload.force_refresh).toBe(true);
  });

  // Falsy-zero boundary — kills LogicalOperator survivors on || defaults
  it("passes rps=0 as 0, not the default", () => {
    const payload = svc.buildTranslatePayload({ rps: 0 }, "WEBVTT\n\n", false);
    expect(payload.rps).toBe(0);
  });

  it("treats timeout=0 as null (0-second timeout is meaningless; null = no limit)", () => {
    // timeout=0 → Number(0) || null → null. This is intentional: 0 and null both
    // mean "no timeout limit" at the API level.
    const payload = svc.buildTranslatePayload({ timeout: 0 }, "WEBVTT\n\n", false);
    expect(payload.timeout).toBeNull();
  });

  it("passes retries=0 as 0 (not coerced to 1)", () => {
    const payload = svc.buildTranslatePayload({ retries: 0 }, "WEBVTT\n\n", false);
    expect(payload.retries).toBe(0);
  });

  it("passes slowSplitThreshold=0 as 0", () => {
    const payload = svc.buildTranslatePayload({ slowSplitThreshold: 0 }, "WEBVTT\n\n", false);
    expect(payload.slow_split_threshold).toBe(0);
  });

  it("treats repairConcurrency=0 as 1 (direct_translator enforces Math.max(1,...) internally)", () => {
    // direct_translator.js enforces Math.max(1, ...) — 0 and 1 are equivalent at the consumer.
    // The || 1 default here is intentional and consistent with that constraint.
    const payload = svc.buildTranslatePayload({ repairConcurrency: 0 }, "WEBVTT\n\n", false);
    expect(payload.repair_concurrency).toBe(1);
  });

  it("passes empty endpoint as empty string, not undefined", () => {
    const payload = svc.buildTranslatePayload({ endpoint: "" }, "WEBVTT\n\n", false);
    expect(payload.endpoint).toBe("");
  });

  it("passes empty reasoningEffort as null, not empty string", () => {
    const payload = svc.buildTranslatePayload({ reasoningEffort: "" }, "WEBVTT\n\n", false);
    expect(payload.reasoning_effort).toBeNull();
  });

  it("passes deepseekThinkingMode fallback to 'disabled'", () => {
    const payload = svc.buildTranslatePayload({}, "WEBVTT\n\n", false);
    expect(payload.deepseek_thinking_mode).toBe("disabled");
  });

  it("passes deeplFormality fallback to empty string", () => {
    const payload = svc.buildTranslatePayload({}, "WEBVTT\n\n", false);
    expect(payload.deepl_formality).toBe("");
  });

  it("force_refresh=true when forceRefresh is truthy", () => {
    expect(svc.buildTranslatePayload({}, "WEBVTT\n\n", true).force_refresh).toBe(true);
    expect(svc.buildTranslatePayload({}, "WEBVTT\n\n", false).force_refresh).toBe(false);
  });
});

describe("translateWithConfig (store build)", () => {
  it("calls translateInExtension and never hits backend proxy", async () => {
    backendClientMock.createDirectTranslateJob.mockResolvedValue({ job_id: "job-42" });
    backendClientMock.waitDirectJob.mockResolvedValue({
      translated_vtt: "WEBVTT\n\n",
      warnings: [],
      cache_hit: false,
    });

    const cfg = { useLocalBackend: true, provider: "google-web" };
    const payload = { vtt_text: "WEBVTT\n\n" };
    const result = await svc.translateWithConfig(cfg, "http://127.0.0.1:8765", payload);

    expect(backendClientMock.createDirectTranslateJob).toHaveBeenCalledWith(payload);
    expect(backendClientMock.waitDirectJob).toHaveBeenCalledWith("job-42", expect.any(Object));
    expect(backendClientMock.proxyRequest).not.toHaveBeenCalled();
    expect(result.translated_vtt).toBe("WEBVTT\n\n");
  });

  it("forwards isActive and onProgress to waitDirectJob", async () => {
    backendClientMock.createDirectTranslateJob.mockResolvedValue({ job_id: "job-99" });
    backendClientMock.waitDirectJob.mockResolvedValue({ translated_vtt: "WEBVTT\n\n" });
    const isActive = vi.fn(() => true);
    const onProgress = vi.fn();

    await svc.translateWithConfig(
      { useLocalBackend: false, provider: "google-web" },
      "",
      { vtt_text: "WEBVTT\n\n", target: "ZH" },
      { isActive, onProgress }
    );

    expect(backendClientMock.waitDirectJob).toHaveBeenCalledWith("job-99", expect.objectContaining({
      isActive,
      target: "ZH",
      onProgress,
      onPartialVtt: expect.any(Function),
    }));
  });

  it("does not convert a non-404 async creation failure into a second translation", async () => {
    const backendError = Object.assign(new Error("backend overloaded"), { code: "HTTP_503", status: 503 });
    backendClientMock.proxyRequest.mockRejectedValue(backendError);

    await expect(svc.translateWithBackend("http://127.0.0.1:8765", { vtt_text: "WEBVTT" }))
      .rejects.toMatchObject({ code: "HTTP_503", status: 503 });
    expect(backendClientMock.proxyTranslateSync).not.toHaveBeenCalled();
  });

  it("stops a Google 429 burst and reruns the source through the Argos backend", async () => {
    window.Echo360Translator.buildConfig.enableLocalBackend = true;
    backendClientMock.createDirectTranslateJob.mockResolvedValue({ job_id: "google-job" });
    backendClientMock.waitDirectJob.mockRejectedValue(Object.assign(new Error("rate limit circuit open"), {
      code: "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN",
      metrics: { google429Responses: 5, googleCircuitTripped: true },
    }));
    backendClientMock.ensureArgosBackend.mockResolvedValue({ ready: true, launched: true });
    backendClientMock.proxyRequest.mockResolvedValue({ job_id: "argos-job" });
    backendClientMock.waitJob.mockResolvedValue({
      translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n",
      warnings: [],
      metrics: { total: 1, translated: 1, failed: 0 },
    });

    try {
      const result = await svc.translateWithConfig(
        { useLocalBackend: false, provider: "google-web" },
        "http://127.0.0.1:8765",
        {
          provider: "google-web",
          target: "ZH",
          vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n",
        }
      );

      expect(backendClientMock.ensureArgosBackend).toHaveBeenCalledWith("http://127.0.0.1:8765");
      expect(backendClientMock.proxyRequest).toHaveBeenCalledWith(
        "http://127.0.0.1:8765",
        "/translate-async",
        "POST",
        expect.objectContaining({ provider: "argos", concurrency: 1, retries: 0 })
      );
      expect(result.warnings[0]).toContain("改用本机 Argos");
      expect(result.metrics).toMatchObject({
        initialProvider: "google-web",
        fallbackProvider: "argos",
        google429Responses: 5,
        googleCircuitTripped: true,
      });
    } finally {
      window.Echo360Translator.buildConfig.enableLocalBackend = false;
    }
  });

  it("ensures the Argos program is running before an explicitly selected Argos translation", async () => {
    window.Echo360Translator.buildConfig.enableLocalBackend = true;
    backendClientMock.ensureArgosBackend.mockResolvedValue({ ready: true, launched: false });
    backendClientMock.proxyRequest.mockResolvedValue({ job_id: "argos-job" });
    backendClientMock.waitJob.mockResolvedValue({ translated_vtt: "WEBVTT\n\n" });

    try {
      await svc.translateWithConfig(
        { useLocalBackend: true, provider: "argos" },
        "http://127.0.0.1:8765",
        { provider: "argos", target: "ZH", vtt_text: "WEBVTT\n\n" }
      );
      expect(backendClientMock.ensureArgosBackend).toHaveBeenCalledTimes(1);
      expect(backendClientMock.proxyRequest).toHaveBeenCalledTimes(1);
      expect(backendClientMock.createDirectTranslateJob).not.toHaveBeenCalled();
    } finally {
      window.Echo360Translator.buildConfig.enableLocalBackend = false;
    }
  });
});

describe("buildCacheKey", () => {
  it("combines sourceId and config signature into cacheKey", async () => {
    const key = await svc.buildCacheKey(
      { provider: "openai", model: "gpt-5-nano" },
      "https://example.com/sub.vtt",
      "WEBVTT\n\nHello\n"
    );
    expect(key.sourceKey).toBe("https://example.com/sub.vtt");
    expect(key.configSig).toBe("openai|gpt-5-nano");
    expect(key.cacheKey).toBe("https://example.com/sub.vtt::openai|gpt-5-nano");
  });

  it("falls back to page href + vtt hash when sourceId is empty", async () => {
    Object.defineProperty(window, "location", {
      value: { href: "https://echo360.org/lesson/abc" },
      configurable: true,
      writable: true,
    });
    const key = await svc.buildCacheKey({ provider: "google-web", model: "" }, "", "WEBVTT\n\n");
    expect(key.sourceKey).toContain("https://echo360.org/lesson/abc#hash-");
    expect(key.cacheKey).toContain("::google-web|");
  });
});
