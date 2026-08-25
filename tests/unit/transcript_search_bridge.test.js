import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const original = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:04.000\nGoodbye`;
const translated = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n你好世界\n\n00:00:02.000 --> 00:00:04.000\n再见`;

function setup() {
  document.body.innerHTML = `
    <section id="transcripts-panel" role="tabpanel" aria-labelledby="transcripts-tab">
      <div id="search-transcripts" data-test-id="search-transcripts"><input id="search-transcripts_input" aria-label="Search"></div>
      <div class="transcript-list" role="grid"><div class="ReactVirtualized__Grid__innerScrollContainer" role="rowgroup">
        <div role="row"><dd data-test-component="Content" title="0.00 sec"><span role="button">Hello world</span></dd></div>
        <div role="row"><dd data-test-component="Content" title="2.00 sec"><span role="button">Goodbye</span></dd></div>
      </div></div>
    </section>`;
  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  evalModule("transcript_model.js");
  evalModule("transcript_panel_adapter.js");
  evalModule("transcript_search_bridge.js");
  const ns = window.Echo360Translator;
  const model = ns.transcriptModel.buildTranscriptModel({ originalVtt: original, translatedVtt: translated });
  ns.transcriptSearchBridge.setModel(model);
  document.querySelectorAll('[data-test-component="Content"]').forEach((cue, index) => {
    const own = document.createElement("span");
    own.setAttribute("data-echo360-transcript-translation", "1");
    own.setAttribute("data-echo360-cue-key", model.cues[index].key);
    own.setAttribute("data-echo360-translated-text", model.cues[index].translatedText);
    own.textContent = model.cues[index].translatedText;
    cue.appendChild(own);
  });
  ns.transcriptSearchBridge.setPanels([document.querySelector("#transcripts-panel")]);
  return { ns, input: document.querySelector("#search-transcripts_input") };
}

