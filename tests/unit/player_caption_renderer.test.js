import { beforeEach, describe, expect, it } from "vitest";
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

function setupPlayer() {
  document.body.innerHTML = "";
  const player = document.createElement("div");
  player.setAttribute("data-media-player", "");
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: 1, writable: true, configurable: true });
  const surface = document.createElement("div");
  surface.setAttribute("data-part", "captions");
  const nativeCaption = document.createElement("div");
  nativeCaption.textContent = "original caption";
  nativeCaption.style.display = "block";
  surface.appendChild(nativeCaption);
  player.append(video, surface);
  document.body.appendChild(player);

  window.Echo360Translator = makeFullNs();
  evalModule("vtt.js");
  evalModule("host_support.js");
  evalModule("player_caption_renderer.js");
  return { renderer: window.Echo360Translator.playerCaptionRenderer, video, surface, nativeCaption };
}

describe("player_caption_renderer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the cue matching currentTime into the Vidstack caption surface", () => {
    const { renderer, video, surface, nativeCaption } = setupPlayer();
    // This is the real failure mode: Vidstack hides its own caption surface
    // whenever the CC toggle is off. The extension overlay must not inherit
    // that hidden ancestor state.
    surface.hidden = true;

    expect(renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
      size: "medium",
    })).toBe(true);

    const overlay = surface.parentElement.querySelector(":scope > [data-echo360-instructure-caption=\"1\"]");
    expect(overlay).not.toBeNull();
    expect(overlay.hidden).toBe(false);
    expect(surface.hidden).toBe(true);
    expect(overlay.textContent).toBe("你好世界");
    expect(overlay.firstElementChild.style.color).toBe("rgb(255, 255, 255)");
    expect(surface.style.getPropertyValue("visibility")).toBe("hidden");

    video.currentTime = 3;
    video.dispatchEvent(new Event("timeupdate"));
    expect(overlay.textContent).toBe("第二行");
  });

  it("supports bilingual and reverse-order display without mutating caption text as HTML", () => {
    const { renderer, video, surface } = setupPlayer();

    expect(renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
      bilingual: true,
      reverseOrder: false,
    })).toBe(true);
    let lines = Array.from(surface.parentElement.querySelectorAll("[data-echo360-instructure-caption-line]"));
    expect(lines.map((line) => line.textContent)).toEqual(["你好世界", "Hello world"]);

    expect(renderer.update({
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
      bilingual: true,
      reverseOrder: true,
    })).toBe(true);
    lines = Array.from(surface.parentElement.querySelectorAll("[data-echo360-instructure-caption-line]"));
    expect(lines.map((line) => line.textContent)).toEqual(["Hello world", "你好世界"]);
    expect(surface.parentElement.querySelector("script")).toBeNull();
  });

  it("hides and restores the host caption surface when the extension overlay is removed", () => {
    const { renderer, video, surface, nativeCaption } = setupPlayer();

    renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
    });
    renderer.setVisible(false);
    const overlay = surface.parentElement.querySelector(":scope > [data-echo360-instructure-caption=\"1\"]");
    expect(overlay.hidden).toBe(true);
    expect(surface.style.getPropertyValue("visibility")).toBe("");

    renderer.unmount();
    expect(surface.parentElement.querySelector(":scope > [data-echo360-instructure-caption=\"1\"]")).toBeNull();
    expect(nativeCaption.style.display).toBe("block");
    expect(surface.style.getPropertyValue("visibility")).toBe("");
    expect(renderer.isMounted()).toBe(false);
  });

  it("mounts before Vidstack creates its optional native captions surface", () => {
    const { renderer, video, surface } = setupPlayer();
    surface.remove();

    expect(renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
    })).toBe(true);

    const overlay = video.parentElement.querySelector(":scope > [data-echo360-instructure-caption=\"1\"]");
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toBe("你好世界");
  });

  it("switches to the next cue at an exact shared boundary", () => {
    const { renderer, video, surface } = setupPlayer();
    renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
    });

    video.currentTime = 2;
    video.dispatchEvent(new Event("timeupdate"));

    const overlay = surface.parentElement.querySelector(":scope > [data-echo360-instructure-caption=\"1\"]");
    expect(overlay.textContent).toBe("第二行");
  });

  it("falls back to an earlier active cue after a shorter overlapping cue ends", () => {
    const original = `WEBVTT

00:00:00.000 --> 00:00:10.000
Long original

00:00:05.000 --> 00:00:06.000
Short original
`;
    const translated = `WEBVTT

00:00:00.000 --> 00:00:10.000
长字幕

00:00:05.000 --> 00:00:06.000
短字幕
`;
    const { renderer, video, surface } = setupPlayer();
    video.currentTime = 7;

    expect(renderer.mount({ video, originalVtt: original, translatedVtt: translated })).toBe(true);

    const overlay = surface.parentElement.querySelector(":scope > [data-echo360-instructure-caption=\"1\"]");
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toBe("长字幕");
  });

  it("drops stale state when the SPA removes the mounted player", () => {
    const { renderer, video } = setupPlayer();
    renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
    });
    video.parentElement.remove();

    expect(renderer.ensureMounted()).toBe(false);
    expect(renderer.isMounted()).toBe(false);
  });

  it("rejects an incremental update aimed at a replacement video", () => {
    const { renderer, video } = setupPlayer();
    renderer.mount({
      video,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
    });
    const replacementPlayer = document.createElement("div");
    replacementPlayer.setAttribute("data-media-player", "");
    const replacementVideo = document.createElement("video");
    replacementPlayer.appendChild(replacementVideo);
    document.body.appendChild(replacementPlayer);

    expect(renderer.update({
      video: replacementVideo,
      originalVtt: ORIGINAL_VTT,
      translatedVtt: TRANSLATED_VTT,
    })).toBe(false);
    expect(renderer.getDebugState().cueCount).toBe(2);
  });
});
