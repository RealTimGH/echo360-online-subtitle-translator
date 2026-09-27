import { afterEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

afterEach(() => vi.restoreAllMocks());

describe("direct provider to persistent partial resume", () => {
  it.each([true, false])("keeps prior successes after persisted resume (retry succeeds: %s)", async (retrySucceeds) => {
    window.Echo360Translator = makeFullNs();
    for (const file of ["vtt.js", "error_utils.js", "backend_client.js", "direct_translator.js", "translation_service.js"]) evalModule(file);
    const ns = window.Echo360Translator;
    let phase = "initial";
    const requests = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      const text = new URL(url).searchParams.get("q");
      requests.push(text);
      const translated = text === "Hello" ? "你好" : text === "World" && phase === "retry" && retrySucceeds ? "世界" : text;
      return new Response(JSON.stringify([[[translated, text]]]), { status: 200, headers: { "content-type": "application/json" } });
    });
    let jobPayload;
    ns.backendClient.createDirectTranslateJob = vi.fn(async payload => { jobPayload = payload; return { job_id: "resume-integration" }; });
    ns.backendClient.waitDirectJob = vi.fn(async (_id, options) => {
      const result = await window.Echo360DirectTranslator.translateVtt(jobPayload, options);
      return ns.backendClient.validateTranslationResult(result, "translation", {
        sourceVtt: jobPayload.vtt_text, target: "ZH", provider: "google-web",
      });
    });
    const source = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.000 --> 00:00:02.000\np.\n\n00:00:02.000 --> 00:00:03.000\nWorld\n";
    const payload = { vtt_text: source, provider: "google-web", target: "ZH", concurrency: 3, rps: 6, retries: 0, max_paragraphs: 1 };
    const first = await ns.translationService.translateWithConfig({}, "", payload);
    expect(first.metrics).toMatchObject({ total: 3, translated: 2, failed: 1 });
    expect(first.failed_items[0]).toMatchObject({ cue: 3, source_text: "World" });
    const checkpoint = JSON.parse(JSON.stringify(ns.translationService.buildTranslationCheckpoint(first, source)));
    phase = "retry";
    requests.length = 0;
    const final = await ns.translationService.translateWithConfig({}, "", payload, { resumeCheckpoint: checkpoint });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(text => text === "World")).toBe(true);
    expect(final.translated_vtt).toContain("你好");
    expect(final.translated_vtt).toContain("\np.\n");
    if (retrySucceeds) {
      expect(requests).toEqual(["World"]);
      expect(final.translated_vtt).toContain("世界");
      expect(final.metrics).toMatchObject({ total: 3, translated: 3, failed: 0 });
      expect(final.failed_items).toEqual([]);
      expect(final.warnings).toEqual([]);
    } else {
      expect(final.metrics).toMatchObject({ total: 3, translated: 2, failed: 1 });
      expect(final.failed_items).toHaveLength(1);
      expect(final.failed_items[0]).toMatchObject({ cue: 3, source_text: "World", code: "NO_TARGET_TRANSLATION" });
      expect(final.failed_cues).toEqual([3]);
    }
    expect(() => ns.backendClient.validateTranslationResult(final, "translation", { sourceVtt: source, target: "ZH", provider: "google-web" })).not.toThrow();
  });
});

function resumeFixture(texts, failedRows) {
  window.Echo360Translator = makeFullNs();
  for (const file of ["vtt.js", "error_utils.js", "backend_client.js", "translation_service.js"]) evalModule(file);
  const ns = window.Echo360Translator;
  const source = "WEBVTT\n\n" + texts.map((text, i) => `${ns.vtt.formatVttTime(i)} --> ${ns.vtt.formatVttTime(i + 1)}\n${text}\n`).join("\n");
  function resultFor(vtt, failures = []) {
    const entries = ns.errorUtils.timedCueTextEntries(vtt);
    const lines = vtt.split("\n");
    const failed = [];
    entries.forEach((entry, i) => {
      if (failures.includes(i)) failed.push({ ...entry, code: "HTTP_503", status: 503, message: "HTTP 503", source_text: entry.text });
      else lines[entry.line - 1] = `译文${i}`;
    });
    return { translated_vtt: lines.join("\n"), failed_items: failed.slice(0, 50), failed_lines: failed.map(item => item.line), failed_cues: [...new Set(failed.map(item => item.cue))],
      failure_codes: failed.length ? { HTTP_503: failed.length } : {}, warnings: [],
      metrics: { total: entries.length, processed: entries.length, translated: entries.length - failed.length, failed: failed.length,
        providerResults: entries.length - failed.length, targetResults: entries.length - failed.length } };
  }
  const initial = resultFor(source, failedRows);
  ns.backendClient.validateTranslationResult(initial, "translation", { sourceVtt: source, target: "ZH" });
  const checkpoint = ns.translationService.buildTranslationCheckpoint(initial, source);
  ns.backendClient.createDirectTranslateJob = vi.fn(async () => ({ job_id: "retry" }));
  ns.backendClient.waitDirectJob = vi.fn(async (_id, options) => resultFor(options.sourceVtt));
  const run = options => ns.translationService.translateWithConfig({}, "", { provider: "google-web", target: "ZH", vtt_text: source }, { resumeCheckpoint: checkpoint, ...options });
  return { ns, source, checkpoint, resultFor, run };
}

