import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const projectPath = path.resolve(
  repoRoot,
  process.argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length) ||
    "dist/safari/Echo360 Subtitle Translator/Echo360 Subtitle Translator.xcodeproj/project.pbxproj"
);
const required = process.argv.includes("--required");

function section(text, begin, end) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new Error(`PBX section not found: ${begin}`);
  return text.slice(start + begin.length, finish);
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function manifestScripts(manifest) {
  return [...new Set((manifest.content_scripts || []).flatMap((entry) => entry.js || []))];
}

function resourcePhaseBlocks(resourcesSection) {
  return [...resourcesSection.matchAll(
    /\n\s*([A-F0-9]{24}) \/\* Resources \*\/ = \{([\s\S]*?)\n\s*\};/g
  )].map((match) => ({ id: match[1], body: match[2] }));
}

function verify(project, manifest) {
  const fileRefs = section(project, "/* Begin PBXFileReference section */", "/* End PBXFileReference section */");
  const buildFiles = section(project, "/* Begin PBXBuildFile section */", "/* End PBXBuildFile section */");
  const resources = section(project, "/* Begin PBXResourcesBuildPhase section */", "/* End PBXResourcesBuildPhase section */");
  const scripts = manifestScripts(manifest);
  const extensionPhases = resourcePhaseBlocks(resources)
    .filter(({ body }) => body.includes("/* page_probe.js in Resources */"));

  const missingFileRefs = scripts.filter((name) => !new RegExp(`/\\* ${escaped(name)} \\*/`).test(fileRefs));
  const missingBuildFiles = scripts.filter((name) => !new RegExp(`/\\* ${escaped(name)} in Resources \\*/`).test(buildFiles));
  const missingTargetResources = extensionPhases.map(({ id, body }) => ({
    id,
    missing: scripts.filter((name) => !body.includes(`/* ${name} in Resources */`)),
  })).filter(({ missing }) => missing.length > 0);

  const unresolvedPaths = scripts.filter((name) => {
    const match = fileRefs.match(new RegExp(`/\\* ${escaped(name)} \\*/ = \\{[^\n]*?path = "([^"]+)"`));
    if (!match) return false;
    return !fs.existsSync(path.resolve(path.dirname(projectPath), match[1]));
  });

  if (extensionPhases.length !== 2 || missingFileRefs.length || missingBuildFiles.length ||
      missingTargetResources.length || unresolvedPaths.length) {
    const details = {
      extensionResourcePhaseCount: extensionPhases.length,
      missingFileRefs,
      missingBuildFiles,
      missingTargetResources,
      unresolvedPaths,
    };
    throw new Error(`Safari Xcode resource validation failed: ${JSON.stringify(details)}`);
  }

  return { scriptCount: scripts.length, extensionResourcePhaseCount: extensionPhases.length };
}

if (!fs.existsSync(projectPath)) {
  if (required) throw new Error(`Safari Xcode project not found: ${projectPath}`);
  console.log(`Safari Xcode project not present; skipped validation: ${projectPath}`);
} else {
  const manifestPath = path.join(repoRoot, "dist/extension-store/manifest.json");
  const fallbackManifestPath = path.join(repoRoot, "extension/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(
    fs.existsSync(manifestPath) ? manifestPath : fallbackManifestPath,
    "utf8"
  ));
  const result = verify(fs.readFileSync(projectPath, "utf8"), manifest);
  console.log(`Safari Xcode resources OK: ${result.scriptCount} content-script files in ${result.extensionResourcePhaseCount} extension targets.`);
}

export { manifestScripts, resourcePhaseBlocks, verify };
