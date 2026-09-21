import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

describe("video subtitle source identity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.Echo360Translator = makeFullNs();
    evalModule("video.js");
  });

  afterEach(() => {
    window.Echo360Translator?.video?.destroy?.();
  });

  it("extracts media UUIDs from legacy Echo360 caption URLs", () => {
    expect(window.Echo360Translator.video.extractMediaIdFromVttUrl(
      "https://echo360.net.au/captions-d9939fef-3aca-44c3-b09c-5df104819581-en.vtt"
    )).toBe("d9939fef-3aca-44c3-b09c-5df104819581");
  });

  it("extracts media UUIDs from Canvas Instructure caption_files URLs", () => {
    expect(window.Echo360Translator.video.extractMediaIdFromVttUrl(
      "https://sydney.instructuremedia.com/api/media_management/caption_files/d9939fef-3aca-44c3-b09c-5df104819581-187306?1787725908057"
    )).toBe("d9939fef-3aca-44c3-b09c-5df104819581");
  });

  it("discovers nested shadow videos while scanning document elements once per stable index", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const nestedHost = document.createElement("div");
    const nestedShadow = nestedHost.attachShadow({ mode: "open" });
    const video = document.createElement("video");
    nestedShadow.appendChild(video);
    shadow.appendChild(nestedHost);
    document.body.appendChild(host);

    const allElements = vi.spyOn(document, "querySelectorAll");
    const first = window.Echo360Translator.video.getAllVideos();
    const second = window.Echo360Translator.video.getAllVideos();

    expect(first).toContain(video);
    expect(second).toContain(video);
    expect(allElements.mock.calls.filter(([selector]) => selector === "*")).toHaveLength(1);
  });

  it("indexes added and removed videos incrementally and emits one change batch", async () => {
    const api = window.Echo360Translator.video;
    const changes = vi.fn();
    const unsubscribe = api.subscribeToChanges(changes);
    expect(api.getAllVideos()).toEqual([]);

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const video = document.createElement("video");
    shadow.appendChild(video);
    document.body.appendChild(host);
    await Promise.resolve();
    await Promise.resolve();

    expect(api.getAllVideos()).toContain(video);
    expect(changes).toHaveBeenCalled();
    const changeCount = changes.mock.calls.length;
    host.remove();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.getAllVideos()).not.toContain(video);
    expect(changes.mock.calls.length).toBeGreaterThan(changeCount);

    unsubscribe();
  });

  it("finds a shadow root attached later to an already indexed host via bounded reconciliation", async () => {
    vi.useFakeTimers();
    try {
      const api = window.Echo360Translator.video;
      const host = document.createElement("div");
      document.body.appendChild(host);
      expect(api.getAllVideos()).toEqual([]);
      // Let the document observer index the existing host before attachShadow.
      await Promise.resolve();
      await Promise.resolve();

      const shadow = host.attachShadow({ mode: "open" });
      const video = document.createElement("video");
      shadow.appendChild(video);
      expect(api.getAllVideos()).not.toContain(video);

      await vi.advanceTimersByTimeAsync(15000);
      expect(api.getAllVideos()).toContain(video);
    } finally {
      vi.useRealTimers();
    }
  });

  it("partitions reconciliation across large candidate queues so late roots are found within one bounded round", async () => {
    vi.useFakeTimers();
    try {
      const api = window.Echo360Translator.video;
      const page = document.createElement("section");
      for (let index = 0; index < 1100; index += 1) page.appendChild(document.createElement("div"));
      const lateHost = document.createElement("div");
      page.appendChild(lateHost);
      document.body.appendChild(page);
      expect(api.getAllVideos()).toEqual([]);
      await Promise.resolve();
      await Promise.resolve();

      const shadow = lateHost.attachShadow({ mode: "open" });
      const video = document.createElement("video");
      shadow.appendChild(video);
      expect(api.getAllVideos()).not.toContain(video);

      // The index is larger than one 1,000-element bounded batch. Its
      // dynamically partitioned timer completes a full pass in about 15 s.
      await vi.advanceTimersByTimeAsync(15000);
      expect(api.getAllVideos()).toContain(video);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies CSS changes on video ancestors but ignores unrelated player churn", async () => {
    const api = window.Echo360Translator.video;
    const player = document.createElement("section");
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(document.createElement("video"));
    const progress = document.createElement("div");
    player.append(host, progress);
    document.body.append(player);
    const changed = vi.fn();
    api.subscribeToChanges(changed);
    progress.style.width = "20%";
    progress.appendChild(document.createElement("span"));
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    player.className = "hidden-player";
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("discovers newly inserted nested shadow videos synchronously within an explicit root", () => {
    const api = window.Echo360Translator.video;
    api.getAllVideos();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const nested = document.createElement("div");
    const nestedRoot = nested.attachShadow({ mode: "open" });
    const video = document.createElement("video");
    nestedRoot.append(video);
    shadow.append(nested);
    document.body.append(host);
    expect(api.querySelectorAllDeep("video", host)).toEqual([video]);
  });

  it("pauses late-shadow checks while hidden and resumes for picture-in-picture", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const api = window.Echo360Translator.video;
    try {
      const host = document.createElement("div");
      document.body.append(host);
      api.getAllVideos();
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      const video = document.createElement("video");
      host.attachShadow({ mode: "open" }).append(video);
      await vi.advanceTimersByTimeAsync(30000);
      expect(api.getAllVideos()).not.toContain(video);
      Object.defineProperty(document, "pictureInPictureElement", { configurable: true, value: video });
      document.dispatchEvent(new Event("enterpictureinpicture"));
      await vi.advanceTimersByTimeAsync(15000);
      expect(api.getAllVideos()).toContain(video);
    } finally {
      api.destroy();
      delete document.pictureInPictureElement;
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("releases old subscriptions on destroy and can restart discovery", async () => {
    const api = window.Echo360Translator.video;
    const oldListener = vi.fn();
    api.subscribeToChanges(oldListener);
    api.destroy();
    const newListener = vi.fn();
    api.subscribeToChanges(newListener);
    document.body.appendChild(document.createElement("video"));
    await Promise.resolve();
    expect(oldListener).not.toHaveBeenCalled();
    expect(newListener).toHaveBeenCalledOnce();
  });

  it("caches expensive React hint traversal per video and returns independent sets", () => {
    const video = document.createElement("video");
    document.body.appendChild(video);
    let reads = 0;
    Object.defineProperty(video, "__reactFiberHint", {
      configurable: true,
      get() {
        reads += 1;
        return { mediaId: "d9939fef-3aca-44c3-b09c-5df104819581" };
      },
    });
    const api = window.Echo360Translator.video;
    const first = api.getVideoHintMediaIds(video);
    const second = api.getVideoHintMediaIds(video);
    second.clear();

    expect(first).toContain("d9939fef-3aca-44c3-b09c-5df104819581");
    expect(second).toEqual(new Set());
    expect(reads).toBe(1);

    video.setAttribute("data-media-id", "0f659ee3-3aca-44c3-b09c-5df104819581");
    expect(api.getVideoHintMediaIds(video)).toContain("0f659ee3-3aca-44c3-b09c-5df104819581");
    expect(reads).toBe(2);
  });
});
