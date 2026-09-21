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

function setupEcho() {
  document.body.innerHTML = "";
  const player = document.createElement("div");
  player.id = "player";
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 1, writable: true, configurable: true });
  const nativeCaption = document.createElement("div");
  nativeCaption.textContent = "Hello world";
  player.append(video, nativeCaption);
  document.body.appendChild(player);

  vi.spyOn(player, "getBoundingClientRect").mockReturnValue({
    top: 0, bottom: 360, left: 0, right: 640, width: 640, height: 360,
  });
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({
    top: 0, bottom: 360, left: 0, right: 640, width: 640, height: 360,
  });
  let nativeTop = 280;
  vi.spyOn(nativeCaption, "getBoundingClientRect").mockImplementation(() => ({
    top: nativeTop, bottom: nativeTop + 40, left: 100, right: 540, width: 440, height: 40,
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
    expect(line.textContent).toBe("你好世界");
    expect(stack.style.left).toBe("100px");
    expect(stack.style.width).toBe("440px");
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

    await vi.waitFor(() => {
      expect(player.querySelector('[data-echo360-echo-caption-line="translated"]')?.textContent).toBe("第二行");
    }, { timeout: 700, interval: 20 });
    expect(video.querySelectorAll("track").length).toBe(0);
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
});
