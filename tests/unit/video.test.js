import { beforeEach, describe, expect, it } from "vitest";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

describe("video subtitle source identity", () => {
  beforeEach(() => {
    window.Echo360Translator = makeFullNs();
    evalModule("video.js");
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
});
