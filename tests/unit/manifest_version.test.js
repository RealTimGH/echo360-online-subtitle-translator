import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../helpers/load-module.js";

const EXPECTED_VERSION = "1.5.0";

describe("extension release metadata", () => {
  it("keeps manifest and README version declarations in sync", () => {
    const manifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "extension/manifest.json"), "utf8"));
    const readme = readFileSync(resolve(PROJECT_ROOT, "README.md"), "utf8");
    const readmeEn = readFileSync(resolve(PROJECT_ROOT, "README.en.md"), "utf8");
    expect(manifest.version).toBe(EXPECTED_VERSION);
    expect(readme).toContain(`当前扩展版本：**${EXPECTED_VERSION}**`);
    expect(readmeEn).toContain(`Current extension version: **${EXPECTED_VERSION}**`);
  });

  it("declares the Canvas/Instructure Media frame support needed by the player adapter", () => {
    const manifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "extension/manifest.json"), "utf8"));
    expect(manifest.host_permissions).toContain("*://*.instructuremedia.com/*");
    expect(manifest.host_permissions).not.toContain("*://canvas.sydney.edu.au/*");
    expect(manifest.host_permissions).toContain("http://[::1]:8765/*");
    expect(manifest.content_scripts).toHaveLength(3);
    const courseBridge = manifest.content_scripts.find((script) => script.js.includes("canvas_course_bridge.js"));
    expect(courseBridge).toMatchObject({
      matches: [
        "*://canvas.sydney.edu.au/courses/*/pages/*",
        "*://canvas.sydney.edu.au/courses/*/external_tools/*",
      ],
      all_frames: false,
      run_at: "document_start",
    });
    expect(courseBridge.js).toEqual(["canvas_course_bridge.js"]);

    const mediaScripts = manifest.content_scripts.filter((script) => !script.js.includes("canvas_course_bridge.js"));
    for (const script of mediaScripts) {
      expect(script.matches).toContain("*://*.instructuremedia.com/*");
      expect(script.matches).not.toContain("*://canvas.sydney.edu.au/*");
      expect(script.js[0]).toBe("assessment_guard.js");
    }
    const isolated = mediaScripts.find((script) => script.world !== "MAIN").js;
    expect(isolated).toContain("host_support.js");
    expect(isolated).toContain("player_caption_renderer.js");
  });
});
