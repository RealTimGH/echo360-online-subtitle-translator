import { beforeEach, describe, expect, it } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

function setLocation(hostname, pathname) {
  Object.defineProperty(window, "location", {
    value: {
      hostname,
      pathname,
      href: `https://${hostname}${pathname}`,
      origin: `https://${hostname}`,
    },
    configurable: true,
    writable: true,
  });
}

function setup(hostname = "sydney.instructuremedia.com", pathname = "/lti-app/embed/perspective/player") {
  document.body.innerHTML = "";
  setLocation(hostname, pathname);
  window.Echo360Translator = makeFullNs();
  evalModule("host_support.js");
  return window.Echo360Translator.hostSupport;
}

describe("host_support", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("recognizes an Instructure Media embed but not an unrelated Instructure page", () => {
    expect(setup().isInstructureMediaDocument()).toBe(true);
    const otherRoute = setup("sydney.instructuremedia.com", "/media/player/changed-route");
    expect(otherRoute.isInstructureMediaDocument()).toBe(false);
    expect(otherRoute.isInstructureMediaHost()).toBe(true);
    expect(otherRoute.isSupportedPlayerDocument()).toBe(true);
  });

  it("keeps Echo360 documents supported", () => {
    const support = setup("canvas.echo360.net.au", "/lesson/abc");
    expect(support.isEcho360Document()).toBe(true);
    expect(support.isSupportedPlayerDocument()).toBe(true);
  });

  it("finds the Vidstack player and its caption surface within an embed frame", () => {
    const support = setup();
    const player = document.createElement("div");
    player.setAttribute("data-media-player", "");
    const video = document.createElement("video");
    const surface = document.createElement("div");
    surface.setAttribute("data-part", "captions");
    player.append(video, surface);
    document.body.appendChild(player);

    expect(support.isInstructureVideo(video)).toBe(true);
    expect(support.getPlayer(video)).toBe(player);
    expect(support.getCaptionSurface(video)).toBe(surface);
  });
});