describe("resume boundary cases with the real result validator", () => {
  it("retries all 60 failures even though only 50 failure examples are stored", async () => {
    const fixture = resumeFixture(Array.from({ length: 61 }, (_, i) => `Source ${i}`), Array.from({ length: 60 }, (_, i) => i + 1));
    expect(fixture.checkpoint.result.failed_items).toHaveLength(50);
    const result = await fixture.run();
    const request = fixture.ns.backendClient.createDirectTranslateJob.mock.calls[0][0].vtt_text;
    expect(fixture.ns.vtt.parseVttStats(request).cueCount).toBe(60);
    expect(request).not.toContain("Source 0\n");
    expect(result.metrics).toMatchObject({ total: 61, translated: 61, failed: 0 });
    expect(result.failed_items).toEqual([]);
  });

  it("rejects a sampled checkpoint without exhaustive failure locations", () => {
    const fixture = resumeFixture(Array.from({ length: 61 }, (_, i) => `Source ${i}`), Array.from({ length: 60 }, (_, i) => i + 1));
    delete fixture.checkpoint.result.failed_cues;
    delete fixture.checkpoint.result.failed_lines;
    expect(fixture.ns.translationService.validateTranslationCheckpoint(fixture.checkpoint, fixture.source)).toBeNull();
    fixture.checkpoint.result.failed_cues = [2];
    expect(fixture.ns.translationService.validateTranslationCheckpoint(fixture.checkpoint, fixture.source)).toBeNull();
  });

  it("maps a failure on the second line of the retry cue back to the full source", async () => {
    const fixture = resumeFixture(["First", "Second\nThird", "Fourth"], [1, 2]);
    const onPartialVtt = vi.fn();
    fixture.ns.backendClient.waitDirectJob.mockImplementation(async (_id, options) => {
      const result = fixture.resultFor(options.sourceVtt, [1]);
      options.onPartialVtt(result.translated_vtt, { failed_items: result.failed_items, failed_cues: result.failed_cues });
      return result;
    });
    const result = await fixture.run({ onPartialVtt });
    const original = fixture.ns.errorUtils.timedCueTextEntries(fixture.source)[2];
    expect(result.failed_items[0]).toMatchObject({ cue: 2, line: original.line, source_text: "Third" });
    expect(onPartialVtt.mock.calls[0][1].failed_cues).toEqual([2]);
    expect(onPartialVtt.mock.calls[0][1].failed_items[0].line).toBe(original.line);
    expect(result.metrics).toMatchObject({ translated: 3, failed: 1 });
  });

  it("preserves successful multiline text on an unstructured network failure", async () => {
    const fixture = resumeFixture(["First", "Second\nThird"], [2]);
    fixture.ns.backendClient.waitDirectJob.mockRejectedValue(Object.assign(new Error("HTTP 503"), { code: "HTTP_503", status: 503 }));
    const result = await fixture.run();
    expect(result.translated_vtt).toBe(fixture.checkpoint.translatedVtt);
    expect(result.metrics).toMatchObject({ translated: 2, failed: 1 });
    expect(result.failed_items[0]).toMatchObject({ cue: 2, code: "HTTP_503", status: 503, source_text: "Third" });
  });

  it.each([{ failures: [0] }, { failures: [0, 1] }])("preserves previously successful multiline rows when retry failures are $failures", async ({ failures }) => {
    const fixture = resumeFixture(["First", "Second\nThird"], [2]);
    const onPartialVtt = vi.fn();
    const onProgress = vi.fn();
    fixture.ns.backendClient.waitDirectJob.mockImplementation(async (_id, options) => {
      const result = fixture.resultFor(options.sourceVtt, failures);
      options.onProgress(1, 2);
      options.onPartialVtt(result.translated_vtt, { current: 1, completed: 1, total: 2, failed_items: result.failed_items, failed_lines: result.failed_lines, failed_cues: result.failed_cues });
      return result;
    });
    const result = await fixture.run({ onPartialVtt, onProgress });
    const entries = fixture.ns.errorUtils.timedCueTextEntries(fixture.source);
    const oldGood = fixture.checkpoint.translatedVtt.split("\n")[entries[1].line - 1];
    expect(result.translated_vtt.split("\n")[entries[1].line - 1]).toBe(oldGood);
    expect(onPartialVtt.mock.calls[0][0].split("\n")[entries[1].line - 1]).toBe(oldGood);
    expect(onProgress.mock.calls[0].slice(0, 2)).toEqual([2, 3]);
    expect(onPartialVtt.mock.calls[0][1]).toMatchObject({ current: 2, total: 3 });
    expect(result.metrics).toMatchObject({ translated: failures.length === 1 ? 3 : 2, failed: failures.length - 1 });
    expect(result.failed_lines).toEqual(failures.length === 1 ? [] : [entries[2].line]);
    expect(onPartialVtt.mock.calls[0][1].failed_lines).toEqual(result.failed_lines);
    expect(onPartialVtt.mock.calls[0][1].failed_cues).toEqual(result.failed_cues);
  });

  it("preserves good rows beyond the 50-example diagnostic limit", async () => {
    const fixture = resumeFixture(Array.from({ length: 60 }, (_, i) => `Good ${i}\nBad ${i}`), Array.from({ length: 60 }, (_, i) => 2 * i + 1));
    expect(fixture.checkpoint).not.toBeNull();
    fixture.ns.backendClient.waitDirectJob.mockImplementation(async (_id, options) =>
      fixture.resultFor(options.sourceVtt, Array.from({ length: 120 }, (_, i) => i)));
    const result = await fixture.run();
    expect(result.translated_vtt).toBe(fixture.checkpoint.translatedVtt);
    expect(result.metrics).toMatchObject({ translated: 60, failed: 60 });
    expect(result.failed_lines).toHaveLength(60);
    expect(result.failed_items).toHaveLength(50);
    expect(result.failure_codes).toEqual({ HTTP_503: 60 });
    expect(fixture.ns.translationService.buildTranslationCheckpoint(result, fixture.source)).not.toBeNull();
  });

  it("rejects contradictory exhaustive failure row metadata", () => {
    const fixture = resumeFixture(["First", "Second\nThird"], [2]);
    fixture.checkpoint.result.failed_lines = [1];
    expect(fixture.ns.translationService.validateTranslationCheckpoint(fixture.checkpoint, fixture.source)).toBeNull();
  });

  it("uses terminal failure locations instead of stale nested progress mirrors", () => {
    const fixture = resumeFixture(["First", "Second"], [1]);
    fixture.checkpoint.result.metrics.failed_cues = [1, 2];
    fixture.checkpoint.result.metrics.failed_lines = [4, 7];
    expect(fixture.ns.translationService.validateTranslationCheckpoint(fixture.checkpoint, fixture.source)).not.toBeNull();
  });

  it("does not convert cancellation into a saved failure", async () => {
    const fixture = resumeFixture(["First", "Second"], [1]);
    fixture.ns.backendClient.waitDirectJob.mockRejectedValue(Object.assign(new Error("cancel"), { code: "TRANSLATION_CANCELLED" }));
    await expect(fixture.run()).rejects.toMatchObject({ code: "TRANSLATION_CANCELLED" });
  });
});

