import { beforeEach, describe, expect, it } from "vitest";
import { evalModule, makeVttNs } from "../helpers/load-module.js";

function makeVtt(cues) {
  const blocks = cues.map((cue, index) => {
    const start = Number(cue.start ?? index);
    const end = Number(cue.end ?? start + 1);
    const time = cue.time || `${timestamp(start)} --> ${timestamp(end)}`;
    return [cue.id || String(index + 1), time, cue.text].join("\n");
  });
  return ["WEBVTT", "", ...blocks].join("\n\n");
}

function timestamp(seconds) {
  const ms = Math.round(Number(seconds) * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const wholeSeconds = Math.floor((ms % 60000) / 1000);
  const remainder = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(remainder).padStart(3, "0")}`;
}

describe("sentence merge", () => {
  let merge;
  let vtt;

  beforeEach(() => {
    window.Echo360Translator = makeVttNs();
    evalModule("vtt.js");
    evalModule("sentence_merge.js");
    merge = window.Echo360Translator.sentenceMerge;
    vtt = window.Echo360Translator.vtt;
  });

  it("groups contiguous whole cues and keeps source text while flattening grouped VTT lines", () => {
    const source = makeVtt([
      { start: 0, end: 1, text: "The first" },
      { start: 1, end: 2, text: "line continues." },
      { start: 2, end: 3, text: "Next cue" },
    ]);
    const plan = merge.build(source);

    expect(plan.groups).toMatchObject([
      {
        sourceIndices: [0, 1],
        text: "The first line continues.",
        fragments: [
          { sourceIndex: 0, text: "The first" },
          { sourceIndex: 1, text: "line continues." },
        ],
        startMs: 0,
        endMs: 2000,
      },
      { sourceIndices: [2], text: "Next cue", fragments: [{ sourceIndex: 2, text: "Next cue" }], startMs: 2000, endMs: 3000 },
    ]);
    expect(vtt.parseVttCues(plan.vtt).map((cue) => cue.text)).toEqual([
      "The first line continues.",
      "Next cue",
    ]);
  });

  it("separates sentences inside a cue and carries only the unfinished sentence forward", () => {
    const plan = merge.build(makeVtt([
      { start: 0, end: 1, text: "First sentence. Second sentence" },
      { start: 1, end: 2, text: "continues here" },
    ]));
    expect(plan.groups.map(group => group.text)).toEqual(["First sentence.", "Second sentence continues here"]);
    expect(plan.groups.map(group => group.sourceIndices)).toEqual([[0], [0, 1]]);
  });

  it("recognizes sentence punctuation with quote awareness and ellipses", () => {
    const source = makeVtt([
      { start: 0, end: 1, text: "Really?\"" },
      { start: 1, end: 2, text: "Yes" },
      { start: 2, end: 3, text: "Wait..." },
      { start: 3, end: 4, text: "What next" },
    ]);
    expect(merge.build(source).groups.map((group) => group.sourceIndices)).toEqual([[0], [1, 2], [3]]);
  });

  it("does not treat abbreviations, initials, decimals, or URL hosts as sentence ends", () => {
    const source = makeVtt([
      { start: 0, end: 1, text: "Dr." },
      { start: 1, end: 2, text: "Smith is here" },
      { start: 2, end: 3, text: "Use 3.14" },
      { start: 3, end: 4, text: "at https://example.test" },
      { start: 4, end: 5, text: "today" },
    ]);
    expect(merge.build(source).groups.map((group) => group.sourceIndices)).toEqual([[0, 1, 2, 3, 4]]);
  });

  it("hard-stops speaker changes, dialogue turns, standalone non-speech, and long gaps", () => {
    const source = makeVtt([
      { start: 0, end: 1, text: "<v Alice>Hello" },
      { start: 1, end: 2, text: "<v Bob>Hi" },
      { start: 2, end: 3, text: "- First" },
      { start: 3, end: 4, text: "- Second" },
      { start: 4, end: 5, text: "[music]" },
      { start: 5, end: 6, text: "spoken" },
      { start: 8, end: 9, text: "after a gap" },
    ]);
    expect(merge.build(source).groups.map((group) => group.sourceIndices)).toEqual([
      [0], [1], [2], [3], [4], [5], [6],
    ]);
  });

  it("keeps overlaps, nonmonotonic cues, and invalid timing blocks isolated", () => {
    const source = makeVtt([
      { start: 0, end: 2, text: "first" },
      { start: 1.5, end: 3, text: "overlap" },
      { start: 1, end: 2, text: "backwards" },
      { time: "00:00:bad.000 --> 00:00:04.000", text: "invalid" },
      { start: 4, end: 5, text: "after invalid" },
    ]);
    const plan = merge.build(source);
    expect(plan.groups.map((group) => group.sourceIndices)).toEqual([[0], [1], [2], [3], [4]]);
  });

  it("honors cue, duration, and character caps while admitting a single oversized cue", () => {
    const eight = makeVtt(Array.from({ length: 9 }, (_, index) => ({
      start: index,
      end: index + 1,
      text: "x",
    })));
    expect(merge.build(eight).groups.map((group) => group.sourceIndices)).toEqual([
      [0, 1, 2, 3, 4, 5], [6, 7, 8],
    ]);

    const longDuration = merge.build(makeVtt([
      { start: 0, end: 1, text: "a" },
      { start: 1, end: 31, text: "b" },
    ]));
    expect(longDuration.groups.map((group) => group.sourceIndices)).toEqual([[0], [1]]);

    const oversized = makeVtt([{ start: 0, end: 1, text: "x".repeat(1001) }]);
    expect(merge.build(oversized).groups[0].text).toHaveLength(1001);
  });

  it("projects one translated group onto every original cue without dropping repetitions", () => {
    const original = makeVtt([
      { start: 0, end: 1, text: "one" },
      { start: 1, end: 2, text: "two" },
      { start: 2, end: 3, text: "three" },
    ]);
    const plan = merge.build(original);
    const translated = makeVtt([{ start: 0, end: 3, text: "一二三" }]);
    const projected = merge.project(original, translated, plan);
    expect(vtt.parseVttCues(projected.originalVtt).map((cue) => cue.text)).toEqual(["one", "two", "three"]);
    expect(vtt.parseVttCues(projected.translatedVtt).map((cue) => cue.text)).toEqual(["一二三", "一二三", "一二三"]);
  });

  it("aligns project mappings by exact group timings when a middle translation is missing", () => {
    const original = makeVtt([
      { start: 0, end: 1, text: "first" },
      { start: 1, end: 2, text: "second" },
      { start: 2, end: 3, text: "third" },
      { start: 3, end: 4, text: "fourth" },
    ]);
    const plan = {
      groups: [
        { sourceIndices: [0], text: "first", startMs: 0, endMs: 1000 },
        { sourceIndices: [1], text: "second", startMs: 1000, endMs: 2000 },
        { sourceIndices: [2, 3], text: "third fourth", startMs: 2000, endMs: 4000 },
      ],
    };
    const translated = makeVtt([
      { start: 2, end: 4, text: "三四" },
      { start: 0, end: 1, text: "一" },
    ]);
    const projected = merge.project(original, translated, plan);
    expect(vtt.parseVttCues(projected.translatedVtt).map((cue) => cue.text)).toEqual(["一", "", "三四", "三四"]);
  });

  it("repeats grouped source text in the English projection when requested", () => {
    const original = makeVtt([
      { start: 0, end: 1, text: "first" },
      { start: 1, end: 2, text: "continues" },
    ]);
    const plan = merge.build(original);
    const projected = merge.project(original, makeVtt([{ start: 0, end: 2, text: "翻译" }]), plan, true);
    expect(vtt.parseVttCues(projected.originalVtt).map((cue) => cue.text)).toEqual(["first continues"]);
    expect(vtt.parseVttCues(projected.originalVtt)[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(vtt.parseVttCues(projected.sourceTranslatedVtt).map((cue) => cue.text)).toEqual(["翻译", "翻译"]);
  });

  it("builds a complete sparse preview in plan order and marks failed groups", () => {
    const plan = {
      groups: [
        { sourceIndices: [0], text: "one", startMs: 0, endMs: 1000 },
        { sourceIndices: [1], text: "two", startMs: 1000, endMs: 2000 },
        { sourceIndices: [2], text: "three", startMs: 2000, endMs: 3000 },
      ],
    };
    const partial = makeVtt([
      { start: 2, end: 3, text: "三" },
      { start: 0, end: 1, text: "one" },
    ]);
    const preview = merge.preview(partial, plan, {
      pendingLabel: "pending",
      failureLabel: "failed",
      failedCues: [2],
    });
    expect(vtt.parseVttCues(preview).map((cue) => cue.text)).toEqual(["pending", "failed", "三"]);
  });

  it("does not replace unchanged preview text when pending marking is disabled", () => {
    const plan = { groups: [{ sourceIndices: [0], text: "same", startMs: 0, endMs: 1000 }] };
    const preview = merge.preview(makeVtt([{ start: 0, end: 1, text: "same" }]), plan, {
      pendingLabel: "pending",
      markPending: false,
    });
    expect(vtt.parseVttCues(preview)[0].text).toBe("same");
  });

  it("remaps failed 1-based groups to sorted 1-based original cue numbers", () => {
    const plan = {
      groups: [
        { sourceIndices: [0, 1], text: "a b" },
        { sourceIndices: [2], text: "c" },
        { sourceIndices: [3, 4], text: "d e" },
      ],
    };
    expect(merge.remapFailedCues([3, 1, 3, 9], plan)).toEqual([1, 2, 4, 5]);
  });
});

it("preserves source wording and flattens only line breaks in service input", () => {
  window.Echo360Translator = makeVttNs();
  evalModule("vtt.js");
  evalModule("sentence_merge.js");
  const { sentenceMerge: merge, vtt } = window.Echo360Translator;
  const original = makeVtt([
    { text: "This is\nvery very" }, { text: "useful. The next" }, { text: "sentence ends here." },
  ]);
  const plan = merge.build(original);
  expect(plan.groups.map(group => group.text)).toEqual(["This is\nvery very useful.", "The next sentence ends here."]);
  expect(vtt.parseVttCues(plan.vtt)[0].text).toBe("This is very very useful.");
  expect(vtt.parseVttStats(plan.vtt).textLineCount).toBe(2);
  expect(merge.project(original, plan.vtt, plan).sourceOriginalVtt).toBe(original);
  expect(vtt.parseVttCues(merge.preview(plan.vtt, plan))[0].text).toBe("正在翻译中...");
});

it("bounds service input, respects continuation ellipses and trailing URL punctuation", () => {
  window.Echo360Translator = makeVttNs();
  evalModule("vtt.js");
  evalModule("sentence_merge.js");
  const merge = window.Echo360Translator.sentenceMerge;
  expect(merge.build(makeVtt([{ text: "I think..." }, { text: "because it works." }])).groups).toHaveLength(1);
  expect(merge.build(makeVtt([{ text: "Visit https://example.org." }, { text: "Next." }])).groups).toHaveLength(2);
  expect(merge.build(makeVtt([{ text: "x".repeat(600) }, { text: "y".repeat(500) }]), { maxChars: 1200 }).groups).toHaveLength(2);
  expect(merge.build(makeVtt([{ text: "first" }, { text: "second" }]), { maxChars: 8 }).groups).toHaveLength(2);
});

it("preserves timing settings and does not assign a duplicate-time sparse result to the wrong cue", () => {
  window.Echo360Translator = makeVttNs();
  evalModule("vtt.js");
  evalModule("sentence_merge.js");
  const { sentenceMerge: merge, vtt } = window.Echo360Translator;
  const original = makeVtt([
    { text: "First.", time: "00:00:00.000 --> 00:00:01.000 align:start" },
    { text: "Second.", start: 0, end: 1 },
  ]);
  const plan = merge.build(original);
  const sparse = makeVtt([{ id: "2", start: 0, end: 1, text: "第二句" }]);
  const preview = merge.preview(sparse, plan);
  expect(vtt.parseVttCues(preview).map(c => c.text)).toEqual(["正在翻译中...", "第二句"]);
  const projected = merge.project(original, preview, plan, true);
  expect(vtt.parseVttCues(projected.translatedVtt).map(c => c.text)).toEqual(["正在翻译中...", "第二句"]);
  expect(vtt.parseVttCues(projected.originalVtt)[0].time).toContain("align:start");
});

describe("sentence-first segmentation regressions", () => {
  let merge, vtt;
  const plain = text => text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  beforeEach(() => {
    window.Echo360Translator = makeVttNs();
    evalModule("vtt.js");
    evalModule("sentence_merge.js");
    ({ sentenceMerge: merge, vtt } = window.Echo360Translator);
  });

  it("splits a straddling cue's display window instead of stacking both complete sentences", () => {
    const original = makeVtt([{ text: "This is" }, { text: "a sentence. The next" }, { text: "one continues." }]);
    const plan = merge.build(original);
    expect(plan.groups.map(group => group.text)).toEqual(["This is a sentence.", "The next one continues."]);
    const result = makeVtt([{ start: 0, end: 2, text: "这是一个句子。" }, { start: 1, end: 3, text: "下一句继续。" }]);
    const projected = merge.project(original, result, plan, true);
    const translated = vtt.parseVttCues(projected.translatedVtt);
    const english = vtt.parseVttCues(projected.originalVtt);
    expect(translated.map(c => c.text)).toEqual(["这是一个句子。", "下一句继续。"]);
    expect(english.map(c => c.text)).toEqual(["This is a sentence.", "The next one continues."]);
    expect(translated.map(c => [c.startMs, c.endMs])).toEqual(english.map(c => [c.startMs, c.endMs]));
    expect(translated[0].startMs).toBe(0);
    expect(translated[1].endMs).toBe(3000);
    expect(translated[0].endMs).toBe(translated[1].startMs);
    expect(translated[0].endMs).toBeGreaterThan(1000);
    expect(translated[0].endMs).toBeLessThan(2000);
    expect(vtt.parseVttCues(projected.sourceTranslatedVtt).map(c => c.text)).toEqual([
      "这是一个句子。", "这是一个句子。\n下一句继续。", "下一句继续。",
    ]);
    const unmerged = merge.project(original, result, plan, false);
    expect(unmerged.sourceOriginalVtt).toBe(original);
    expect(vtt.parseVttCues(unmerged.originalVtt).map(c => c.text)).toEqual([
      "This is", "a sentence. The next", "a sentence. The next", "one continues.",
    ]);
    expect(merge.remapFailedCues([2], plan)).toEqual([2, 3]);
  });

  it("chains identical merged bilingual events across source cues and short ASR gaps", () => {
    const original = makeVtt([
      { start: 0, end: 1, text: "This is" },
      { start: 1.2, end: 2, text: "a sentence." },
      { start: 2, end: 3, text: "Next." },
    ]);
    const plan = merge.build(original);
    const result = makeVtt([
      { start: 0, end: 2, text: "这是一个句子。" },
      { start: 2, end: 3, text: "下一句。" },
    ]);
    const projected = merge.project(original, result, plan, true);
    const overlay = vtt.parseVttCues(projected.translatedVtt);
    expect(overlay.map(c => c.text)).toEqual(["这是一个句子。", "下一句。"]);
    expect(overlay.map(c => [c.startMs, c.endMs])).toEqual([[0, 2000], [2000, 3000]]);
    expect(vtt.parseVttCues(projected.originalVtt).map(c => c.text)).toEqual(["This is a sentence.", "Next."]);
    expect(vtt.parseVttCues(projected.sourceTranslatedVtt).map(c => c.text)).toEqual([
      "这是一个句子。", "这是一个句子。", "下一句。",
    ]);
    const unmerged = merge.project(original, result, plan, false);
    expect(unmerged.sourceOriginalVtt).toBe(original);
    expect(vtt.parseVttCues(unmerged.translatedVtt).map(c => c.text)).toEqual([
      "这是一个句子。", "这是一个句子。", "下一句。",
    ]);
  });

  it("keeps stacked display when a shared cue is too short to split readably", () => {
    const original = makeVtt([
      { start: 0, end: 0.3, text: "This is" },
      { start: 0.3, end: 0.6, text: "a sentence. The next" },
      { start: 0.6, end: 0.9, text: "one continues." },
    ]);
    const plan = merge.build(original);
    const result = makeVtt([{ start: 0, end: 0.6, text: "这是一个句子。" }, { start: 0.3, end: 0.9, text: "下一句继续。" }]);
    const projected = merge.project(original, result, plan, true);
    expect(vtt.parseVttCues(projected.translatedVtt).map(c => c.text)).toEqual([
      "这是一个句子。", "这是一个句子。\n下一句继续。", "下一句继续。",
    ]);
    expect(projected.originalVtt).toBe(projected.stackedOriginalVtt);
  });

  it("disambiguates multiple sentences sharing one timing range during sparse preview", () => {
    const original = makeVtt([{ start: 0, end: 3, text: "One. Two. Three." }]);
    const plan = merge.build(original);
    const sparse = makeVtt([{ id: "3", start: 0, end: 3, text: "第三句。" }]);
    const pending = merge.preview(sparse, plan, { failedCues: [2] });
    expect(vtt.parseVttCues(pending).map(c => c.text)).toEqual(["正在翻译中...", "[翻译失败]", "第三句。"]);
    const projected = merge.project(original, pending, plan);
    expect(vtt.parseVttCues(projected.sourceTranslatedVtt)[0].text)
      .toBe("正在翻译中...\n[翻译失败]\n第三句。");
    expect(vtt.parseVttCues(projected.translatedVtt).map(c => c.text)).toEqual([
      "正在翻译中...", "[翻译失败]", "第三句。",
    ]);
  });

  it("preserves every spoken character and balances styling across a sentence cut", () => {
    const original = makeVtt([{ text: '<v Speaker 0><i>One one. Two</i>' }, { text: '<v Speaker 0>continues.' }]);
    const plan = merge.build(original);
    expect(plan.groups.map(g => plain(g.text))).toEqual(["One one.", "Two continues."]);
    expect(plan.groups[0].text).toContain("</i>");
    expect(plan.groups[1].text).toContain("<i>Two</i>");
    expect(plain(plan.groups.map(g => g.text).join(" "))).toBe(plain(vtt.parseVttCues(original).map(c => c.text).join(" ")));
  });

  it("recognizes sentence-final abbreviations but preserves titles, initials and decimals", () => {
    const plan = merge.build(makeVtt([{ text: "Dr. J. Smith works in the U.S. We use 3.14, e.g. for this example. That's it." }]));
    expect(plan.groups.map(g => g.text)).toEqual([
      "Dr. J. Smith works in the U.S.", "We use 3.14, e.g. for this example.", "That's it.",
    ]);
    expect(merge.build(makeVtt([{ text: 'He asked "Why?" she replied quietly.' }])).groups).toHaveLength(1);
  });

  it("splits a long lecture run-on at an independent clause instead of a mid-phrase cue limit", () => {
    const texts = [
      "I'm going to spare around 15 minutes at the very",
      "end to basically giving you the opportunity to test your",
      "own understanding, OK, so we're going to ask you to",
      "pull out your mobile phone or whatever, you know, smartphone",
      "or whatever that might be that you got there and",
      "do the quiz at the very end of the lecture",
      "today, OK.",
    ];
    const plan = merge.build(makeVtt(texts.map(text => ({ text: `<v Speaker 0>${text}` }))));
    expect(plain(plan.groups[0].text)).toBe("I'm going to spare around 15 minutes at the very end to basically giving you the opportunity to test your own understanding, OK,");
    expect(plain(plan.groups[1].text)).toMatch(/^so we're going to ask you/);
    expect(plain(plan.groups.map(g => g.text).join(" "))).toBe(texts.join(" "));
  });

  it("keeps fronted conditions, noun lists and correlative clauses together", () => {
    for (const text of [
      "If the supplier cannot deliver all these products to the warehouse before Friday, we will need to ask another local supplier for help with the delivery next week.",
      "We need apples, oranges, bananas, fresh vegetables and other products for the many people who will come to this community event later in the week with their friends.",
      "We not only need to consider all the costs associated with our current inventory, but we also need to think about how these changes will affect the team next year.",
    ]) {
      expect(merge.build(makeVtt([{ text }])).groups).toHaveLength(1);
    }
  });

  it("does not use capitalization alone to sever a grammatical continuation", () => {
    expect(merge.build(makeVtt([{ text: "We need to consider" }, { text: "Inventory and Supply Chain Planning." }])).groups).toHaveLength(1);
  });

  it("looks back for a safer original boundary when a malformed sentence exceeds the caps", () => {
    const source = makeVtt([
      { text: "We can compare these products carefully before making any decision," },
      { text: "and consider all the different services that are available in the" },
      { text: "local market because customers need useful information about every option" },
      { text: "before choosing the product that they would like to buy today" },
      { text: "and taking it back to their home with them" },
    ]);
    const plan = merge.build(source, { maxChars: 155 });
    expect(plain(plan.groups[0].text)).toBe("We can compare these products carefully before making any decision,");
    expect(plain(plan.groups.map(g => g.text).join(" "))).toBe(plain(vtt.parseVttCues(source).map(c => c.text).join(" ")));
  });
});

it("sends plain spoken text to providers and still recognizes an unchanged tagged preview", () => {
  window.Echo360Translator = makeVttNs();
  evalModule("vtt.js");
  evalModule("sentence_merge.js");
  const { sentenceMerge: merge, vtt } = window.Echo360Translator;
  const source = makeVtt([{ text: "<v Speaker 1><i>When x < 5 and y > 3," }, { text: "<v Speaker 1>we compare the values." }]);
  const plan = merge.build(source);
  expect(vtt.parseVttCues(plan.vtt)[0].text).toBe("When x < 5 and y > 3, we compare the values.");
  expect(plan.groups[0].text).toContain("<v Speaker 1>");
  expect(vtt.parseVttCues(merge.preview(plan.vtt, plan))[0].text).toBe("正在翻译中...");
});
