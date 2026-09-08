/**
 * Branch-coverage tests for extension/backend_client.js (extension direct-translate path)
 *
 * Store 构建下翻译在扩展内完成（createDirectTranslateJob / waitDirectJob），
 * 不依赖 Python 后端。此处只覆盖扩展侧错误格式化与直连任务轮询。
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

let client;
let runtimeSendMessage;

// ── setup ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  const ns = makeFullNs({
    browserApi: {
      runtime: { sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
      },
    },
  });
  runtimeSendMessage = ns.browserApi.runtime.sendMessage;
  window.Echo360Translator = ns;
  evalModule("error_utils.js");
  evalModule("backend_client.js");
  client = window.Echo360Translator.backendClient;
});

beforeEach(() => {
  vi.clearAllMocks();
  runtimeSendMessage.mockReset();
});

// ---------------------------------------------------------------------------
// friendlyErrorMessage
// ---------------------------------------------------------------------------
describe("friendlyErrorMessage", () => {
  it("preserves an existing [CODE] prefix already in the message", () => {
    const msg = "[MY_CODE] something went wrong";
    const result = client.friendlyErrorMessage(msg);
    expect(result).toContain("[MY_CODE]");
  });

  it("extracts HTTP 401 status and returns auth error", () => {
    const result = client.friendlyErrorMessage("HTTP 401 Unauthorized");
    expect(result).toContain("[HTTP_401]");
    expect(result).toContain("API Key 无效");
  });

  it("extracts HTTP 403 status and returns auth error", () => {
    const result = client.friendlyErrorMessage("HTTP 403 Forbidden");
    expect(result).toContain("[HTTP_403]");
    expect(result).toContain("API Key 无效");
  });

  it("explains HTTP 429 as a Google rate-limit and gives an actionable fix", () => {
    const result = client.friendlyErrorMessage("HTTP 429");
    expect(result).toContain("[HTTP_429]");
    expect(result).toContain("请求过于频繁");
    expect(result).toContain("降低 RPS/并发");
  });

  it("prioritizes the Google Web all-failed diagnosis over a nested HTTP 429", () => {
    const result = client.friendlyErrorMessage(
      "[GOOGLE_WEB_ALL_REQUESTS_FAILED] Google Web 全部请求失败；failureCodes={HTTP_429:304}"
    );
    expect(result).toContain("[GOOGLE_WEB_ALL_REQUESTS_FAILED]");
    expect(result).toContain("concurrency=3、RPS=3");
  });

  it("handles HTTP_403 underscore format", () => {
    const result = client.friendlyErrorMessage("HTTP_403 error");
    expect(result).toContain("[HTTP_403]");
  });

  it("maps 'Failed to fetch' to NETWORK_ERROR", () => {
    const result = client.friendlyErrorMessage("Failed to fetch");
    expect(result).toContain("[NETWORK_ERROR]");
    expect(result).toContain("网络请求失败");
  });

  it("maps 'timeout' (case-insensitive) to TRANSLATION_TIMEOUT", () => {
    const result = client.friendlyErrorMessage("Request Timeout after 30s");
    expect(result).toContain("[TRANSLATION_TIMEOUT]");
    expect(result).toContain("超时");
  });

  it("maps 'job not found' (case-insensitive) to JOB_NOT_FOUND", () => {
    const result = client.friendlyErrorMessage("job not found");
    expect(result).toContain("[JOB_NOT_FOUND]");
  });

  it("maps missing subtitle sources to an actionable NO_VTT_SOURCE error", () => {
    const result = client.friendlyErrorMessage("未找到可用字幕源（没有抓到有效 VTT）");
    expect(result).toContain("[NO_VTT_SOURCE]");
    expect(result).toContain("Transcript");
  });

  it("maps 'provider' (case-insensitive) to PROVIDER_CONFIG_ERROR", () => {
    const result = client.friendlyErrorMessage("Invalid Provider setting");
    expect(result).toContain("[PROVIDER_CONFIG_ERROR]");
    expect(result).toContain("Provider/Model 配置有误");
  });

  it("falls back to TRANSLATION_ERROR for generic messages", () => {
    const result = client.friendlyErrorMessage("Something completely unknown");
    expect(result).toContain("[TRANSLATION_ERROR]");
    expect(result).toContain("Something completely unknown");
  });

  it("handles null / undefined gracefully", () => {
    expect(() => client.friendlyErrorMessage(null)).not.toThrow();
    expect(() => client.friendlyErrorMessage(undefined)).not.toThrow();
  });

  it("strips leading 'Error: ' prefix from generic messages", () => {
    const result = client.friendlyErrorMessage("Error: network blip");
    expect(result).not.toMatch(/^\[.+\] Error: /);
    expect(result).toContain("network blip");
  });

  it("handles non-401/403 HTTP status codes as generic error", () => {
    const result = client.friendlyErrorMessage("HTTP 500 Internal Server Error");
    expect(result).toContain("[HTTP_500]");
    expect(result).not.toContain("API Key");
  });
});

describe("backend response contract", () => {
  it("normalizes camelCase job IDs at the creation boundary", () => {
    expect(client.validateJobCreationResponse({ jobId: "  job-42  " })).toEqual({
      jobId: "  job-42  ",
      job_id: "job-42",
    });
  });

  it("rejects a creation response without a job ID instead of starting a fake job", () => {
    expect(() => client.validateJobCreationResponse({ status: "queued" }))
      .toThrowError(expect.objectContaining({ code: "JOB_ID_MISSING" }));
    expect(() => client.validateJobCreationResponse(null))
      .toThrowError(expect.objectContaining({ code: "INVALID_BACKEND_RESPONSE" }));
  });

  it("preserves a nested provider diagnosis in an error creation response", () => {
    expect(() => client.validateJobCreationResponse({
      error_code: "INTERNAL_ERROR",
      status: 500,
      error: "local adapter failed",
      details: { cause: { code: "HTTP_429", status: 429 } },
    })).toThrowError(expect.objectContaining({ code: "HTTP_429", upstream_status: 429 }));
  });
});

// ---------------------------------------------------------------------------
// formatJobError (accessed via waitJob / waitDirectJob paths; test indirectly)
// ---------------------------------------------------------------------------
describe("formatJobError (via waitDirectJob)", () => {
  async function runDirectJobWith(jobData) {
    let calls = 0;
    runtimeSendMessage.mockImplementation((msg) => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? { ok: true, data: { job_id: "job-1" } }
        : { ok: true, data: jobData });
    });
    return client.waitDirectJob("job-1", { isActive: () => true });
  }

  it("returns result on completed job", async () => {
    const result = await runDirectJobWith({
      status: "completed",
      result: {
        translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n译文\n",
        warnings: [],
        cache_hit: false,
        metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
      },
      progress: { current: 0, total: 0 },
    });
    expect(result.translated_vtt).toContain("译文");
  });

  it("does not accept a completed job with a header-only VTT as success", async () => {
    await expect(runDirectJobWith({
      status: "completed",
      result: { translated_vtt: "WEBVTT\n\n", warnings: [], cache_hit: false },
      progress: { current: 10, total: 10 },
    })).rejects.toMatchObject({ code: "INVALID_TRANSLATED_VTT" });
  });

  it("does not accept a VTT where one of multiple cues has no caption text", () => {
    expect(() => client.validateTranslationResult({
      translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第一条\n\n00:00:01.000 --> 00:00:02.000\n\n",
      metrics: { total: 2, processed: 2, translated: 2, failed: 0, providerResults: 2, targetResults: 2 },
    })).toThrowError(expect.objectContaining({ code: "INVALID_TRANSLATED_VTT" }));
  });

  it("does not accept malformed timestamps as a valid translated VTT", () => {
    expect(() => client.validateTranslationResult({
      translated_vtt: "WEBVTT\n\n00:99:00.000 --> 00:99:01.000\n译文\n",
      metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
    })).toThrowError(expect.objectContaining({ code: "INVALID_TRANSLATED_VTT" }));
  });

  it("rejects a source VTT that contains an empty timed cue before translation starts", () => {
    expect(() => client.validateSourceVtt(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第一条\n\n00:00:01.000 --> 00:00:02.000\n\n",
      "source"
    )).toThrowError(expect.objectContaining({ code: "INVALID_SOURCE_VTT" }));
  });

  it("rejects a completed result whose cue count is smaller than the source", async () => {
    let thrown;
    try {
      client.validateTranslationResult({
        translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第一条\n",
        metrics: { total: 2, processed: 2, translated: 2, failed: 0, providerResults: 2, targetResults: 2 },
      }, "translation", {
        sourceVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n第一条\n\n00:00:01.000 --> 00:00:02.000\n第二条\n",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INCOMPLETE_TRANSLATED_VTT" });
  });

  it("reports missing failure details before classifying an all-failed result", async () => {
    let thrown;
    try {
      client.validateTranslationResult({
        translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n原文\n",
        metrics: { total: 1, processed: 1, translated: 0, failed: 1, providerResults: 0, targetResults: 0 },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "TRANSLATION_FAILURE_DETAILS_MISSING" });
    expect(thrown.metrics).toMatchObject({ providerResults: 0 });
  });

  it("classifies an all-failed result as NO_TRANSLATIONS when failure details are complete", async () => {
    let thrown;
    try {
      client.validateTranslationResult({
        translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n原文\n",
        metrics: {
          total: 1,
          processed: 1,
          translated: 0,
          failed: 1,
          providerResults: 0,
          targetResults: 0,
          failureCodes: { HTTP_429: 1 },
        },
        failed_items: [{ cue: 1, code: "HTTP_429", status: 429, message: "HTTP 429" }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "NO_TRANSLATIONS" });
    expect(thrown.metrics).toMatchObject({ providerResults: 0 });
    expect(thrown.failure_codes).toEqual({ HTTP_429: 1 });
  });

  it("throws error with [error_code] prefix when job fails (code not already in message)", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "rate limit exceeded",
        error_code: "HTTP_429",
        status_code: 429,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow(/\[HTTP_429\]/);
  });

  it("does NOT duplicate code prefix when it is already in the message", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "[HTTP_429] rate limit exceeded",
        error_code: "HTTP_429",
        status_code: 429,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow(/^\[HTTP_429\] rate limit exceeded$/);
  });

  it("uses status_code when error_code is absent", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "upstream error",
        error_code: "",
        status_code: 503,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow(/\[HTTP_503\]/);
  });

  it("uses a distinct diagnostic when a failed job has no error details", async () => {
    await expect(
      runDirectJobWith({
        status: "failed",
        error: "",
        error_code: "",
        status_code: null,
        progress: { current: 0, total: 0 },
      })
    ).rejects.toThrow("后台任务已标记失败，但没有返回错误码或诊断详情");
  });

  it("rejects a polling response with no status as malformed backend data", async () => {
    await expect(runDirectJobWith({ progress: { current: 0, total: 0 } }))
      .rejects.toMatchObject({ code: "INVALID_BACKEND_RESPONSE" });
  });

  it("throws stale error when isActive returns false", async () => {
    runtimeSendMessage.mockResolvedValue({
      ok: true,
      data: { status: "running", progress: { current: 0, total: 0 } },
    });
    await expect(
      client.waitDirectJob("job-1", { isActive: () => false })
    ).rejects.toThrow("stale job");
  });

  it("calls onProgress when job is running and total > 0", async () => {
    const onProgress = vi.fn();
    let calls = 0;
    runtimeSendMessage.mockImplementation((msg) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          data: {
            status: "running",
            progress: { current: 3, total: 10, line: "[3/10] Translating" },
          },
        });
      } else {
        return Promise.resolve({
          ok: true,
          data: {
            status: "completed",
            result: {
              translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n完成\n",
              warnings: [],
              cache_hit: false,
              metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
            },
            progress: { current: 10, total: 10 },
          },
        });
      }
    });
    await client.waitDirectJob("job-1", { isActive: () => true, onProgress });
    expect(onProgress).toHaveBeenCalledWith(3, 10, "[3/10] Translating", expect.objectContaining({ current: 3, total: 10 }));
  });

  it("calls onPartialVtt when partial_vtt changes during polling", async () => {
    const onPartialVtt = vi.fn();
    let calls = 0;
    runtimeSendMessage.mockImplementation((msg) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          data: {
            status: "running",
            partial_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPartial\n",
            progress: { current: 1, total: 10, partial: true },
          },
        });
      } else {
        return Promise.resolve({
          ok: true,
          data: {
            status: "completed",
            result: {
              translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n完成\n",
              warnings: [],
              cache_hit: false,
              metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
            },
            progress: { current: 10, total: 10 },
          },
        });
      }
    });
    await client.waitDirectJob("job-1", { isActive: () => true, onPartialVtt });
    expect(onPartialVtt).toHaveBeenCalledWith(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPartial\n",
      expect.objectContaining({ current: 1, total: 10 })
    );
  });

  it("also forwards partial_vtt from the local-backend async job", async () => {
    const onPartialVtt = vi.fn();
    const runtimeSendMessage = window.Echo360Translator.browserApi.runtime.sendMessage;
    runtimeSendMessage
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: "running",
          partial_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n部分结果\n",
          progress: { current: 1, total: 10, partial: true },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
          data: {
            status: "completed",
            result: {
              translated_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n完成\n",
              warnings: [],
              cache_hit: false,
              metrics: { total: 1, processed: 1, translated: 1, failed: 0, providerResults: 1, targetResults: 1 },
            },
            progress: { current: 10, total: 10 },
        },
      });

    await client.waitJob("http://127.0.0.1:8765", "job-1", { onPartialVtt });
    expect(onPartialVtt).toHaveBeenCalledWith(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n部分结果\n",
      expect.objectContaining({ current: 1, total: 10 })
    );
  });

  it("treats a polling 404 as a missing job instead of silently retrying translation", async () => {
    window.Echo360Translator.browserApi.runtime.sendMessage.mockResolvedValue({
      ok: false,
      error: "后台翻译任务不存在或已被清理",
      error_code: "HTTP_404",
      status: 404,
    });

    await expect(client.waitJob("http://127.0.0.1:8765", "missing-job"))
      .rejects.toMatchObject({ code: "JOB_NOT_FOUND", retryable: false });
  });
});