describe("transcript search bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("reads the native input passively and highlights only translation nodes", () => {
    const { ns, input } = setup();
    const prevent = vi.spyOn(Event.prototype, "preventDefault");
    const stop = vi.spyOn(Event.prototype, "stopPropagation");
    input.value = "世界";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    ns.transcriptSearchBridge.refresh(input.value);
    expect(prevent).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(input.value).toBe("世界");
    expect(ns.transcriptSearchBridge.getDebugState().translatedMatchCount).toBe(1);
    const panel = document.querySelector("#transcripts-panel");
    expect(panel.querySelectorAll("[data-echo360-transcript-search-hit=\"1\"]")).toHaveLength(1);
    expect(panel.querySelectorAll("span[role=button] mark")).toHaveLength(0);
  });

  it("renders a separate translated count and literal-searches regex punctuation", () => {
    const { ns, input } = setup();
    const panel = document.querySelector("#transcripts-panel");
    const cue = panel.querySelector('[data-test-component="Content"]');
    const own = cue.querySelector('[data-echo360-transcript-translation="1"]');
    ns.transcriptSearchBridge._state.model.cues[0].translatedText = "你好.*[]";
    own.setAttribute("data-echo360-translated-text", "你好.*[]");
    own.textContent = "你好.*[]";
    input.value = ".*[]";
    ns.transcriptSearchBridge.refresh(input.value);
    expect(ns.transcriptSearchBridge.getDebugState().translatedMatchCount).toBe(1);
    expect(panel.querySelectorAll('[data-echo360-transcript-search-hit="1"]')).toHaveLength(1);
    expect(panel.querySelector('[data-echo360-transcript-search-count="1"]').textContent).toContain("1 / 1");
    expect(panel.querySelectorAll("span[role=button] mark")).toHaveLength(0);
  });

  it("cycles previous/next without seeking the video", () => {
    const { ns, input } = setup();
    const seek = vi.fn();
    ns.transcriptSearchBridge._state.renderer = { scrollToCue: seek };
    input.value = "见";
    ns.transcriptSearchBridge.refresh(input.value);
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(0);
    ns.transcriptSearchBridge.navigate(1);
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(0);
    expect(seek).not.toHaveBeenCalled();
    input.value = "";
    ns.transcriptSearchBridge.refresh("");
    expect(document.querySelector('[data-echo360-transcript-search-bridge="1"]').hidden).toBe(true);
  });

  it("preserves the current occurrence across same-query refreshes", () => {
    const { ns } = setup();
    const model = ns.transcriptSearchBridge._state.model;
    model.cues[0].translatedText = "中文 中文";
    const firstOwn = document.querySelector('[data-echo360-transcript-translation="1"]');
    firstOwn.setAttribute("data-echo360-translated-text", "中文 中文");
    firstOwn.textContent = "中文 中文";
    ns.transcriptSearchBridge.refresh("中文");
    expect(ns.transcriptSearchBridge.getDebugState().translatedMatchCount).toBe(2);
    ns.transcriptSearchBridge.navigate(1);
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(1);
    ns.transcriptSearchBridge.refresh("中文");
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(1);
    model.cues[0].translatedText = "中文";
    firstOwn.setAttribute("data-echo360-translated-text", "中文");
    firstOwn.textContent = "中文";
    ns.transcriptSearchBridge.refresh("中文");
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(0);

    model.cues[0].translatedText = "foo foo";
    firstOwn.setAttribute("data-echo360-translated-text", "foo foo");
    firstOwn.textContent = "foo foo";
    ns.transcriptSearchBridge.refresh("foo");
    ns.transcriptSearchBridge.navigate(1);
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(1);
    model.cues[0].translatedText = "bar bar";
    firstOwn.setAttribute("data-echo360-translated-text", "bar bar");
    firstOwn.textContent = "bar bar";
    ns.transcriptSearchBridge.refresh("bar");
    expect(ns.transcriptSearchBridge.getDebugState().currentIndex).toBe(0);
  });

  it("filters gated model rows and removes its UI/listener when panels disappear", () => {
    const { ns, input } = setup();
    const root = document.querySelector("#transcripts-panel");
    const list = root.querySelector(".transcript-list");
    list.classList.add("ReactVirtualized__Grid", "ReactVirtualized__List");
    list.querySelector("[role=rowgroup]").classList.add("ReactVirtualized__Grid__innerScrollContainer");
    const model = {
      cues: Array.from({ length: 5 }, (_, index) => ({
        index,
        key: `gated-${index}`,
        translatedText: `中文${index}`,
        status: "mapped",
      })),
    };
    ns.transcriptSearchBridge.setModel(model);
    ns.transcriptSearchBridge.setPanels([root]);
    ns.transcriptSearchBridge.setPanelVisibleCount(root, 3);
    ns.transcriptSearchBridge.refresh("中文");
    expect(ns.transcriptSearchBridge.getDebugState().translatedMatchCount).toBe(3);
    expect(ns.transcriptSearchBridge._state.matches.every((match) => match.cue.index < 3)).toBe(true);
    ns.transcriptSearchBridge.setPanelVisibleCount(root, 5);
    expect(ns.transcriptSearchBridge.getDebugState().translatedMatchCount).toBe(5);

    expect(root.querySelector(`[data-echo360-transcript-search-bridge="1"]`)).not.toBeNull();
    ns.transcriptSearchBridge.setPanels([]);
    expect(root.querySelector(`[data-echo360-transcript-search-bridge="1"]`)).toBeNull();
    input.value = "不会更新";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(ns.transcriptSearchBridge.getDebugState().query).toBe("中文");
    ns.transcriptSearchBridge.clear();
    expect(ns.transcriptSearchBridge.getDebugState().panelCount).toBe(0);
  });

  it("counts a virtual scroll miss only after the renderer reports failure", async () => {
    const { ns } = setup();
    document.querySelectorAll('[data-echo360-transcript-translation="1"]').forEach((node) => node.remove());
    const renderer = { scrollToCue: vi.fn(async () => false) };
    ns.transcriptSearchBridge.start(renderer);
    ns.transcriptSearchBridge.refresh("世界");
    ns.transcriptSearchBridge.navigate(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.scrollToCue).toHaveBeenCalledOnce();
    expect(ns.transcriptSearchBridge.getDebugState().virtualizedTargetMisses).toBe(1);
  });
});
