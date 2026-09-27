import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

const ORIGINAL_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:04.000
Second line
`;

const TRANSLATED_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
你好世界

00:00:02.000 --> 00:00:04.000
第二行
`;

function setupEcho({
  nativeText = "Hello world",
  nativeWidth = 440,
  nativeLeft = 100,
  nativeHeight = 40,
  playerTop = 0,
  playerLeft = 0,
  playerWidth = 640,
  playerHeight = 360,
} = {}) {
  document.body.innerHTML = "";
  const player = document.createElement("div");
  player.id = "player";
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 1, writable: true, configurable: true });
  const nativeCaption = document.createElement("div");
  nativeCaption.textContent = nativeText;
  player.append(video, nativeCaption);
  document.body.appendChild(player);

  let playerBounds = {
    top: playerTop,
    bottom: playerTop + playerHeight,
    left: playerLeft,
    right: playerLeft + playerWidth,
    width: playerWidth,
    height: playerHeight,
  };
  vi.spyOn(player, "getBoundingClientRect").mockImplementation(() => ({ ...playerBounds }));
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
    top: 0, bottom: 360, left: 0, right: 640, width: 640, height: 360,
  });
  let nativeTop = 280;
  vi.spyOn(nativeCaption, "getBoundingClientRect").mockImplementation(() => ({
    top: nativeTop,
    bottom: nativeTop + nativeHeight,
    left: nativeLeft,
    right: nativeLeft + nativeWidth,
    width: nativeWidth,
    height: nativeHeight,
  }));

  window.Echo360Translator = makeFullNs({
    hostSupport: { isEcho360Document: () => true },
  });
  evalModule("vtt.js");
  evalModule("echo_caption_renderer.js");
  return {
    renderer: window.Echo360Translator.echoCaptionRenderer,
    player,
    video,
    nativeCaption,
    setNativeTop: (value) => { nativeTop = value; },
    setPlayerRect: (next) => {
      playerBounds = { ...playerBounds, ...next };
      if ("left" in next || "width" in next) playerBounds.right = playerBounds.left + playerBounds.width;
      if ("top" in next || "height" in next) playerBounds.bottom = playerBounds.top + playerBounds.height;
    },
  };
}

