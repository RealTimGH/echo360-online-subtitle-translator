import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../helpers/load-module.js";

const EXPECTED_VERSION = "1.4.3";

describe("extension release metadata", () => {
  it("keeps manifest and README version declarations in sync", () => {
    const manifest = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "extension/manifest.json"), "utf8"));
    const readme = readFileSync(resolve(PROJECT_ROOT, "README.md"), "utf8");
    const readmeEn = readFileSync(resolve(PROJECT_ROOT, "README.en.md"), "utf8");
    expect(manifest.version).toBe(EXPECTED_VERSION);
    expect(readme).toContain(`当前扩展版本：**${EXPECTED_VERSION}**`);
    expect(readmeEn).toContain(`Current extension version: **${EXPECTED_VERSION}**`);
  });
});
