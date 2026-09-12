import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { evalModule } from "../helpers/load-module.js";

let translator;

beforeAll(() => {
  evalModule("direct_translator.js");
  translator = window.Echo360DirectTranslator;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("direct translator provider safeguards", () => {
  it("rejects the extension's bilingual output before any provider request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const bilingualVtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
First line
第一行

00:00:01.000 --> 00:00:02.000
Second line
第二行

00:00:02.000 --> 00:00:03.000
Third line
第三行
`;

    try {
      await expect(translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 1,
        retries: 0,
        timeout: 5,
        vtt_text: bilingualVtt,
      })).rejects.toMatchObject({
        code: "SOURCE_ALREADY_TRANSLATED",
        status: 422,
        phase: "source",
        details: {
          sourceStructure: expect.objectContaining({
            probable: true,
            cueCount: 3,
            mixedCueCount: 3,
            textLineCount: 6,
          }),
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses the configured bounded Google web cadence", () => {
    const adapter = translator.getProviderAdapter("google-web");

    expect(adapter.concurrencyCap).toBe(48);
    expect(adapter.defaultRps).toBe(0);
  });

  it("batches Azure Translator inputs with the official v3 target and optional region headers", async () => {
    const adapter = translator.getProviderAdapter("azure");
    expect(adapter).toMatchObject({
      protocol: "azure-translator",
      defaultEndpoint: "https://api.cognitive.microsofttranslator.com/translate",
      concurrencyCap: 8,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(JSON.stringify([
        { detectedLanguage: { language: "en", score: 1 }, translations: [{ text: "第一條", to: "zh-Hant" }] },
        { detectedLanguage: { language: "en", score: 1 }, translations: [{ text: "第二條", to: "zh-Hant" }] },
      ]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    try {
      const result = await translator.translateVtt({
        provider: "azure",
        api_key: "azure-test-key",
        azure_region: "australiaeast",
        target: "ZH-HK",
        concurrency: 96,
        retries: 0,
        timeout: 5,
        max_paragraphs: 6,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [rawUrl, init] = fetchMock.mock.calls[0];
      const requestUrl = new URL(rawUrl);
      expect(requestUrl.origin + requestUrl.pathname).toBe("https://api.cognitive.microsofttranslator.com/translate");
      expect(requestUrl.searchParams.get("api-version")).toBe("3.0");
      expect(requestUrl.searchParams.getAll("to")).toEqual(["zh-Hant"]);
      expect(init).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          "Ocp-Apim-Subscription-Key": "azure-test-key",
          "Ocp-Apim-Subscription-Region": "australiaeast",
          "Content-Type": "application/json; charset=UTF-8",
        }),
      });
      expect(JSON.parse(init.body)).toEqual([{ Text: "first" }, { Text: "second" }]);
      expect(result.translated_vtt).toContain("第一條");
      expect(result.translated_vtt).toContain("第二條");
      expect(result.failed_items).toEqual([]);
      expect(result.metrics).toMatchObject({
        provider: "azure",
        total: 2,
        batches: 1,
        effectiveConcurrency: 1,
        translated: 2,
        providerResults: 2,
        targetResults: 2,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("maps Cantonese to Azure yue and omits the region header for a global resource", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(JSON.stringify([
        { translations: [{ text: "呢個係字幕。", to: "yue" }] },
      ]), { status: 200, headers: { "content-type": "application/json" } })
    ));

    try {
      const result = await translator.translateVtt({
        provider: "azure",
        api_key: "azure-test-key",
        target: "YUE",
        concurrency: 1,
        retries: 0,
        timeout: 5,
        max_paragraphs: 6,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nThis is a subtitle.\n",
      });

      const [rawUrl, init] = fetchMock.mock.calls[0];
      expect(new URL(rawUrl).searchParams.get("to")).toBe("yue");
      expect(init.headers).not.toHaveProperty("Ocp-Apim-Subscription-Region");
      expect(result.translated_vtt).toContain("呢個係字幕。");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps Azure batches within the conservative v3 item limit even with oversized dev settings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(body.map((item, index) => ({
        translations: [{ text: `译文${index + 1}`, to: "zh-Hans" }],
      }))), { status: 200, headers: { "content-type": "application/json" } });
    });
    const cues = Array.from({ length: 26 }, (_, index) => (
      `\n00:00:${String(index).padStart(2, "0")}.000 --> 00:00:${String(index + 1).padStart(2, "0")}.000\nline ${index + 1}\n`
    )).join("");

    try {
      const result = await translator.translateVtt({
        provider: "azure",
        api_key: "azure-test-key",
        target: "ZH",
        concurrency: 96,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1000,
        max_chars: 50000,
        vtt_text: `WEBVTT\n${cues}`,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).length).sort((a, b) => a - b))
        .toEqual([1, 25]);
      expect(result.metrics).toMatchObject({ total: 26, batches: 2, effectiveConcurrency: 2, translated: 26 });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects a malformed Azure response instead of caching a partial success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(JSON.stringify([{ translations: [] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    try {
      await expect(translator.translateVtt({
        provider: "azure",
        api_key: "azure-test-key",
        target: "ZH",
        concurrency: 1,
        retries: 0,
        timeout: 5,
        max_paragraphs: 6,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nmalformed\n",
      })).rejects.toMatchObject({
        code: "INVALID_PROVIDER_OUTPUT",
        provider: "azure",
        metrics: expect.objectContaining({ translated: 0, providerResults: 0 }),
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps failed Google cues, reports partial progress, and never recursively storms after 429", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const query = new URL(url).searchParams.get("q");
      if (query === "first") {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify([[ ["第二条", "second"] ]]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const progress = vi.fn();
    const partial = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 96,
        rps: 96,
        retries: 0,
        timeout: 5,
        max_paragraphs: 6,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n",
      }, { onProgress: progress, onPartialVtt: partial });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.failed_items).toHaveLength(1);
      expect(result.failed_items[0]).toMatchObject({ code: "HTTP_429", status: 429 });
      expect(result.translated_vtt).toContain("first");
      expect(result.translated_vtt).toContain("第二条");
      expect(result.metrics).toMatchObject({
        requestedConcurrency: 96,
        effectiveConcurrency: 2,
        requestedRps: 96,
        batches: 2,
        effectiveRps: 96,
        failed: 1,
        translated: 1,
        rateLimitCount: 1,
      });
      expect(progress).toHaveBeenCalledWith(0, 2, "[0/2] Translating...", expect.objectContaining({ effectiveRps: 96 }));
      expect(progress).toHaveBeenLastCalledWith(2, 2, "[2/2] Translating...", expect.objectContaining({ failed: 1 }));
      expect(partial).toHaveBeenLastCalledWith(
        expect.stringContaining("第二条"),
        expect.objectContaining({
          done: true,
          failed_items: [expect.objectContaining({ cue: 1, code: "HTTP_429" })],
        })
      );
      expect(errorLog).toHaveBeenCalledWith(
        "[echo360-translator][direct] subtitle item failed; original kept",
        expect.objectContaining({ error: expect.objectContaining({ code: "HTTP_429" }) })
      );
    } finally {
      errorLog.mockRestore();
      fetchMock.mockRestore();
    }
  });

  it("does not count a failed non-Google cue as a provider success", async () => {
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return new Response("upstream failure", { status: 503 });
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: "第二条" }] }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const result = await translator.translateVtt({
        provider: "openai",
        target: "ZH",
        api_key: "sk-test",
        model: "gpt-5-nano",
        endpoint: "https://api.openai.com/v1/responses",
        concurrency: 1,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n",
      });

      expect(result.metrics).toMatchObject({
        total: 2,
        processed: 2,
        translated: 1,
        failed: 1,
        providerResults: 1,
        targetResults: 1,
      });
      expect(result.failed_items).toHaveLength(1);
      expect(result.translated_vtt).toContain("first");
      expect(result.translated_vtt).toContain("第二条");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reports a distinct all-requests-failed error with failure codes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response("rate limited", { status: 429 })
    ));
    const partial = vi.fn();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 96,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        max_chars: 1200,
        // The normal path performs one adaptive 3/3 recovery attempt. This
        // flag isolates the final error classification for this unit test.
        __googleWebRecoveryAttempt: true,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n",
      }, { onPartialVtt: partial })).rejects.toMatchObject({
        code: "GOOGLE_WEB_ALL_REQUESTS_FAILED",
        metrics: expect.objectContaining({
          effectiveConcurrency: 2,
          effectiveRps: 0,
          failed: 2,
        }),
        failure_codes: { HTTP_429: 2 },
      });
      expect(partial).toHaveBeenLastCalledWith(
        expect.stringContaining("first"),
        expect.objectContaining({ failed: 2, done: true })
      );
      expect(errorLog).toHaveBeenCalledWith(
        "[echo360-translator][direct] translation failed",
        expect.objectContaining({
          code: "GOOGLE_WEB_ALL_REQUESTS_FAILED",
          failureCodes: { HTTP_429: 2 },
        })
      );
    } finally {
      errorLog.mockRestore();
      fetchMock.mockRestore();
    }
  });

  it("opens the Google 429 circuit after a burst and skips retries and adaptive Google recovery", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
    ));
    const cues = Array.from({ length: 12 }, (_, index) => (
      `\n${index + 1}\n00:00:${String(index).padStart(2, "0")}.000 --> 00:00:${String(index + 1).padStart(2, "0")}.000\nline ${index + 1}\n`
    )).join("");

    try {
      await expect(translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 2,
        rps: 0,
        retries: 2,
        timeout: 5,
        max_paragraphs: 1,
        max_chars: 1200,
        vtt_text: `WEBVTT\n${cues}`,
      })).rejects.toMatchObject({
        code: "GOOGLE_WEB_RATE_LIMIT_CIRCUIT_OPEN",
        metrics: expect.objectContaining({
          google429Responses: 5,
          googleCircuitTripped: true,
        }),
      });
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(fetchMock.mock.calls.length).toBeLessThan(12);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("classifies Safari Load failed responses as network failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Load failed"));

    try {
      await expect(translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 1,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        __googleWebRecoveryAttempt: true,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nnetwork failure\n",
      })).rejects.toMatchObject({
        code: "GOOGLE_WEB_ALL_REQUESTS_FAILED",
        failure_codes: { NETWORK_ERROR: 1 },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("automatically retries an all-failed 96/0 run with the adaptive 3/3 profile", async () => {
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      calls += 1;
      if (calls <= 2) return new Response("rate limited", { status: 429 });
      const text = new URL(url).searchParams.get("q");
      return new Response(JSON.stringify([[ [text === "first" ? "第一条" : "第二条", text] ]]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const result = await translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 96,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n",
      });

      expect(calls).toBe(4);
      expect(result.translated_vtt).toContain("第一条");
      expect(result.translated_vtt).toContain("第二条");
      expect(result.failed_items).toEqual([]);
      expect(result.metrics).toMatchObject({
        recoveryAttempted: true,
        effectiveConcurrency: 2,
        effectiveRps: 3,
        initialProfile: {
          effectiveConcurrency: 2,
          effectiveRps: 0,
          failed: 2,
          failureCodes: { HTTP_429: 2 },
        },
        recoveryProfile: { concurrency: 2, rps: 3, retries: 1 },
      });
      expect(result.warnings[0]).toContain("已自动切换到 concurrency=2, rps=3");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("also retries when Google returns unchanged English instead of throwing request errors", async () => {
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      calls += 1;
      const text = new URL(url).searchParams.get("q");
      if (calls <= 2) {
        return new Response(JSON.stringify([[ [text, text] ]]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([[ [text === "first" ? "第一条" : "第二条", text] ]]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const result = await translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 96,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst\n\n00:00:01.000 --> 00:00:02.000\nsecond\n",
      });

      expect(calls).toBe(4);
      expect(result.translated_vtt).toContain("第一条");
      expect(result.translated_vtt).toContain("第二条");
      expect(result.metrics).toMatchObject({
        recoveryAttempted: true,
        initialProfile: {
          providerResults: 0,
          targetResults: 0,
          unchangedResults: 2,
        },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("classifies an all-unchanged Google response with actionable target metrics", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const text = new URL(url).searchParams.get("q");
      return new Response(JSON.stringify([[ [text, text] ]]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await expect(translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 1,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        __googleWebRecoveryAttempt: true,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nunchanged\n",
      })).rejects.toMatchObject({
        code: "GOOGLE_WEB_NO_TARGET_TRANSLATIONS",
        metrics: expect.objectContaining({
          providerResults: 0,
          targetResults: 0,
          unchangedResults: 1,
        }),
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("accepts an unchanged grade/code caption as a valid neutral Chinese-target item", async () => {
    expect(translator.isTargetNeutralText("F.", "F.", "ZH")).toBe(true);
    expect(translator.isTargetNeutralText("unchanged", "unchanged", "ZH")).toBe(false);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(JSON.stringify([[ ["F.", "F."] ]]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    try {
      const result = await translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 1,
        rps: 0,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nF.\n",
      });

      expect(result.failed_items).toEqual([]);
      expect(result.metrics).toMatchObject({
        total: 1,
        processed: 1,
        translated: 1,
        failed: 0,
        providerResults: 1,
        targetResults: 1,
        unchangedResults: 1,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("does not report an all-failed non-Google job as a successful partial result", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Load failed"));

    try {
      await expect(translator.translateVtt({
        provider: "deepl",
        api_key: "test-key",
        target: "EN",
        endpoint: "https://api-free.deepl.com/v2/translate",
        concurrency: 1,
        retries: 0,
        timeout: 5,
        max_paragraphs: 1,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nall failed\n",
      })).rejects.toMatchObject({
        code: "NO_TRANSLATIONS",
        metrics: expect.objectContaining({ total: 1, failed: 1, providerResults: 0 }),
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("honors Retry-After/backoff and exposes a retry event for a transient 429", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify([[ ["成功", "retry me"] ]]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const retryLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const pending = translator.translateVtt({
        provider: "google-web",
        target: "ZH",
        concurrency: 3,
        rps: 3,
        retries: 1,
        timeout: 5,
        max_paragraphs: 6,
        max_chars: 1200,
        vtt_text: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nretry me\n",
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(calls).toBe(2);
      expect(result.failed_items).toEqual([]);
      expect(result.metrics.retryCount).toBe(1);
      expect(result.metrics.rateLimitCount).toBe(1);
      expect(retryLog).toHaveBeenCalledWith(
        "[echo360-translator][direct] retry scheduled",
        expect.objectContaining({ status: 429, attempt: 1 })
      );
    } finally {
      retryLog.mockRestore();
      fetchMock.mockRestore();
      Math.random.mockRestore();
    }
  });
});