describe("echo_caption_renderer", () => {
  afterEach(() => window.Echo360Translator?.echoCaptionRenderer?.unmount());
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("places the Chinese line directly above Echo360's native English DOM caption", () => {
    const { renderer, player } = setupEcho();

    expect(renderer.mount({
      video: player.querySelector("video"),
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
      size: "medium",
    })).toBe(true);

    const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
    const line = overlay.querySelector('[data-echo360-echo-caption-line="translated"]');
    const stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(overlay.style.position).toBe("absolute");
    expect(line.textContent).toBe("你好世界");
    expect(stack.style.left).toBe("2%");
    expect(stack.style.width).toBe("96%");
    expect(Number.parseFloat(stack.style.top)).toBeLessThan(280);
    expect(stack.style.bottom).toBe("auto");
    expect(line.style.color).toBe("rgb(255, 255, 255)");
  });

  it("repositions the translation when the native caption moves while paused", async () => {
    const { renderer, player, video, setNativeTop } = setupEcho();
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    const initialTop = Number.parseFloat(
      player.querySelector('[data-echo360-echo-caption-stack="1"]').style.top
    );

    setNativeTop(230);
    player.dispatchEvent(new Event("pointermove", { bubbles: true }));
    await vi.waitFor(() => {
      const line = player.querySelector('[data-echo360-echo-caption-line="translated"]');
      const stack = line.closest('[data-echo360-echo-caption-stack="1"]');
      expect(Number.parseFloat(stack.style.top)).toBeLessThan(initialTop);
    }, { timeout: 500, interval: 20 });
  });

  it("bounds layout work during pointer and unrelated DOM storms, and stops when hidden", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, player, video } = setupEcho();
    try {
      renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
      await Promise.resolve();
      player.getBoundingClientRect.mockClear();
      player.dispatchEvent(new Event("pointermove"));
      now = 100;
      await vi.advanceTimersByTimeAsync(100);
      const readsPerRefresh = player.getBoundingClientRect.mock.calls.length;
      expect(readsPerRefresh).toBeGreaterThan(0);
      player.getBoundingClientRect.mockClear();
      const progress = document.createElement("div");
      player.append(progress);
      for (let i = 0; i < 50; i += 1) {
        player.dispatchEvent(new Event("pointermove"));
        progress.style.width = `${i}%`;
        now += 20;
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(player.getBoundingClientRect.mock.calls.length).toBeLessThanOrEqual(readsPerRefresh * 11);
      renderer.setVisible(false);
      player.getBoundingClientRect.mockClear();
      now += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(player.getBoundingClientRect).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
      vi.useRealTimers();
    }
  });

  it("switches cues at an exact shared boundary without creating a browser track", async () => {
    const { renderer, player, video } = setupEcho();
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    video.currentTime = 2;
    video.dispatchEvent(new Event("timeupdate"));

    // The old cue node is still mounted during Echo360's asynchronous cue
    // hand-off. Insert the matching second cue at a different viewport
    // position so the retained player-local anchor can be replaced when the
    // new native node finally appears.
    const nextNativeCaption = document.createElement("div");
    nextNativeCaption.textContent = "Second line";
    vi.spyOn(nextNativeCaption, "getBoundingClientRect").mockReturnValue({
      top: 210, bottom: 250, left: 60, right: 360, width: 300, height: 40,
    });
    player.querySelector("video").nextElementSibling.remove();
    player.appendChild(nextNativeCaption);

    await vi.waitFor(() => {
      expect(player.querySelector('[data-echo360-echo-caption-line="translated"]')?.textContent).toBe("第二行");
    }, { timeout: 700, interval: 20 });
    const stack = player.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(stack.dataset.echo360Placement).toBe("native-above");
    expect(stack.style.left).toBe("2%");
    expect(stack.style.width).toBe("96%");
    expect(Number.parseFloat(stack.style.top)).toBeCloseTo(204, 8);
    expect(video.querySelectorAll("track").length).toBe(0);
  });

  it("retains the native anchor after a confirmed cue is removed beyond the hand-off window", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { renderer, player, video, nativeCaption } = setupEcho();
      nativeCaption.style.fontFamily = "Echo Sans";
      nativeCaption.style.fontSize = "19px";
      nativeCaption.style.fontWeight = "600";
      nativeCaption.style.lineHeight = "1.25";
      nativeCaption.style.color = "rgb(14, 15, 16)";
      const captions = document.createElement("button");
      captions.setAttribute("aria-label", "Captions");
      captions.setAttribute("aria-pressed", "true");
      player.appendChild(captions);

      renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
      const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
      const initialStack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      const initialTop = initialStack.style.top;
      const initialLine = initialStack.querySelector('[data-echo360-echo-caption-line="translated"]');
      const initialStyle = {
        fontFamily: initialLine.style.fontFamily,
        fontSize: initialLine.style.fontSize,
        fontWeight: initialLine.style.fontWeight,
        lineHeight: initialLine.style.lineHeight,
        color: initialLine.style.color,
      };
      expect(initialStack.dataset.echo360Placement).toBe("native-above");

      nativeCaption.remove();
      await Promise.resolve();

      now = 500;
      renderer.ensureMounted();
      const retainedStack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(overlay.hidden).toBe(false);
      expect(retainedStack).toBe(initialStack);
      expect(retainedStack.dataset.echo360Placement).toBe("native-above");
      expect(retainedStack.style.top).toBe(initialTop);
      expect(retainedStack.querySelector('[data-echo360-echo-caption-line="translated"]').style)
        .toMatchObject(initialStyle);

      const lateNativeCaption = document.createElement("div");
      lateNativeCaption.textContent = "Hello world";
      vi.spyOn(lateNativeCaption, "getBoundingClientRect").mockReturnValue({
        top: 230, bottom: 270, left: 100, right: 540, width: 440, height: 40,
      });
      player.appendChild(lateNativeCaption);
      await Promise.resolve();
      renderer.ensureMounted();

      const stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(overlay.hidden).toBe(false);
      expect(stack.dataset.echo360Placement).toBe("native-above");
      expect(stack.style.bottom).toBe("auto");
      expect(Number.parseFloat(stack.style.top)).toBeCloseTo(224, 8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the latest cue at a normalized player-local anchor through page moves and resize", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { renderer, player, video, nativeCaption, setPlayerRect } = setupEcho();
      renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
      const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
      const initialStack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      const initialTop = initialStack.style.top;
      const initialLeft = Number.parseFloat(initialStack.style.left);
      const initialWidth = Number.parseFloat(initialStack.style.width);

      nativeCaption.remove();
      await Promise.resolve();
      now = 500;
      video.currentTime = 2;
      video.dispatchEvent(new Event("timeupdate"));
      renderer.ensureMounted();

      let stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(overlay.hidden).toBe(false);
      expect(stack.querySelector('[data-echo360-echo-caption-line="translated"]').textContent)
        .toBe("第二行");
      expect(stack.style.top).toBe(initialTop);
      expect(Number.parseFloat(stack.style.left)).toBe(initialLeft);
      expect(Number.parseFloat(stack.style.width)).toBe(initialWidth);

      // Moving the page changes viewport coordinates, but the cached anchor is
      // local to this mounted player and should stay at the same CSS position.
      setPlayerRect({ top: 140, left: 80 });
      now += 1;
      renderer.ensureMounted();
      stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(stack.style.top).toBe(initialTop);
      expect(Number.parseFloat(stack.style.left)).toBe(initialLeft);

      // Resize projects the normalized anchor into the new player-local box.
      setPlayerRect({ width: 1280, height: 720 });
      now += 1;
      renderer.ensureMounted();
      stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(Number.parseFloat(stack.style.left)).toBe(initialLeft);
      expect(Number.parseFloat(stack.style.width)).toBe(initialWidth);
      expect(Number.parseFloat(stack.style.top)).toBeCloseTo(554, 8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first translation visible while acquiring an initial native anchor", async () => {
    const { renderer, player, video, nativeCaption } = setupEcho();
    nativeCaption.remove();
    const captions = document.createElement("button");
    captions.setAttribute("aria-label", "Captions");
    captions.setAttribute("aria-pressed", "true");
    player.appendChild(captions);

    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
    let stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(overlay.hidden).toBe(false);
    expect(stack.dataset.echo360Placement).toBe("fallback");
    expect(stack.querySelector('[data-echo360-echo-caption-line="translated"]').textContent)
      .toBe("你好世界");

    const lateNativeCaption = document.createElement("div");
    lateNativeCaption.textContent = "Hello world";
    vi.spyOn(lateNativeCaption, "getBoundingClientRect").mockReturnValue({
      top: 230, bottom: 270, left: 90, right: 510, width: 420, height: 40,
    });
    player.appendChild(lateNativeCaption);
    await Promise.resolve();
    renderer.ensureMounted();

    stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(overlay.hidden).toBe(false);
    expect(stack.dataset.echo360Placement).toBe("native-above");
    expect(stack.style.left).toBe("2%");
    expect(stack.style.width).toBe("96%");
    expect(Number.parseFloat(stack.style.top)).toBeCloseTo(224, 8);
  });

  it("clears the retained anchor when CC is explicitly off and when remounted", async () => {
    const { renderer, player, video, nativeCaption } = setupEcho();
    const captions = document.createElement("button");
    captions.setAttribute("aria-label", "Captions");
    captions.setAttribute("aria-pressed", "true");
    player.appendChild(captions);

    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    nativeCaption.remove();
    await Promise.resolve();
    renderer.ensureMounted();
    let overlay = player.querySelector('[data-echo360-echo-caption="1"]');
    expect(overlay.querySelector('[data-echo360-echo-caption-stack="1"]')
      .dataset.echo360Placement).toBe("native-above");

    captions.setAttribute("aria-pressed", "false");
    await Promise.resolve();
    renderer.ensureMounted();
    let stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(stack.dataset.echo360Placement).toBe("fallback");
    expect(stack.style.top).toBe("auto");

    captions.setAttribute("aria-pressed", "true");
    await Promise.resolve();
    renderer.ensureMounted();
    stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(stack.dataset.echo360Placement).toBe("fallback");

    renderer.unmount();
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    overlay = player.querySelector('[data-echo360-echo-caption="1"]');
    stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(stack.dataset.echo360Placement).toBe("fallback");
  });

  it("hides the overlay when the video has no active cue", () => {
    const { renderer, player, video } = setupEcho();
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
    expect(overlay.hidden).toBe(false);

    video.currentTime = 4;
    video.dispatchEvent(new Event("timeupdate"));
    expect(overlay.hidden).toBe(true);
    expect(overlay.querySelector('[data-echo360-echo-caption-stack="1"]')).toBeNull();
  });

  it("rediscovers periodically only while no native anchor is available", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { renderer, player, video, nativeCaption } = setupEcho();
      nativeCaption.remove();
      const captions = document.createElement("button");
      captions.setAttribute("aria-label", "Captions");
      captions.setAttribute("aria-pressed", "true");
      player.appendChild(captions);

      renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
      const scanSpy = vi.spyOn(player, "querySelectorAll");
      scanSpy.mockClear();
      renderer.ensureMounted();
      expect(scanSpy.mock.calls.filter(([selector]) => selector === "*")).toHaveLength(0);

      now = 899;
      renderer.ensureMounted();
      expect(scanSpy.mock.calls.filter(([selector]) => selector === "*")).toHaveLength(0);

      now = 900;
      renderer.ensureMounted();
      expect(scanSpy.mock.calls.filter(([selector]) => selector === "*").length).toBeGreaterThan(0);

      const lateNativeCaption = document.createElement("div");
      lateNativeCaption.textContent = "Hello world";
      vi.spyOn(lateNativeCaption, "getBoundingClientRect").mockReturnValue({
        top: 250, bottom: 290, left: 70, right: 470, width: 400, height: 40,
      });
      player.appendChild(lateNativeCaption);
      await Promise.resolve();
      renderer.ensureMounted();
      scanSpy.mockClear();

      now = 1800;
      renderer.ensureMounted();
      expect(scanSpy.mock.calls.filter(([selector]) => selector === "*")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detects a late native cue in an open shadow root without the 900ms rediscovery pass", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { renderer, player, video, nativeCaption } = setupEcho();
      nativeCaption.remove();
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      player.appendChild(host);
      const captions = document.createElement("button");
      captions.setAttribute("aria-label", "Captions");
      captions.setAttribute("aria-pressed", "true");
      player.appendChild(captions);

      renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
      const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
      const initialStack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(overlay.hidden).toBe(false);
      expect(initialStack.dataset.echo360Placement).toBe("fallback");

      now = 10;
      const lateNativeCaption = document.createElement("div");
      lateNativeCaption.textContent = "Hello world";
      vi.spyOn(lateNativeCaption, "getBoundingClientRect").mockReturnValue({
        top: 280, bottom: 320, left: 100, right: 540, width: 440, height: 40,
      });
      shadow.appendChild(lateNativeCaption);
      await Promise.resolve();
      renderer.ensureMounted();

      const stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
      expect(overlay.hidden).toBe(false);
      expect(stack.dataset.echo360Placement).toBe("native-above");
      expect(stack.style.bottom).toBe("auto");
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors a short native cue above native text even when its measured width is under 80px", () => {
    const { renderer, player, video } = setupEcho({
      nativeText: "Hi",
      nativeWidth: 40,
      nativeLeft: 300,
    });
    const shortOriginalVtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHi\n`;
    const shortTranslatedVtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n嗨\n`;

    renderer.mount({ video, originalVtt: shortOriginalVtt, translatedVtt: shortTranslatedVtt });

    const stack = player.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(stack.dataset.echo360Placement).toBe("native-above");
    expect(Number.parseFloat(stack.style.top)).toBeLessThan(280);
    expect(stack.style.transform).toBe("translateY(-100%)");
    expect(stack.style.width).toBe("96%");
  });

  it("keeps a wrapped translated stack above native text as its height changes", () => {
    const { renderer, player, video } = setupEcho({ nativeWidth: 180 });
    const longTranslatedVtt = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n这是一段很长的翻译文本，用来覆盖多行换行后的定位行为\n`;
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: longTranslatedVtt });

    const stack = player.querySelector('[data-echo360-echo-caption-stack="1"]');
    const initialTop = stack.style.top;
    expect(stack.style.transform).toBe("translateY(-100%)");
    expect(Number.parseFloat(initialTop)).toBeLessThan(280);

    let wrappedHeight = 28;
    vi.spyOn(stack, "getBoundingClientRect").mockImplementation(() => ({
      top: Number.parseFloat(initialTop) - wrappedHeight,
      bottom: Number.parseFloat(initialTop),
      left: 100,
      right: 280,
      width: 180,
      height: wrappedHeight,
    }));
    wrappedHeight = 128;
    video.dispatchEvent(new Event("timeupdate"));

    expect(stack.style.top).toBe(initialTop);
    expect(stack.style.transform).toBe("translateY(-100%)");
    expect(Number.parseFloat(stack.style.top)).toBeLessThan(280);
  });

  it("does not reuse a native position when CC is explicitly off and keeps bilingual output", () => {
    const { renderer, player, video } = setupEcho();
    const captions = document.createElement("button");
    captions.setAttribute("aria-label", "Captions");
    captions.setAttribute("aria-pressed", "false");
    player.appendChild(captions);

    renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
      bilingual: true,
    });

    const stack = player.querySelector('[data-echo360-echo-caption-stack="1"]');
    expect(stack.dataset.echo360Placement).toBe("fallback");
    expect(stack.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("你好世界");
    expect(stack.querySelector('[data-echo360-echo-caption-line="original"]').textContent).toBe("Hello world");
  });

  it("reuses the static cue DOM and cached native anchor across stable renders", () => {
    const { renderer, player, video } = setupEcho();
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    const overlay = player.querySelector('[data-echo360-echo-caption="1"]');
    const stack = overlay.querySelector('[data-echo360-echo-caption-stack="1"]');
    const replaceChildren = vi.spyOn(overlay, "replaceChildren");
    const scanSpy = vi.spyOn(player, "querySelectorAll");
    scanSpy.mockClear();

    for (let i = 0; i < 100; i += 1) renderer.ensureMounted();

    expect(player.querySelector('[data-echo360-echo-caption-stack="1"]')).toBe(stack);
    expect(replaceChildren).not.toHaveBeenCalled();
    expect(scanSpy.mock.calls.filter(([selector]) => selector === "*")).toHaveLength(0);
  });

  it("skips stable video frames and cancels frame work while hidden", () => {
    const { renderer, player, video } = setupEcho();
    let callback;
    let handle = 0;
    video.requestVideoFrameCallback = vi.fn((fn) => { callback = fn; return ++handle; });
    video.cancelVideoFrameCallback = vi.fn();
    vi.spyOn(performance, "now").mockReturnValue(100);
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    const rect = vi.mocked(player.getBoundingClientRect);
    rect.mockClear();
    for (let index = 0; index < 100; index += 1) callback();
    expect(rect).not.toHaveBeenCalled();
    renderer.setVisible(false);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(handle);
    const stale = callback;
    const requests = video.requestVideoFrameCallback.mock.calls.length;
    stale();
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(requests);
    renderer.setVisible(true);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(requests + 1);
    expect(player.querySelector('[data-echo360-echo-caption="1"]').hidden).toBe(false);
  });
  it("uses presented frame timestamps without letting timeupdate advance the cue early", () => {
    const { renderer, player, video, nativeCaption } = setupEcho();
    nativeCaption.remove();
    let callback;
    let handle = 0;
    video.requestVideoFrameCallback = vi.fn((fn) => { callback = fn; return ++handle; });
    video.cancelVideoFrameCallback = vi.fn();
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    video.currentTime = 2.15;
    callback(0, { mediaTime: 1.99 });
    video.dispatchEvent(new Event("timeupdate"));
    renderer.ensureMounted();
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("你好世界");
    callback(0, { mediaTime: 2.01 });
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("第二行");
    video.currentTime = 1;
    video.dispatchEvent(new Event("seeked"));
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("你好世界");
  });

  it("does not stick to an older overlapping cue and accepts WebVTT timing settings", () => {
    const { renderer, player, video, nativeCaption } = setupEcho();
    nativeCaption.remove();
    const original = ORIGINAL_VTT.replace("00:00:02.000\nHello", "00:00:03.000 line:90%\nHello");
    renderer.mount({ video, originalVtt: original, translatedVtt: TRANSLATED_VTT });
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("你好世界");
    video.currentTime = 2.1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("第二行");
  });

  it("keeps text width and typography stable when a delayed narrow native cue arrives", async () => {
    const { renderer, player, video, nativeCaption } = setupEcho({ nativeWidth: 120 });
    nativeCaption.remove();
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    const stack = player.querySelector('[data-echo360-echo-caption-stack]');
    const before = [stack.style.width, stack.style.left, stack.firstChild.style.fontSize, stack.firstChild.style.fontFamily];
    nativeCaption.style.fontSize = "18px";
    nativeCaption.style.fontFamily = "serif";
    player.append(nativeCaption);
    await Promise.resolve();
    expect([stack.style.width, stack.style.left, stack.firstChild.style.fontSize, stack.firstChild.style.fontFamily]).toEqual(before);
    expect(stack.style.width).toBe("96%");
  });

  it("waits for visible English to change before advancing Chinese without per-frame layout", async () => {
    const { renderer, player, video, nativeCaption } = setupEcho();
    let callback, handle = 0;
    video.requestVideoFrameCallback = fn => { callback = fn; return ++handle; };
    video.cancelVideoFrameCallback = vi.fn();
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    vi.spyOn(performance, "now").mockReturnValue(100);
    renderer.mount({ video, originalVtt: ORIGINAL_VTT, translatedVtt: TRANSLATED_VTT });
    video.currentTime = 2.2;
    callback(100, { mediaTime: 2.1 });
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("你好世界");
    const reads = player.getBoundingClientRect.mock.calls.length;
    for (let i = 0; i < 60; i++) callback(100, { mediaTime: 2.1 });
    expect(player.getBoundingClientRect.mock.calls.length).toBe(reads);
    nativeCaption.textContent = "Second line";
    await Promise.resolve();
    expect(player.querySelector('[data-echo360-echo-caption-line="translated"]').textContent).toBe("第二行");
  });

});
