import { beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const original = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:04.000\nGoodbye`;
const translated = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n你好世界\n\n00:00:02.000 --> 00:00:04.000\n再见`;

function fixture(virtualized = false) {
  document.body.innerHTML = `
    <section id="transcripts-panel" role="tabpanel" aria-labelledby="transcripts-tab">
      <div id="search-transcripts" data-test-id="search-transcripts"><input id="search-transcripts_input" aria-label="Search"></div>
      <div class="transcript-list${virtualized ? " ReactVirtualized__Grid ReactVirtualized__List" : ""}" role="grid"><div class="${virtualized ? "ReactVirtualized__Grid__innerScrollContainer " : ""}"role="rowgroup">
        <div role="row"><dd data-test-component="Content" title="0.00 sec"><span role="button">Hello world</span></dd></div>
        <div role="row"><dd data-test-component="Content" title="2.00 sec"><span role="button">Goodbye</span></dd></div>
      </div></div>
    </section>`;
}

function setup({ virtualized = false } = {}) {
  fixture(virtualized);
  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  evalModule("transcript_model.js");
  evalModule("transcript_panel_adapter.js");
  evalModule("transcript_search_bridge.js");
  evalModule("transcript_panel_renderer.js");
  const ns = window.Echo360Translator;
  const model = ns.transcriptModel.buildTranscriptModel({ originalVtt: original, translatedVtt: translated });
  ns.transcriptPanelRenderer.start();
  ns.transcriptPanelRenderer.setTranslation(model);
  return { ns, model, root: document.querySelector("#transcripts-panel") };
}

describe("transcript panel renderer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("injects one safe translation node per mapped cue and is idempotent", async () => {
    const { ns, root } = setup();
    await ns.transcriptPanelRenderer.flush();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    expect(root.querySelector('[data-echo360-transcript-translation="1"]').textContent).toBe("你好世界");
    await ns.transcriptPanelRenderer.flush();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    expect(ns.transcriptPanelRenderer.getDebugState().decoratedCueRows).toBeGreaterThanOrEqual(2);
  });

  it("publishes panel discovery and model/layout diagnostics for field reports", async () => {
    const { ns } = setup();
    await ns.transcriptPanelRenderer.flush();
    const debug = ns.transcriptPanelRenderer.getDebugState();
    expect(debug).toMatchObject({
      modelCueCount: 2,
      rawPanelCount: 1,
      rawListCount: 1,
      rawSearchInputCount: 1,
      verifiedPanelCount: 1,
      panelCount: 1,
      discoveredCueRows: 2,
      decoratedCueRows: 2,
      layoutCapability: "unavailable",
    });
    const meta = document.querySelector('meta[name="echo360-translator-transcript-panel-debug"]');
    expect(meta).not.toBeNull();
    expect(JSON.parse(meta.getAttribute("content"))).toMatchObject({
      modelCueCount: 2,
      panelCount: 1,
      decoratedCueRows: 2,
    });
  });

  it("keeps HTML-like translation as text and native click bubbling intact", async () => {
    const { ns, model, root } = setup();
    model.cues[0].translatedText = "<img src=x onerror=alert(1)>";
    await ns.transcriptPanelRenderer.flush();
    const own = root.querySelector('[data-echo360-transcript-translation="1"]');
    expect(own.querySelector("img")).toBeNull();
    const click = vi.fn();
    const clickable = root.querySelector('[data-test-component="Content"] span[role="button"]');
    expect(own.parentElement).toBe(root.querySelector('[data-test-component="Content"]'));
    expect(clickable.textContent).toBe("Hello world");
    clickable.addEventListener("click", click);
    own.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(click).toHaveBeenCalledOnce();
  });

  it("recovers after React replaces cue content and after panel remove/reopen", async () => {
    const { ns, root } = setup();
    await ns.transcriptPanelRenderer.flush();
    const firstRow = root.querySelector('[data-test-component="Content"]');
    firstRow.innerHTML = "<span role=\"button\">Hello world</span>";
    await ns.transcriptPanelRenderer.flush();
    expect(firstRow.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(1);

    const parent = root.parentElement;
    root.remove();
    await ns.transcriptPanelRenderer.flush();
    const reopened = document.createElement("section");
    reopened.innerHTML = root.innerHTML;
    // Recreate the panel with the same verified structure (React creates a new
    // root; the in-memory model must survive that replacement).
    reopened.id = "transcripts-panel";
    reopened.setAttribute("role", "tabpanel");
    reopened.setAttribute("aria-labelledby", "transcripts-tab");
    parent.appendChild(reopened);
    await ns.transcriptPanelRenderer.flush();
    expect(reopened.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
  });

  it("repairs a translation removed by a React commit without requiring a manual flush", async () => {
    const { ns, root } = setup();
    await ns.transcriptPanelRenderer.flush();
    // Let the document-start scheduled flush settle before introducing the
    // simulated React removal; otherwise that already queued pass could mask
    // a broken removal observer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = root.querySelector('[data-echo360-transcript-translation="1"]');
    expect(first).not.toBeNull();

    // React may remove an unknown child while reconciling the native cue.  In
    // that case the MutationObserver record contains only the extension node;
    // the renderer must still schedule a recovery pass.
    first.remove();
    await vi.waitFor(() => {
      expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    }, { timeout: 1500, interval: 20 });
  });

  it("repairs a removed translation after the virtualized layout handshake", async () => {
    const { ns, root } = setup({ virtualized: true });
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: true,
        capability: "echo-react-virtualized-v1",
        appliedRevision: data.revision,
        visibleRowCount: data.rowCount,
      } });
      window.dispatchEvent(event);
    });
    await ns.transcriptPanelRenderer.flush();
    expect(ns.transcriptPanelRenderer.getDebugState().layoutCapability).toBe("echo-react-virtualized-v1");

    root.querySelector('[data-echo360-transcript-translation="1"]').remove();
    await vi.waitFor(() => {
      expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    }, { timeout: 1500, interval: 20 });
  });

  it("keeps virtualized translations visible while row geometry settles", async () => {
    const { ns, root } = setup({ virtualized: true });
    const rows = [...root.querySelectorAll('[role="row"]')];
    let layoutCommitted = false;
    rows.forEach((row, index) => {
      row.style.position = "absolute";
      row.style.top = `${index === 0 ? 0 : 44}px`;
      row.style.height = "44px";
      row.getBoundingClientRect = () => {
        const top = index === 0 ? 0 : (layoutCommitted ? 68 : 44);
        const height = row.getAttribute("data-echo360-transcript-decorated-row") === "1" ? 68 : 44;
        return { top, bottom: top + height, left: 0, right: 320, width: 320, height };
      };
    });
    root.querySelectorAll('[data-test-component="Content"]').forEach((candidate) => {
      candidate.getBoundingClientRect = () => {
        const row = candidate.parentElement;
        const rect = row.getBoundingClientRect();
        return { ...rect, height: rect.height, bottom: rect.bottom };
      };
    });

    let setLayoutData = null;
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      const base = {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
      };
      if (data.action === "set-layout") {
        setLayoutData = data;
        // The bridge response arrives before React has committed the new
        // absolute row offsets.  Commit those offsets one probe later so the
        // first unsafe reveal must be rolled back synchronously.
        queueMicrotask(() => {
          Object.defineProperty(event, "data", { value: {
            ...base,
            ok: true,
            capability: "echo-react-virtualized-v1",
            appliedRevision: data.revision,
            visibleRowCount: data.rowCount,
          } });
          window.dispatchEvent(event);
          setTimeout(() => { layoutCommitted = true; }, 25);
        });
        return;
      }
      Object.defineProperty(event, "data", { value: {
        ...base,
        ok: true,
        capability: "echo-react-virtualized-v1",
        appliedRevision: data.revision,
        visibleRowCount: data.rowCount,
      } });
      window.dispatchEvent(event);
    });

    const run = ns.transcriptPanelRenderer.flush();
    await vi.waitFor(() => expect(setLayoutData).not.toBeNull(), { timeout: 500 });
    const pending = root.querySelectorAll('[data-echo360-transcript-layout-pending="1"]');
    expect(pending.length === 0 || pending.length === 2).toBe(true);
    expect([...root.querySelectorAll('[data-echo360-transcript-translation="1"]')]
      .every((node) => window.getComputedStyle(node).display !== "none")).toBe(true);
    if (pending.length === 2) expect(rows[0].hasAttribute("data-echo360-transcript-decorated-row")).toBe(false);
    await run;
    expect(layoutCommitted).toBe(true);
    expect(root.querySelectorAll('[data-echo360-transcript-layout-pending="1"]')).toHaveLength(0);
    expect(rows[0].getAttribute("data-echo360-transcript-decorated-row")).toBe("1");
  });

  it("retries a transient set-layout bridge failure before clearing translations", async () => {
    const { ns, root } = setup({ virtualized: true });
    let setLayoutAttempts = 0;
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const transientFailure = data.action === "set-layout" && setLayoutAttempts++ === 0;
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: transientFailure ? {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: false,
        error: "state-not-found",
        transient: true,
      } : {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: true,
        capability: "echo-react-virtualized-v1",
        appliedRevision: data.revision,
        visibleRowCount: data.rowCount,
      } });
      window.dispatchEvent(event);
    });
    await ns.transcriptPanelRenderer.flush();
    expect(setLayoutAttempts).toBeGreaterThanOrEqual(2);
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    expect(ns.transcriptPanelRenderer.getDebugState()).toMatchObject({
      layoutCapability: "echo-react-virtualized-v1",
      lastBridgeResult: "echo-react-virtualized-v1",
    });
  });

  it("keeps translations and the ready layout when a set-layout response times out", async () => {
    const { ns, root } = setup({ virtualized: true });
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: data.action === "capabilities"
        ? {
          source: "echo360-translator-transcript-page",
          version: 1,
          requestId: data.requestId,
          panelToken: data.panelToken,
          ok: true,
          capability: "echo-react-virtualized-v1",
          appliedRevision: data.revision,
          visibleRowCount: data.rowCount,
        }
        : {
          source: "echo360-translator-transcript-page",
          version: 1,
          requestId: data.requestId,
          panelToken: data.panelToken,
          ok: false,
          error: "timeout",
        } });
      queueMicrotask(() => window.dispatchEvent(event));
    });
    await ns.transcriptPanelRenderer.flush();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    expect(ns.transcriptPanelRenderer.getDebugState()).toMatchObject({
      layoutCapability: "echo-react-virtualized-v1",
      layoutBridgeFailures: 1,
      lastLayoutFailure: "timeout",
    });
    expect([...ns.transcriptPanelRenderer._state.panelStates.values()][0].layout).toBe("ready");
  });

  it("does not resend an unchanged virtualized layout on every observer flush", async () => {
    const { ns } = setup({ virtualized: true });
    const post = vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: true,
        capability: "echo-react-virtualized-v1",
        appliedRevision: data.revision,
        visibleRowCount: data.rowCount,
      } });
      queueMicrotask(() => window.dispatchEvent(event));
    });
    await ns.transcriptPanelRenderer.flush();
    const first = post.mock.calls.filter(([data]) => data.action === "set-layout").length;
    await ns.transcriptPanelRenderer.flush();
    await ns.transcriptPanelRenderer.flush();
    const repeated = post.mock.calls.filter(([data]) => data.action === "set-layout").length;
    expect(first).toBe(1);
    expect(repeated).toBe(first);
  });

  it("coalesces concurrent virtualized flushes without misclassifying revisions", async () => {
    const { ns, root } = setup({ virtualized: true });
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: true,
        capability: "echo-react-virtualized-v1",
        appliedRevision: data.revision,
        visibleRowCount: data.rowCount,
      } });
      // A real postMessage is asynchronous.  Four observer/model signals can
      // therefore arrive while the first layout request is waiting; the
      // renderer must serialize those passes instead of sharing a mutable
      // panel revision between them.
      queueMicrotask(() => window.dispatchEvent(event));
    });

    await Promise.all(Array.from({ length: 4 }, () => ns.transcriptPanelRenderer.flush()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const debug = ns.transcriptPanelRenderer.getDebugState();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    expect(debug.layoutCapability).toBe("echo-react-virtualized-v1");
    expect(debug.lastLayoutFailure).not.toBe("set-layout timeout");
    expect(debug.layoutBridgeFailures).toBe(0);
  });

  it("clears only extension nodes and leaves native cues untouched", async () => {
    const { ns, root } = setup();
    await ns.transcriptPanelRenderer.flush();
    ns.transcriptPanelRenderer.clear();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(0);
    expect(root.querySelectorAll('span[role="button"]')).toHaveLength(2);
  });

  it("caches hidden measurements for the same model and content width", () => {
    const { ns, model, root } = setup();
    const panelState = {
      root,
      visibleRowCount: model.cues.length,
      layoutCache: null,
    };
    const candidates = ns.transcriptPanelAdapter.findCueCandidates(root);
    const createElement = vi.spyOn(document, "createElement");
    ns.transcriptPanelRenderer._measureAllModelExtras(panelState, candidates, []);
    const created = createElement.mock.calls.length;
    ns.transcriptPanelRenderer._measureAllModelExtras(panelState, candidates, []);
    expect(panelState.layoutCache.measuredCount).toBe(model.cues.length);
    expect(createElement.mock.calls.length).toBe(created);
  });

  it("uses a conservative wide-glyph estimate for wrapped Chinese cues", () => {
    const { ns, model, root } = setup();
    model.cues[0].translatedText = "中文".repeat(20);
    const panelState = {
      root,
      visibleRowCount: model.cues.length,
      layoutCache: null,
    };
    const candidates = ns.transcriptPanelAdapter.findCueCandidates(root);
    const extras = ns.transcriptPanelRenderer._measureAllModelExtras(panelState, candidates, []);
    expect(extras.find(([index]) => index === 0)?.[1]).toBeGreaterThanOrEqual(48);
  });

  it("does not decorate a gated row outside MAIN visibleRowCount", async () => {
    const { ns, root } = setup({ virtualized: true });
    const gateRow = document.createElement("div");
    gateRow.setAttribute("role", "row");
    gateRow.setAttribute("style", "position:absolute;top:100px;height:50px");
    gateRow.innerHTML = '<dd data-test-component="Content" title="8.00 sec"><span role="button">Fifth</span></dd>';
    root.querySelector('[role="rowgroup"]').appendChild(gateRow);
    const originalFive = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:04.000\nGoodbye\n\n00:00:04.000 --> 00:00:06.000\nGate me\n\n00:00:06.000 --> 00:00:08.000\nFourth\n\n00:00:08.000 --> 00:00:10.000\nFifth`;
    const translatedFive = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n你好世界\n\n00:00:02.000 --> 00:00:04.000\n再见\n\n00:00:04.000 --> 00:00:06.000\n中文门\n\n00:00:06.000 --> 00:00:08.000\n第四\n\n00:00:08.000 --> 00:00:10.000\n第五`;
    const model = ns.transcriptModel.buildTranscriptModel({ originalVtt: originalFive, translatedVtt: translatedFive });
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: true,
        capability: "echo-react-virtualized-v1",
        appliedRevision: data.revision,
        visibleRowCount: data.rowCount <= 2 ? 2 : 3,
      } });
      window.dispatchEvent(event);
    });
    ns.transcriptPanelRenderer.setTranslation(model);
    await ns.transcriptPanelRenderer.flush();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(2);
    ns.transcriptSearchBridge.refresh("第五");
    expect(ns.transcriptSearchBridge.getDebugState().translatedMatchCount).toBe(0);
    const miss = await ns.transcriptPanelRenderer.scrollToCue(model.cues[2]);
    expect(miss).toBe(false);
    expect([...ns.transcriptPanelRenderer._state.panelStates.values()][0].layout).toBe("ready");
  });

  it("exposes a structured MAIN bridge failure when host rows exceed the model", async () => {
    const { ns, root } = setup({ virtualized: true });
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      const event = new Event("message");
      Object.defineProperty(event, "source", { value: window });
      Object.defineProperty(event, "data", { value: {
        source: "echo360-translator-transcript-page",
        version: 1,
        requestId: data.requestId,
        panelToken: data.panelToken,
        ok: false,
        error: "host-row-count-exceeds-model",
        modelRowCount: data.rowCount,
        hostRowCount: data.rowCount + 3,
      } });
      window.dispatchEvent(event);
    });
    await ns.transcriptPanelRenderer.flush();
    expect(root.querySelectorAll('[data-echo360-transcript-translation="1"]')).toHaveLength(0);
    expect(ns.transcriptPanelRenderer.getDebugState()).toMatchObject({
      panelCount: 1,
      modelCueCount: 2,
      layoutCapability: "unsupported",
      lastLayoutFailure: "host-row-count-exceeds-model",
      lastBridgeAction: "capabilities",
      lastBridgeResult: "host-row-count-exceeds-model",
    });
    const meta = document.querySelector('meta[name="echo360-translator-transcript-panel-debug"]');
    expect(JSON.parse(meta.getAttribute("content"))).toMatchObject({
      lastLayoutFailure: "host-row-count-exceeds-model",
      lastBridgeResult: "host-row-count-exceeds-model",
    });
  });
});
