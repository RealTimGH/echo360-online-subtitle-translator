import { describe, expect, it } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

function loadErrors() {
  window.Echo360Translator = makeFullNs();
  evalModule("error_utils.js");
  return window.Echo360Translator.errorUtils;
}

describe("structured error model", () => {
  it("explains Google 429 recovery with metrics and an actionable recommendation", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "GOOGLE_WEB_ALL_REQUESTS_FAILED",
      message: "Google Web 全部请求失败",
      metrics: {
        provider: "google-web",
        total: 304,
        processed: 304,
        translated: 0,
        failed: 304,
        effectiveConcurrency: 3,
        effectiveRps: 3,
        retryCount: 304,
        rateLimitCount: 608,
        recoveryAttempted: true,
        initialProfile: { effectiveConcurrency: 96, effectiveRps: 0 },
        recoveryProfile: { concurrency: 3, rps: 3 },
        failureCodes: { HTTP_429: 304 },
      },
      failure_codes: { HTTP_429: 304 },
    }, { phase: "recovery", provider: "google-web", target: "ZH", runId: "run-1" });

    expect(model.title).toContain("被限流");
    expect(model.summary).toContain("HTTP 429");
    expect(model.recommendation).toContain("concurrency=3");
    expect(model.details.map((item) => item.label)).toEqual(expect.arrayContaining([
      "阶段", "错误码", "进度", "实际参数", "自动恢复", "失败原因统计",
    ]));
    expect(model.copyText).toContain("HTTP_429 × 304");
  });

  it("shows subtitle-source diagnostics instead of blaming the provider", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "NO_VTT_SOURCE",
      message: "未找到可用字幕源（没有抓到有效 VTT）",
      candidateCount: 2,
      candidateUrls: ["https://media.example/captions"],
      sourceStrategy: "instructure-candidate-scan",
    }, { phase: "source" });

    expect(model.title).toBe("没有找到可用字幕源");
    expect(model.summary).toContain("WebVTT/SRT");
    expect(model.details.find((item) => item.label === "字幕查找策略").value).toContain("2 个");
    expect(model.details.find((item) => item.label === "候选字幕地址").value).toContain("captions");
  });

  it("keeps partial translations as a visible warning with failed cue samples", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "PARTIAL_TRANSLATION",
      message: "部分字幕失败",
      metrics: { total: 4, processed: 4, translated: 3, failed: 1 },
      failed_items: [{ cue: 4, code: "HTTP_503", status: 503, message: "upstream unavailable" }],
    }, { phase: "translation", severity: "warning" });

    expect(model.severity).toBe("warning");
    expect(model.title).toContain("有字幕失败");
    expect(model.details.find((item) => item.label.includes("失败字幕")).value).toContain("第 4 条");
  });

  it("supports legacy flattened messages without throwing", () => {
    const errors = loadErrors();
    expect(errors.friendlyErrorMessage("HTTP 401 Unauthorized")).toContain("API Key");
    expect(errors.friendlyErrorMessage(null)).toContain("ERROR_DETAILS_MISSING");
    expect(errors.friendlyErrorMessage("Something completely unknown")).toContain("TRANSLATION_ERROR");
  });

  it("uses rate-limit metrics even when an older backend reports NO_TRANSLATIONS", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "NO_TRANSLATIONS",
      message: "Provider did not return Chinese subtitles",
      metrics: { total: 304, failed: 304, rateLimitCount: 12 },
      failure_codes: { HTTP_429: 12 },
    }, { phase: "translation", provider: "google-web", target: "ZH" });

    expect(model.title).toContain("疑似被限流");
    expect(model.summary).toContain("HTTP 429");
    expect(model.recommendation).toContain("RPS=3");
  });

  it("explains subtitle fetch failures and unsupported resource hosts", () => {
    const errors = loadErrors();
    const fetchModel = errors.normalizeError({ code: "RESOURCE_NETWORK_ERROR", message: "Load failed" }, { phase: "source" });
    const hostModel = errors.normalizeError({ code: "RESOURCE_HOST_NOT_ALLOWED", message: "resource host is not allowed" }, { phase: "source" });

    expect(fetchModel.title).toBe("字幕文件读取失败");
    expect(hostModel.title).toContain("不在允许的站点范围");
    expect(hostModel.details.find((item) => item.label === "阶段").value).toBe("获取字幕源");
  });

  it("preserves RFC problem details and classifies subtitle access failures by phase", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      problem: {
        type: "https://example.invalid/problems/caption-access",
        title: "Caption access denied",
        status: 403,
        detail: "caption endpoint rejected the session",
      },
    }, { phase: "source" });

    expect(model.code).toBe("HTTP_403");
    expect(model.status).toBe(403);
    expect(model.title).toBe("字幕源访问被拒绝");
    expect(model.type).toBe("https://example.invalid/problems/caption-access");
    expect(model.details.find((item) => item.label === "原始错误").value).toContain("caption endpoint");
  });

  it("does not tell Google Web users to configure an API key for a no-result failure", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "NO_TRANSLATIONS",
      message: "no target-language result",
      metrics: { total: 3, processed: 3, providerResults: 0, targetResults: 0 },
    }, { phase: "translation", provider: "google-web", target: "ZH" });

    expect(model.title).toContain("Google");
    expect(model.recommendation).not.toContain("API Key");
  });

  it("turns Argos setup failures into local installation guidance", () => {
    const errors = loadErrors();
    const dependency = errors.normalizeError({
      code: "ARGOS_DEPENDENCY_MISSING",
      message: "argostranslate is not installed",
      status: 503,
    }, { phase: "translation", provider: "argos", target: "ZH" });
    const model = errors.normalizeError({
      code: "ARGOS_MODEL_MISSING",
      message: "no installed translation path en->zh",
      status: 503,
    }, { phase: "translation", provider: "argos", target: "ZH" });

    expect(dependency.title).toContain("Argos Translate");
    expect(dependency.recommendation).toContain("requirements-argos.txt");
    expect(model.title).toContain("Argos 翻译模型");
    expect(model.recommendation).toContain("translate-en_zh");
  });

  it("keeps cache invalidity distinct from a storage read failure", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "INVALID_TRANSLATION_CACHE",
      message: "cache is readable but has no timed cues",
    }, { phase: "cache", severity: "warning" });

    expect(model.severity).toBe("warning");
    expect(model.title).toBe("翻译缓存无效");
    expect(model.summary).toContain("可以读取");
  });

  it("does not flatten nested problem objects to [object Object]", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      error: { code: "HTTP_503", detail: "caption upstream unavailable", status: 503 },
    }, { phase: "source" });

    expect(model.code).toBe("HTTP_503");
    expect(model.message).toBe("caption upstream unavailable");
    expect(model.message).not.toContain("[object Object]");
  });

  it("does not flatten object-valued failed-item diagnostics", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "PARTIAL_TRANSLATION",
      message: "partial",
      failed_items: [{ cue: 1, code: "HTTP_503", message: { detail: "upstream unavailable" } }],
    }, { severity: "warning" });
    expect(model.details.find((item) => item.label.includes("失败字幕")).value).not.toContain("[object Object]");
    expect(model.details.find((item) => item.label.includes("失败字幕")).value).toContain("upstream unavailable");
  });

  it("does not flatten an otherwise unclassified object to [object Object]", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({ unexpected: "diagnostic" });
    expect(model.message).not.toContain("[object Object]");
    expect(model.message).toContain("unexpected");
  });

  it("redacts credential-shaped values from flattened messages", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({ message: "Authorization: Bearer sk-secret-value" });
    expect(model.message).not.toContain("sk-secret-value");
    expect(model.copyText).toContain("[REDACTED]");
  });

  it("redacts a plain bearer token instead of leaving the token after the scheme", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      message: "request failed Authorization: Bearer plain-secret-value",
    });
    expect(model.message).not.toContain("plain-secret-value");
    expect(model.copyText).toContain("[REDACTED]");
  });

  it("uses status/message inference when a generic adapter code masks a real cause", () => {
    const errors = loadErrors();
    expect(errors.getErrorCode({ code: "TRANSLATION_ERROR", message: "HTTP 429" })).toBe("HTTP_429");
    expect(errors.getErrorCode({ code: "ERROR", message: "Load failed" })).toBe("NETWORK_ERROR");
  });

  it("does not let a generic context fallback overwrite a specific error code", () => {
    const errors = loadErrors();
    expect(errors.normalizeError({ code: "HTTP_503", message: "upstream unavailable" }, {
      phase: "preferences",
      code: "STORAGE_ERROR",
    }).code).toBe("HTTP_503");
    expect(errors.normalizeError({ message: "storage rejected" }, {
      phase: "preferences",
      code: "STORAGE_ERROR",
    }).code).toBe("STORAGE_ERROR");
  });

  it("keeps the local title stable while preserving an upstream RFC title", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "HTTP_403",
      title: "Provider-specific title",
      detail: "caption access denied",
    }, { phase: "source" });

    expect(model.title).toBe("字幕源访问被拒绝");
    expect(model.details.find((item) => item.label === "上游错误标题").value).toBe("Provider-specific title");
  });

  it("redacts credential-shaped fields from structured diagnostic details", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "BACKEND_REQUEST_ERROR",
      message: "request failed",
      details: { api_key: "sk-secret", nested: { authorization: "Bearer secret" } },
    });

    expect(model.copyText).not.toContain("sk-secret");
    expect(model.copyText).toContain("[REDACTED]");
  });

  it("redacts sensitive key fields in structured diagnostics", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "BACKEND_REQUEST_ERROR",
      message: "request failed",
      details: { key: "plain-secret-value", bearer: "Bearer another-secret-value" },
    });

    expect(model.copyText).not.toContain("plain-secret-value");
    expect(model.copyText).not.toContain("another-secret-value");
  });

  it("formats normal debug logs with the same redaction rules as errors", () => {
    const errors = loadErrors();
    const log = errors.formatDebugLog([
      "request completed",
      { runId: "run-1", api_key: "sk-secret-value", endpoint: "https://example.test/captions?token=secret" },
    ]);

    expect(log).toContain("request completed");
    expect(log).toContain("run-1");
    expect(log).not.toContain("sk-secret-value");
    expect(log).not.toContain("token=secret");
  });

  it("distinguishes subtitle network/server failures from no-source discovery", () => {
    const errors = loadErrors();
    expect(errors.normalizeError({ code: "SUBTITLE_NETWORK_ERROR" }, { phase: "source" }).title)
      .toBe("无法连接字幕服务器");
    expect(errors.normalizeError({ code: "SUBTITLE_SERVER_ERROR", status: 503 }, { phase: "source" }).summary)
      .toContain("HTTP 503");
    expect(errors.normalizeError({ code: "JOB_FAILED_UNCLASSIFIED" }, { phase: "backend" }).title)
      .toContain("没有提供错误详情");
  });

  it("counts only timed-cue text lines, including numeric captions", () => {
    const errors = loadErrors();
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0

1
00:00:00.000 --> 00:00:01.000
123

NOTE this metadata is not provider input
ignored metadata
`;

    expect(errors.countTranslatableLines(vtt)).toBe(1);
  });

  it("keeps the nested root diagnosis while exposing the outer boundary", () => {
    const errors = loadErrors();
    const model = errors.normalizeError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "local adapter failed",
      details: {
        cause: { code: "HTTP_429", status: 429, message: "rate limited" },
      },
    }, { phase: "backend" });

    expect(model.code).toBe("HTTP_429");
    expect(model.status).toBe(500);
    expect(model.upstreamStatus).toBe(429);
    expect(model.boundaryCode).toBe("INTERNAL_ERROR");
    expect(model.summary).toContain("HTTP 429");
    expect(errors.serializeError(model).boundary_code).toBe("INTERNAL_ERROR");
  });
});
