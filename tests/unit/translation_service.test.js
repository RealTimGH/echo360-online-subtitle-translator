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
      "https://apse2.nv.instructuremedia.com/captions/source.vtt",
      expect.objectContaining({ deadlineAt: expect.any(Number) })
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

  it("normalizes raw SRT returned by a source adapter before shared validation", async () => {
    sourceFinderMock.fetchTranscriptFileVtt.mockResolvedValue({
      text: "1\n00:00:02,720 --> 00:00:06,590\nCaption\n",
      sourceId: "https://example.com/caption_files/source",
    });
    const result = await svc.resolveSourceVtt({});
    expect(result.vttText).toBe("WEBVTT\n\n1\n00:00:02.720 --> 00:00:06.590\nCaption");
    expect(backendClientMock.validateSourceVtt).toHaveBeenCalledWith(result.vttText, "source");
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
  it("normalizes raw SRT before sending it to any translation provider", () => {
    const payload = svc.buildTranslatePayload({ provider: "argos", target: "ZH" },
      "1\n00:00:02,720 --> 00:00:06,590\nOriginal caption\n", false);
    expect(payload.vtt_text).toBe("WEBVTT\n\n1\n00:00:02.720 --> 00:00:06.590\nOriginal caption");
  });
  it("rejects a missing source instead of emitting vtt_text: undefined", () => {
    expect(() => svc.buildTranslatePayload({ provider: "argos", target: "ZH" }, undefined, false))
      .toThrowError(expect.objectContaining({
        code: "INVALID_SOURCE_VTT",
        phase: "source",
      }));
  });

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
        azureRegion: "australiaeast",
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
    expect(payload.azure_region).toBe("australiaeast");
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

  it("passes azureRegion fallback to empty string", () => {
    const payload = svc.buildTranslatePayload({}, "WEBVTT\n\n", false);
    expect(payload.azure_region).toBe("");
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

  it("routes only the explicit custom-backend provider through the backend contract", async () => {
    backendClientMock.proxyRequest.mockResolvedValue({ job_id: "custom-job" });
    backendClientMock.waitJob.mockResolvedValue({ translated_vtt: "WEBVTT\n\n" });
    const payload = { provider: "custom-backend", target: "ZH", vtt_text: "WEBVTT\n\n" };

    await svc.translateWithConfig(
      { provider: "custom-backend" },
      "https://translator.example/api",
      payload
    );

    expect(backendClientMock.proxyRequest).toHaveBeenCalledWith(
      "https://translator.example/api",
      "/translate-async",
      "POST",
      payload
    );
    expect(backendClientMock.createDirectTranslateJob).not.toHaveBeenCalled();
    expect(backendClientMock.ensureArgosBackend).not.toHaveBeenCalled();
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
      expect(result.provider).toBe("argos");
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

  it("allocates cue work deterministically according to mixed-provider weights", () => {
    const units = Array.from({ length: 10 }, (_, index) => ({ index }));
    const groups = svc.allocateMixedUnits(units, [
      { provider: "google-web", weight: 70 },
      { provider: "deepl", weight: 30 },
    ]);
    expect(Object.fromEntries(groups.map((group) => [group.provider, group.units.length])))
      .toEqual({ "google-web": 7, deepl: 3 });
    expect(groups.flatMap((group) => group.units).map((unit) => unit.index).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 10 }, (_, index) => index));
  });

  it("runs mixed providers in parallel and reassigns a failed shard to a healthy provider", async () => {
    const jobs = new Map();
    let sequence = 0;
    backendClientMock.createDirectTranslateJob.mockImplementation(async (childPayload) => {
      const jobId = `mixed-${++sequence}`;
      jobs.set(jobId, childPayload);
      return { job_id: jobId };
    });
    backendClientMock.waitDirectJob.mockImplementation(async (jobId) => {
      const childPayload = jobs.get(jobId);
      if (childPayload.provider === "google-web") {
        throw Object.assign(new Error("temporary upstream failure"), { code: "HTTP_503", status: 503 });
      }
      const translated = childPayload.vtt_text.replace(/Hello (\d+)/g, "中文$1");
      return { translated_vtt: translated, warnings: [], failed_items: [], metrics: {} };
    });

    const source = [
      "WEBVTT", "",
      "00:00:00.000 --> 00:00:01.000", "Hello 1", "",
      "00:00:01.000 --> 00:00:02.000", "Hello 2", "",
      "00:00:02.000 --> 00:00:03.000", "Hello 3", "",
      "00:00:03.000 --> 00:00:04.000", "Hello 4", "",
    ].join("\n");
    const onPartialVtt = vi.fn();
    const result = await svc.translateWithConfig(
      {
        provider: "mixed",
        mixedProviders: [
          { provider: "google-web", weight: 50, enabled: true },
          { provider: "deepl", weight: 50, enabled: true },
        ],
      },
      "http://127.0.0.1:8765",
      {
        provider: "mixed",
        target: "ZH",
        vtt_text: source,
        mixed_providers: [
          { provider: "google-web", weight: 50, enabled: true },
          { provider: "deepl", weight: 50, enabled: true },
        ],
      },
      { onPartialVtt }
    );

    expect(backendClientMock.createDirectTranslateJob).toHaveBeenCalledTimes(3);
    expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item.provider))
      .toEqual(expect.arrayContaining(["google-web", "deepl", "deepl"]));
    expect(result.translated_vtt).toContain("中文1");
    expect(result.translated_vtt).toContain("中文4");
    expect(result.warnings.join(" ")).toContain("接管并完成");
    expect(result.metrics).toMatchObject({
      provider: "mixed",
      total: 4,
      processed: 4,
      translated: 4,
      failed: 0,
      providerResults: 4,
    });
    expect(onPartialVtt).toHaveBeenCalled();
  });

  it("forwards a mixed child partial before the child shard completes", async () => {
    const jobs = new Map();
    let sequence = 0;
    backendClientMock.createDirectTranslateJob.mockImplementation(async (childPayload) => {
      const jobId = `mixed-partial-${++sequence}`;
      jobs.set(jobId, childPayload);
      return { job_id: jobId };
    });
    backendClientMock.waitDirectJob.mockImplementation(async (jobId, options = {}) => {
      const childPayload = jobs.get(jobId);
      const partial = childPayload.vtt_text.replace(/Hello (\d+)/, "预览$1");
      options.onPartialVtt?.(partial, { completed: 1, total: 2, done: false });
      return {
        translated_vtt: childPayload.vtt_text.replace(/Hello (\d+)/g, "中文$1"),
        warnings: [],
        failed_items: [],
        metrics: { total: 2, processed: 2, translated: 2, failed: 0, providerResults: 2, targetResults: 2 },
      };
    });

    const source = [
      "WEBVTT", "",
      "00:00:00.000 --> 00:00:01.000", "Hello 1", "",
      "00:00:01.000 --> 00:00:02.000", "Hello 2", "",
      "00:00:02.000 --> 00:00:03.000", "Hello 3", "",
      "00:00:03.000 --> 00:00:04.000", "Hello 4", "",
    ].join("\n");
    const onPartialVtt = vi.fn();
    const result = await svc.translateWithConfig(
      {
        provider: "mixed",
        mixedProviders: [
          { provider: "google-web", weight: 50, enabled: true },
          { provider: "deepl", weight: 50, enabled: true },
        ],
      },
      "http://127.0.0.1:8765",
      {
        provider: "mixed",
        target: "ZH",
        vtt_text: source,
        mixed_providers: [
          { provider: "google-web", weight: 50, enabled: true },
          { provider: "deepl", weight: 50, enabled: true },
        ],
      },
      { onPartialVtt }
    );

    expect(onPartialVtt.mock.calls[0][0]).toContain("预览");
    expect(onPartialVtt.mock.calls[0][0]).not.toContain("中文");
    expect(result.translated_vtt).toContain("中文1");
    expect(result.metrics).toMatchObject({
      totalCues: 4,
      translatedCues: 4,
      failedCues: 0,
      providerBreakdown: {
        "google-web": expect.objectContaining({ completedCues: 2 }),
        deepl: expect.objectContaining({ completedCues: 2 }),
      },
    });
  });

  it("keeps successful cues from a partial provider result and reassigns only failed cues", async () => {
    const jobs = new Map();
    let sequence = 0;
    backendClientMock.createDirectTranslateJob.mockImplementation(async (childPayload) => {
      const jobId = `partial-${++sequence}`;
      jobs.set(jobId, childPayload);
      return { job_id: jobId };
    });
    backendClientMock.waitDirectJob.mockImplementation(async (jobId) => {
      const childPayload = jobs.get(jobId);
      if (childPayload.provider === "google-web") {
        return {
          translated_vtt: childPayload.vtt_text.replace("Hello 2", "中文2"),
          warnings: ["one cue failed"],
          failed_items: [{ cue: 2, line: 7, code: "HTTP_429", status: 429, message: "rate limited" }],
          failure_codes: { HTTP_429: 1 },
          metrics: { total: 2, processed: 2, translated: 1, failed: 1, providerResults: 1, targetResults: 1 },
        };
      }
      return {
        translated_vtt: childPayload.vtt_text.replace(/Hello (\d+)/g, "中文$1"),
        warnings: [],
        failed_items: [],
        metrics: {},
      };
    });

    const source = [
      "WEBVTT", "",
      "00:00:00.000 --> 00:00:01.000", "Hello 1", "",
      "00:00:01.000 --> 00:00:02.000", "Hello 2", "",
      "00:00:02.000 --> 00:00:03.000", "Hello 3", "",
      "00:00:03.000 --> 00:00:04.000", "Hello 4", "",
    ].join("\n");
    const providers = [
      { provider: "google-web", weight: 50, enabled: true },
      { provider: "deepl", weight: 50, enabled: true },
    ];
    const result = await svc.translateWithConfig(
      { provider: "mixed", mixedProviders: providers },
      "http://127.0.0.1:8765",
      { provider: "mixed", target: "ZH", vtt_text: source, mixed_providers: providers }
    );

    const deeplPayloads = backendClientMock.createDirectTranslateJob.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.provider === "deepl");
    expect(deeplPayloads).toHaveLength(2);
    expect(deeplPayloads.some((payload) => payload.vtt_text.includes("Hello 4") && !payload.vtt_text.includes("Hello 2"))).toBe(true);
    expect(result.translated_vtt).toContain("中文2");
    expect(result.translated_vtt).toContain("中文4");
    expect(result.warnings.join(" ")).toContain("已保留 1 个成功 cue 并改派");
  });

  it("reassigns a multi-line cue when more than one failed line maps to that cue", async () => {
    const jobs = new Map();
    let sequence = 0;
    backendClientMock.createDirectTranslateJob.mockImplementation(async (childPayload) => {
      const jobId = `multiline-${++sequence}`;
      jobs.set(jobId, childPayload);
      return { job_id: jobId };
    });
    backendClientMock.waitDirectJob.mockImplementation(async (jobId) => {
      const childPayload = jobs.get(jobId);
      if (childPayload.provider === "google-web") {
        return {
          translated_vtt: childPayload.vtt_text,
          failed_items: [
            { cue: 1, line: 4, code: "HTTP_429", status: 429 },
            { cue: 1, line: 5, code: "HTTP_429", status: 429 },
          ],
          failed_cues: [1],
          failure_codes: { HTTP_429: 2 },
          metrics: { total: 2, processed: 2, translated: 0, failed: 2 },
        };
      }
      return {
        translated_vtt: childPayload.vtt_text.replace("First line", "第一行").replace("Second line", "第二行"),
        failed_items: [],
        failed_cues: [],
        metrics: {},
      };
    });

    const providers = [
      { provider: "google-web", weight: 50, enabled: true },
      { provider: "deepl", weight: 50, enabled: true },
    ];
    const source = [
      "WEBVTT", "",
      "00:00:00.000 --> 00:00:01.000", "First line", "Second line", "",
      "00:00:01.000 --> 00:00:02.000", "Third line", "",
    ].join("\n");
    const result = await svc.translateWithConfig(
      { provider: "mixed", mixedProviders: providers },
      "http://127.0.0.1:8765",
      { provider: "mixed", target: "ZH", vtt_text: source, mixed_providers: providers }
    );

    expect(result.translated_vtt).toContain("第一行\n第二行");
    expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([payload]) => payload.provider))
      .toEqual(expect.arrayContaining(["google-web", "deepl"]));
  });

  function priorityCueVtt(count, multilineFirst = false) {
    const lines = ["WEBVTT", ""];
    for (let index = 0; index < count; index += 1) {
      lines.push(
        `00:00:${String(index).padStart(2, "0")}.000 --> 00:00:${String(index + 1).padStart(2, "0")}.000`,
        `Priority cue ${index + 1}`
      );
      if (multilineFirst && index === 0) lines.push("Second line");
      lines.push("");
    }
    return lines.join("\n");
  }

  function installSuccessfulMixedBackend() {
    const jobs = new Map();
    let sequence = 0;
    backendClientMock.createDirectTranslateJob.mockImplementation(async (childPayload) => {
      const jobId = `priority-${++sequence}`;
      jobs.set(jobId, childPayload);
      return { job_id: jobId };
    });
    backendClientMock.waitDirectJob.mockImplementation(async (jobId) => {
      const childPayload = jobs.get(jobId);
      return {
        translated_vtt: childPayload.vtt_text.replace(/Priority cue/g, "译文 cue").replace("Second line", "第二行"),
        failed_items: [],
        metrics: {},
      };
    });
    return jobs;
  }

  function priorityConfig(providers, groups) {
    return {
      provider: "mixed",
      mixedPriorityEnabled: true,
      mixedPriorityGroups: groups,
      mixedProviders: providers,
    };
  }

  function priorityPayload(providers, groups, source, target = "ZH") {
    return {
      provider: "mixed",
      target,
      vtt_text: source,
      mixed_providers: providers,
      mixed_priority_enabled: true,
      mixed_priority_groups: groups,
    };
  }

  it("uses the strict N versus N+1 threshold and counts a multi-line cue once", async () => {
    installSuccessfulMixedBackend();
    const groups = [{ id: "first", afterCues: 0 }, { id: "second", afterCues: 2 }];
    const providers = [
      { provider: "google-web", weight: 50, enabled: true, priorityGroup: "first" },
      { provider: "deepl", weight: 50, enabled: true, priorityGroup: "second" },
    ];
    const config = priorityConfig(providers, groups);

    const exactlyAtThreshold = priorityCueVtt(2, true);
    await svc.translateWithConfig(config, "http://127.0.0.1:8765", priorityPayload(providers, groups, exactlyAtThreshold));
    expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item.provider))
      .toEqual(["google-web"]);
    expect(backendClientMock.createDirectTranslateJob.mock.calls[0][0].mixed_priority_enabled).toBeUndefined();
    expect(backendClientMock.createDirectTranslateJob.mock.calls[0][0].mixed_priority_groups).toBeUndefined();

    backendClientMock.createDirectTranslateJob.mockClear();
    await svc.translateWithConfig(config, "http://127.0.0.1:8765", priorityPayload(providers, groups, priorityCueVtt(3)));
    expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item.provider))
      .toEqual(expect.arrayContaining(["google-web", "deepl"]));
  });

  it("activates three priority levels cumulatively and preserves each cue once", async () => {
    installSuccessfulMixedBackend();
    const groups = [
      { id: "first", afterCues: 0 },
      { id: "second", afterCues: 2 },
      { id: "third", afterCues: 4 },
    ];
    const providers = [
      { provider: "google-web", weight: 1, enabled: true, priorityGroup: "first" },
      { provider: "deepl", weight: 1, enabled: true, priorityGroup: "second" },
      { provider: "gemini", weight: 1, enabled: true, priorityGroup: "third" },
    ];
    const source = priorityCueVtt(5);
    const result = await svc.translateWithConfig(
      priorityConfig(providers, groups),
      "http://127.0.0.1:8765",
      priorityPayload(providers, groups, source)
    );
    const calls = backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item);
    expect(calls.map((item) => item.provider)).toEqual(expect.arrayContaining(["google-web", "deepl", "gemini"]));
    expect(result.metrics.mixedPriority).toMatchObject({
      enabled: true,
      count: 3,
      activeGroupCount: 3,
      activeGroupIds: ["first", "second", "third"],
    });
    expect(Object.values(result.metrics.providerBreakdown).every((item) => Number.isInteger(item.priorityIndex))).toBe(true);
    expect((result.translated_vtt.match(/译文 cue/g) || []).length).toBe(5);
    expect(result.translated_vtt.match(/Priority cue/g)).toBeNull();
  });

  it("allows a single provider only when priority routing is enabled", () => {
    const providers = [{ provider: "google-web", weight: 100, enabled: true, priorityGroup: "only" }];
    const groups = [{ id: "only", afterCues: 0 }];
    expect(svc.normalizeMixedProviders(
      priorityConfig(providers, groups),
      priorityPayload(providers, groups, priorityCueVtt(1))
    )).toEqual([{ provider: "google-web", weight: 100, priorityGroup: "only", priorityIndex: 0 }]);
    expect(() => svc.normalizeMixedProviders(
      { mixedProviders: [{ provider: "google-web", weight: 100, enabled: true }] },
      { target: "ZH" }
    )).toThrowError(expect.objectContaining({ code: "MIXED_PROVIDERS_REQUIRED", phase: "config" }));
  });

  it("does not start a threshold-excluded Argos provider", async () => {
    installSuccessfulMixedBackend();
    window.Echo360Translator.buildConfig.enableLocalBackend = true;
    const groups = [{ id: "first", afterCues: 0 }, { id: "later", afterCues: 2 }];
    const providers = [
      { provider: "google-web", weight: 100, enabled: true, priorityGroup: "first" },
      { provider: "argos", weight: 100, enabled: true, priorityGroup: "later" },
    ];
    try {
      await svc.translateWithConfig(
        priorityConfig(providers, groups),
        "http://127.0.0.1:8765",
        priorityPayload(providers, groups, priorityCueVtt(2))
      );
      expect(backendClientMock.ensureArgosBackend).not.toHaveBeenCalled();
      expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item.provider))
        .toEqual(["google-web"]);
    } finally {
      window.Echo360Translator.buildConfig.enableLocalBackend = false;
    }
  });

  it("rejects malformed priority groups and an incompatible first group without promoting a later group", () => {
    const validProviders = [
      { provider: "google-web", weight: 50, enabled: true, priorityGroup: "first" },
      { provider: "gemini", weight: 50, enabled: true, priorityGroup: "second" },
    ];
    const cases = [
      {
        groups: [{ id: "first", afterCues: 0 }, { id: "first", afterCues: 2 }],
        providers: validProviders,
      },
      {
        groups: [{ id: "first", afterCues: 1 }, { id: "second", afterCues: 2 }],
        providers: validProviders,
      },
      {
        groups: [{ id: "first", afterCues: 0 }, { id: "second", afterCues: 0 }],
        providers: validProviders,
      },
      {
        groups: [{ id: "first", afterCues: 0 }, { id: "second", afterCues: 2 }],
        providers: [{ provider: "google-web", enabled: true, priorityGroup: "missing" }],
      },
      {
        groups: [{ id: "first", afterCues: 0 }, { id: "second", afterCues: 2 }],
        providers: [{ provider: "google-web", enabled: true, priorityGroup: "first" }],
      },
    ];
    for (const item of cases) {
      expect(() => svc.normalizeMixedProviders(
        priorityConfig(item.providers, item.groups),
        priorityPayload(item.providers, item.groups, priorityCueVtt(3))
      )).toThrowError(expect.objectContaining({ code: "MIXED_PRIORITY_CONFIG_INVALID", phase: "config" }));
    }

    const incompatibleFirst = [
      { provider: "deepl", weight: 50, enabled: true, priorityGroup: "first" },
      { provider: "google-web", weight: 50, enabled: true, priorityGroup: "second" },
    ];
    expect(() => svc.normalizeMixedProviders(
      priorityConfig(incompatibleFirst, [{ id: "first", afterCues: 0 }, { id: "second", afterCues: 2 }]),
      priorityPayload(incompatibleFirst, [{ id: "first", afterCues: 0 }, { id: "second", afterCues: 2 }], priorityCueVtt(3), "YUE")
    )).toThrowError(expect.objectContaining({ code: "MIXED_PRIORITY_CONFIG_INVALID", phase: "config" }));
  });

  it("does not use threshold-excluded providers for fallback and prefers lower group indexes", async () => {
    const groups = [
      { id: "first", afterCues: 0 },
      { id: "second", afterCues: 1 },
      { id: "third", afterCues: 2 },
    ];
    const providers = [
      { provider: "google-web", weight: 100, enabled: true, priorityGroup: "first" },
      { provider: "deepl", weight: 1, enabled: true, priorityGroup: "second" },
      { provider: "gemini", weight: 1, enabled: true, priorityGroup: "third" },
    ];
    const jobs = new Map();
    let sequence = 0;
    backendClientMock.createDirectTranslateJob.mockImplementation(async (childPayload) => {
      const jobId = `fallback-${++sequence}`;
      jobs.set(jobId, childPayload);
      return { job_id: jobId };
    });
    backendClientMock.waitDirectJob.mockImplementation(async (jobId) => {
      const provider = jobs.get(jobId).provider;
      if (provider === "google-web" || provider === "deepl") {
        throw Object.assign(new Error(`${provider} failed`), { code: "HTTP_503", status: 503 });
      }
      return {
        translated_vtt: jobs.get(jobId).vtt_text.replace(/Priority cue/g, "译文 cue"),
        failed_items: [],
        metrics: {},
      };
    });

    const twoCues = priorityCueVtt(2);
    await expect(svc.translateWithConfig(
      priorityConfig(providers, groups),
      "http://127.0.0.1:8765",
      priorityPayload(providers, groups, twoCues)
    )).rejects.toThrowError(expect.objectContaining({ code: "MIXED_ALL_PROVIDERS_FAILED" }));
    expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item.provider))
      .toEqual(["google-web", "deepl"]);

    backendClientMock.createDirectTranslateJob.mockClear();
    jobs.clear();
    sequence = 0;
    await svc.translateWithConfig(
      priorityConfig(providers, groups),
      "http://127.0.0.1:8765",
      priorityPayload(providers, groups, priorityCueVtt(3))
    );
    expect(backendClientMock.createDirectTranslateJob.mock.calls.map(([item]) => item.provider))
      .toEqual(["google-web", "deepl", "gemini"]);
  });

  it("rejects a mixed configuration with fewer than two compatible providers", () => {
    expect(() => svc.normalizeMixedProviders(
      { mixedProviders: [{ provider: "deepl", weight: 100 }] },
      { target: "YUE" }
    )).toThrowError(expect.objectContaining({ code: "MIXED_PROVIDERS_REQUIRED" }));
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