describe("mixed provider partial persistence with the real validator", () => {
  it("saves successful shards and submits only unresolved cues after reload", async () => {
    const fixture = resumeFixture(["Hello 1", "Hello 2", "Hello 3", "Hello 4"], []);
    const { ns, source, resultFor } = fixture;
    const jobs = new Map();
    let sequence = 0;
    let retrying = false;
    ns.backendClient.createDirectTranslateJob.mockImplementation(async payload => {
      const job_id = `mixed-integration-${++sequence}`;
      jobs.set(job_id, payload);
      return { job_id };
    });
    ns.backendClient.waitDirectJob.mockImplementation(async id => {
      const payload = jobs.get(id);
      // Every provider fails the same source cue. Other cues remain usable.
      const entries = ns.errorUtils.timedCueTextEntries(payload.vtt_text);
      const failures = retrying ? [] : entries.flatMap((entry, index) => entry.text === "Hello 4" ? [index] : []);
      const result = resultFor(payload.vtt_text, failures);
      if (failures.length === entries.length) {
        throw Object.assign(new Error("HTTP 503"), { code: "HTTP_503", status: 503,
          partial_vtt: result.translated_vtt, ...result });
      }
      return ns.backendClient.validateTranslationResult(result, "translation", {
        sourceVtt: payload.vtt_text, target: "ZH", provider: payload.provider,
      });
    });
    const providers = [{ provider: "google-web", weight: 50, enabled: true }, { provider: "deepl", weight: 50, enabled: true }];
    const config = { provider: "mixed", mixedProviders: providers };
    const payload = { provider: "mixed", mixed_providers: providers, vtt_text: source, target: "ZH" };
    const first = await ns.translationService.translateWithConfig(config, "", payload);
    expect(first.metrics).toMatchObject({ total: 4, translated: 3, failed: 1 });
    expect(first.failed_cues).toEqual([4]);
    expect(first.failed_items[0]).toMatchObject({ cue: 4, source_text: "Hello 4" });
    const checkpoint = JSON.parse(JSON.stringify(ns.translationService.buildTranslationCheckpoint(first, source)));
    expect(checkpoint).not.toBeNull();
    retrying = true;
    ns.backendClient.createDirectTranslateJob.mockClear();
    const final = await ns.translationService.translateWithConfig(config, "", payload, { resumeCheckpoint: checkpoint });
    expect(final.metrics).toMatchObject({ total: 4, translated: 4, failed: 0 });
    expect(ns.backendClient.createDirectTranslateJob).toHaveBeenCalled();
    for (const [request] of ns.backendClient.createDirectTranslateJob.mock.calls) {
      expect(ns.errorUtils.timedCueTextEntries(request.vtt_text).map(entry => entry.text)).toEqual(["Hello 4"]);
    }
    const before = ns.errorUtils.timedCueTextEntries(first.translated_vtt).slice(0, 3).map(entry => entry.text);
    const after = ns.errorUtils.timedCueTextEntries(final.translated_vtt).slice(0, 3).map(entry => entry.text);
    expect(after).toEqual(before);
  });
});

