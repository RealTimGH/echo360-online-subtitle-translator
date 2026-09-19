import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
