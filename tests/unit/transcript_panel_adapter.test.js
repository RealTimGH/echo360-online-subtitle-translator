import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evalModule, makeFullNs, PROJECT_ROOT } from "../helpers/load-module.js";

function setup(html) {
  document.body.innerHTML = html;
  window.Echo360Translator = makeFullNs();
  evalModule("transcript_model.js");
  evalModule("transcript_panel_adapter.js");
  return window.Echo360Translator.transcriptPanelAdapter;
}

const panel = (inner = "") => `
  <section id="transcripts-panel" role="tabpanel" aria-labelledby="transcripts-tab">
    <div id="search-transcripts" data-test-id="search-transcripts">
      <input id="search-transcripts_input" aria-label="Search" type="text">
    </div>
    <div class="transcript-list ReactVirtualized__Grid ReactVirtualized__List" role="grid">
      <div class="ReactVirtualized__Grid__innerScrollContainer" role="rowgroup">${inner}</div>
    </div>
  </section>`;

const row = (top, title, spans, unit = "min") => `
  <div style="position:absolute;top:${top}px;height:50px" role="row">
    <dd data-test-component="Content" title="${title} ${unit}">${spans}</dd>
  </div>`;

describe("new-player-v1 transcript adapter", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("recognizes the verified panel, search, grid and rowgroup semantics", () => {
    const adapter = setup(panel(row(0, "0.00", '<span role="button">Hello </span><span role="button">world</span>', "sec")));
    const root = document.querySelector("#transcripts-panel");
    expect(adapter.findPanelRoots()).toEqual([root]);
    expect(adapter.findSearchInput(root).id).toBe("search-transcripts_input");
    expect(adapter.findScrollContainer(root).classList.contains("transcript-list")).toBe(true);
    expect(adapter.findRowGroup(root).getAttribute("role")).toBe("rowgroup");
    expect(adapter.findCueCandidates(root)).toHaveLength(1);
    expect(adapter.extractCueText(adapter.findCueCandidates(root)[0])).toBe("Hello world");
  });

  it("recognizes the real viewer structure when aria-label is omitted", () => {
    const html = readFileSync(resolve(PROJECT_ROOT, "tests/fixtures/transcript-panel/new-player-v1-no-aria.html"), "utf8");
    const adapter = setup(html);
    const root = document.querySelector("#transcripts-panel");
    const input = adapter.findSearchInput(root);
    expect(adapter.findPanelRoots()).toEqual([root]);
    expect(input?.id).toBe("search-transcripts_input");
    expect(input?.getAttribute("aria-label")).toBeNull();
    expect(adapter.findCueCandidates(root)).toHaveLength(2);
    expect(adapter.getPanelDescriptor(root)?.searchInput).toBe(input);
  });

  it("keeps search highlight split spans together and excludes extension text", () => {
    const adapter = setup(panel(row(0, "14.14", '<span role="button">Hello </span><mark>world</mark><span role="button">!</span>')));
    const candidate = adapter.findCueCandidates(document.querySelector("#transcripts-panel"))[0];
    const own = document.createElement("span");
    own.setAttribute("data-echo360-transcript-translation", "1");
    own.textContent = "不应进入原文";
    candidate.appendChild(own);
    expect(adapter.extractCueText(candidate)).toBe("Hello world!");
    expect(adapter.extractCueApproxStartMs(candidate)).toBe(848400);
    expect(adapter.findClickableCue(candidate)).toBe(candidate);
    expect(adapter.findTranslationMount(candidate)).toBe(candidate);
    expect(adapter.findRowWrapper(candidate, document.querySelector("#transcripts-panel")).style.top).toBe("0px");
  });

  it("keeps the translation beside the native role=button span and exposes it as the click target", () => {
    const adapter = setup(panel(row(0, "0.00", '<span role="button">A complete cue</span>', "sec")));
    const candidate = adapter.findCueCandidates(document.querySelector("#transcripts-panel"))[0];
    const clickable = candidate.querySelector('span[role="button"]');
    expect(adapter.findClickableCue(candidate)).toBe(clickable);
    expect(adapter.findTranslationMount(candidate)).toBe(candidate);
  });

  it("converts Echo's second/minute cue titles and rejects unverified units", () => {
    const adapter = setup(panel(row(0, "0.00", '<span role="button">zero</span>', "sec")));
    expect(adapter.parseCueTimeTitle("0.00 sec")).toBe(0);
    expect(adapter.parseCueTimeTitle("59.99 sec")).toBe(59990);
    expect(adapter.parseCueTimeTitle("1.00 min")).toBe(60000);
    expect(adapter.parseCueTimeTitle("1.00 mins")).toBeNull();
    expect(adapter.parseCueTimeTitle("1.00 hour")).toBeNull();
    expect(adapter.parseCueTimeTitle("60.00 sec")).toBe(60000);
    document.querySelector('[data-test-component="Content"]').setAttribute("title", "1.00 hour");
    expect(adapter.findCueCandidates(document.querySelector("#transcripts-panel"))).toHaveLength(0);
  });

  it("rejects editor/unknown/legacy structures instead of guessing selectors", () => {
    const adapter = setup(`<div contenteditable="true">${panel("<p>editable</p>")}</div>`);
    expect(adapter.findPanelRoots()).toEqual([]);
    document.body.innerHTML = `<div id="transcripts-panel"><input aria-label="Search"><div class="transcript-list"></div></div>`;
    expect(adapter.findPanelRoots()).toEqual([]);
    expect(adapter.supportsLegacy()).toBe(false);
  });
});