function mixedFixture(texts, translateChild) {
  const fixture = resumeFixture(texts, []);
  const jobs = new Map();
  let sequence = 0;
  fixture.ns.backendClient.createDirectTranslateJob.mockImplementation(async payload => {
    const job_id = `mixed-case-${++sequence}`;
    jobs.set(job_id, payload);
    return { job_id };
  });
  fixture.ns.backendClient.waitDirectJob.mockImplementation(async (id, options) =>
    translateChild(jobs.get(id), fixture, options));
  const providers = [{ provider: "google-web", weight: 70, enabled: true }, { provider: "deepl", weight: 30, enabled: true }];
  fixture.runMixed = options => fixture.ns.translationService.translateWithConfig(
    { provider: "mixed", mixedProviders: providers }, "",
    { provider: "mixed", mixed_providers: providers, vtt_text: fixture.source, target: "ZH" }, options);
  return fixture;
}

describe("mixed terminal failure boundaries", () => {
  it("retains verified rows within the same cue across provider fallback", async () => {
    const fixture = mixedFixture(["First\nSecond"], (payload, { resultFor, ns }, options) => {
      const result = resultFor(payload.vtt_text, payload.provider === "google-web" ? [1] : [0]);
      options.onPartialVtt?.(result.translated_vtt, { current: 2, completed: 2, total: 2 });
      return ns.backendClient.validateTranslationResult(result, "translation", { sourceVtt: payload.vtt_text, target: "ZH" });
    });
    const onPartialVtt = vi.fn();
    const result = await fixture.runMixed({ onPartialVtt });
    expect(result.metrics).toMatchObject({ total: 2, translated: 2, failed: 0 });
    expect(fixture.ns.errorUtils.timedCueTextEntries(result.translated_vtt).map(entry => entry.text)).toEqual(["译文0", "译文1"]);
    // Once Google has completed its first row, even a fallback preview with
    // that row untranslated must keep the accepted translation visible.
    const previews = onPartialVtt.mock.calls.map(([vtt]) => fixture.ns.errorUtils.timedCueTextEntries(vtt)[0].text);
    expect(previews.every(text => text === "译文0")).toBe(true);
  });

  it("keeps exhaustive failure coordinates when every mixed route fails", async () => {
    const fixture = mixedFixture(Array.from({ length: 60 }, (_, index) => `Source ${index}`), () => {
      throw Object.assign(new Error("HTTP 503"), { code: "HTTP_503", status: 503 });
    });
    let caught;
    try { await fixture.runMixed(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "MIXED_ALL_PROVIDERS_FAILED", metrics: { total: 60, processed: 60, translated: 0, failed: 60, failedCues: 60 } });
    expect(caught.failed_items).toHaveLength(50);
    expect(caught.failed_cues).toHaveLength(60);
    expect(caught.failed_lines).toEqual(fixture.ns.errorUtils.timedCueTextEntries(fixture.source).map(entry => entry.line));
    expect(caught.failed_items[0]).toMatchObject({ source_text: "Source 0", start_time: "00:00:00.000", end_time: "00:00:01.000" });
    expect(caught.partial_vtt).toBe(fixture.source);
  });

  it("propagates cancellation even when a sibling route completed", async () => {
    const fixture = mixedFixture(["First", "Second"], (payload, { resultFor }) => {
      if (payload.provider === "google-web") throw Object.assign(new Error("cancel"), { code: "TRANSLATION_CANCELLED" });
      return resultFor(payload.vtt_text);
    });
    await expect(fixture.runMixed()).rejects.toMatchObject({ code: "TRANSLATION_CANCELLED" });
  });
});
