import { beforeEach, describe, expect, it } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const original = `WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nHello world\n\n2\n00:00:02.100 --> 00:00:04.000\nOkay.\n\n3\n00:00:05.000 --> 00:00:07.000\n< v Speaker >This is a test\n`;

function translated(texts, times = [
  [0, 2000], [2100, 4000], [5000, 7000],
]) {
  const lines = ["WEBVTT", ""];
  texts.forEach((text, index) => {
    const [start, end] = times[index];
    const fmt = (ms) => {
      const sec = Math.floor(ms / 1000);
      return `00:00:${String(sec).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
    };
    lines.push(String(index + 1), `${fmt(start)} --> ${fmt(end)}`, text, "");
  });
  return lines.join("\n");
}

function setup() {
  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  evalModule("transcript_model.js");
  return window.Echo360Translator.transcriptModel;
}

describe("transcript model", () => {
  let model;
  beforeEach(() => { model = setup(); });

  it("keeps exact cue timing and maps same-shape VTT by index", () => {
    const built = model.buildTranscriptModel({
      originalVtt: original,
      translatedVtt: translated(["你好世界", "好的", "这是测试"]),
      sourceMeta: { mediaId: "media-1" },
      target: "ZH",
    });
    expect(built.cues).toHaveLength(3);
    expect(built.cues[0]).toMatchObject({ startMs: 0, endMs: 2000, status: "ready", translatedText: "你好世界" });
    expect(built.cues[2].key).toBe("5000:7000:2");
  });

  it("accepts timing jitter up to 250ms and rejects a larger jitter", () => {
    const within = model.buildTranscriptModel({
      originalVtt: original,
      translatedVtt: translated(["A", "B", "C"], [[100, 2050], [2200, 4100], [5000, 7000]]),
    });
    expect(within.cues.map((cue) => cue.status)).toEqual(["ready", "ready", "ready"]);

    const outside = model.buildTranscriptModel({
      originalVtt: original,
      translatedVtt: translated(["A", "B", "C"], [[251, 2251], [2100, 4000], [5000, 7000]]),
    });
    expect(outside.cues[0].status).toBe("unmapped");
  });

  it("uses unique interval matches when cue counts differ", () => {
    const partial = translated(["first", "second"], [[0, 2000], [5000, 7000]]);
    const built = model.buildTranscriptModel({ originalVtt: original, translatedVtt: partial });
    expect(built.cues[0].status).toBe("ready");
    expect(built.cues[1].status).toBe("unmapped");
    expect(built.cues[2].status).toBe("ready");
  });

  it("leaves globally ambiguous interval matches unmapped instead of consuming a cue greedily", () => {
    const source = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nfirst\n\n00:00:00.100 --> 00:00:02.100\nsecond`;
    const target = translated(["only one", "unused"], [[0, 2000], [10000, 12000]]);
    const built = model.buildTranscriptModel({ originalVtt: source, translatedVtt: target });
    expect(built.cues.map((cue) => cue.status)).toEqual(["unmapped", "unmapped"]);
  });

  it("does not use repeated English text as a unique key", () => {
    const repeated = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOkay.\n\n00:00:02.000 --> 00:00:03.000\nOkay.`;
    const translatedRepeated = translated(["第一处", "第二处"], [[0, 1000], [2000, 3000]]);
    const built = model.buildTranscriptModel({ originalVtt: repeated, translatedVtt: translatedRepeated });
    expect(built.cues.map((cue) => cue.translatedText)).toEqual(["第一处", "第二处"]);
  });

  it("marks source-equal partial output pending and explicit failure output failed", () => {
    const pending = model.buildTranscriptModel({ originalVtt: original, translatedVtt: translated(["Hello world", "Okay.", ""])});
    expect(pending.cues[0].status).toBe("pending");
    expect(pending.cues[0].translatedText).toBe("正在翻译中...");
    const failed = model.buildTranscriptModel({ originalVtt: original, translatedVtt: translated(["[翻译失败]", "好的", "测试"])});
    expect(failed.cues[0]).toMatchObject({ status: "failed", translatedText: "[翻译失败]" });
    const failedPreview = model.buildTranscriptModel({
      originalVtt: original,
      translatedVtt: translated(["Hello world", "好的", "测试"]),
      pendingLabel: "[翻译失败]",
      failureLabel: "[翻译失败]",
      failurePreview: true,
    });
    expect(failedPreview.cues[0]).toMatchObject({ status: "failed", translatedText: "[翻译失败]" });
  });

  it("normalizes NFKC, NBSP and case, and returns literal occurrences", () => {
    expect(model.normalizeSearchText("ＡＢＣ\u00a0测试")).toBe("abc 测试");
    expect(model.findOccurrences("A.*[x] A.*[x]", "a.*[x]")).toEqual([
      { start: 0, end: 6 }, { start: 7, end: 13 },
    ]);
    const built = model.buildTranscriptModel({ originalVtt: original, translatedVtt: translated(["机器学习机器学习", "好的", "测试"]) });
    expect(model.searchTranslations(built, "机器学习").length).toBe(2);
  });
});
