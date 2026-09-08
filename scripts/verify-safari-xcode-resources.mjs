import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConfigContent,
  manifestForTarget,
  optionsHtmlForTarget,
} from "./build-extension.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const projectPath = path.resolve(
  repoRoot,
  process.argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length) ||
    "dist/safari/Echo360 Subtitle Translator/Echo360 Subtitle Translator.xcodeproj/project.pbxproj"
);
const required = process.argv.includes("--required");
const sourceExtensionRoot = path.join(repoRoot, "extension");
const storeExtensionRoot = path.join(repoRoot, "dist", "extension-store");

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

function extensionResources(extensionRoot) {
  return fs.readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .map((entry) => entry.name)
    .sort();
}

function relativeFiles(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .flatMap((entry) => {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) return relativeFiles(root, absolutePath);
      if (!entry.isFile()) return [];
      return [path.relative(root, absolutePath).split(path.sep).join("/")];
    })
    .sort();
}

function expectedStoreContent(relativePath) {
  const sourcePath = path.join(sourceExtensionRoot, relativePath);

  switch (relativePath) {
    case "build_config.js":
      return Buffer.from(buildConfigContent("store"));
    case "manifest.json": {
      const manifest = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      return Buffer.from(`${JSON.stringify(manifestForTarget(manifest, "store"), null, 2)}\n`);
    }
    case "options.html":
      return Buffer.from(optionsHtmlForTarget(fs.readFileSync(sourcePath, "utf8"), "store"));
    default:
      return fs.readFileSync(sourcePath);
  }
}

function verifyStoreBuild() {
  if (!fs.existsSync(storeExtensionRoot)) {
    throw new Error(`Safari store build not found: ${storeExtensionRoot}. Run npm run safari:prepare.`);
  }

  const sourceFiles = relativeFiles(sourceExtensionRoot);
  const builtFiles = relativeFiles(storeExtensionRoot);
  const missing = sourceFiles.filter((name) => !builtFiles.includes(name));
  const extra = builtFiles.filter((name) => !sourceFiles.includes(name));
  const stale = sourceFiles.filter((name) => {
    const builtPath = path.join(storeExtensionRoot, name);
    return fs.existsSync(builtPath) && !expectedStoreContent(name).equals(fs.readFileSync(builtPath));
  });

  if (missing.length || extra.length || stale.length) {
    throw new Error(`Safari store build is stale: ${JSON.stringify({ missing, extra, stale })}. Run npm run safari:prepare.`);
  }

  return { fileCount: sourceFiles.length };
}

function resourcePhaseBlocks(resourcesSection) {
  return [...resourcesSection.matchAll(
    /\n\s*([A-F0-9]{24}) \/\* Resources \*\/ = \{([\s\S]*?)\n\s*\};/g
  )].map((match) => ({ id: match[1], body: match[2] }));
}

function verify(project, resourcesToVerify, options = {}) {
  const projectFilePath = options.projectFilePath || projectPath;
  const expectedResourceRoot = options.expectedResourceRoot || storeExtensionRoot;
  const fileRefs = section(project, "/* Begin PBXFileReference section */", "/* End PBXFileReference section */");
  const buildFiles = section(project, "/* Begin PBXBuildFile section */", "/* End PBXBuildFile section */");
  const resources = section(project, "/* Begin PBXResourcesBuildPhase section */", "/* End PBXResourcesBuildPhase section */");
  const extensionPhases = resourcePhaseBlocks(resources)
    .filter(({ body }) => body.includes("/* page_probe.js in Resources */"));

  const missingFileRefs = resourcesToVerify.filter((name) => !new RegExp(`/\\* ${escaped(name)} \\*/`).test(fileRefs));
  const missingBuildFiles = resourcesToVerify.filter((name) => !new RegExp(`/\\* ${escaped(name)} in Resources \\*/`).test(buildFiles));
  const missingTargetResources = extensionPhases.map(({ id, body }) => ({
    id,
    missing: resourcesToVerify.filter((name) => !body.includes(`/* ${name} in Resources */`)),
  })).filter(({ missing }) => missing.length > 0);
  const expectedResourceNames = new Set(resourcesToVerify);
  const unexpectedTargetResources = extensionPhases.map(({ id, body }) => ({
    id,
    unexpected: [...body.matchAll(/\/\* (.+?) in Resources \*\//g)]
      .map((match) => match[1])
      .filter((name) => !expectedResourceNames.has(name)),
  })).filter(({ unexpected }) => unexpected.length > 0);

  const fileRefPaths = new Map(resourcesToVerify.map((name) => {
    const match = fileRefs.match(new RegExp(`/\\* ${escaped(name)} \\*/ = \\{[^\n]*?path = (?:"([^"]+)"|([^;]+));`));
    return [name, match ? (match[1] || match[2]).trim() : null];
  }));
  const unresolvedPaths = resourcesToVerify.filter((name) => {
    const referencedPath = fileRefPaths.get(name);
    return referencedPath && !fs.existsSync(path.resolve(path.dirname(projectFilePath), referencedPath));
  });
  const wrongResourcePaths = resourcesToVerify.filter((name) => {
    const referencedPath = fileRefPaths.get(name);
    if (!referencedPath) return false;
    const actual = path.resolve(path.dirname(projectFilePath), referencedPath);
    const expected = path.resolve(expectedResourceRoot, name);
    return actual !== expected;
  }).map((name) => ({ name, path: fileRefPaths.get(name) }));

  if (extensionPhases.length !== 2 || missingFileRefs.length || missingBuildFiles.length ||
      missingTargetResources.length || unexpectedTargetResources.length ||
      unresolvedPaths.length || wrongResourcePaths.length) {
    const details = {
      extensionResourcePhaseCount: extensionPhases.length,
      missingFileRefs,
      missingBuildFiles,
      missingTargetResources,
      unexpectedTargetResources,
      unresolvedPaths,
      wrongResourcePaths,
    };
    throw new Error(`Safari Xcode resource validation failed: ${JSON.stringify(details)}`);
  }

  return { resourceCount: resourcesToVerify.length, extensionResourcePhaseCount: extensionPhases.length };
}

if (!fs.existsSync(projectPath)) {
  if (required) throw new Error(`Safari Xcode project not found: ${projectPath}`);
  console.log(`Safari Xcode project not present; skipped validation: ${projectPath}`);
} else {
  const buildResult = verifyStoreBuild();
  const resources = extensionResources(sourceExtensionRoot);
  const result = verify(fs.readFileSync(projectPath, "utf8"), resources);
  console.log(`Safari Xcode resources OK: ${buildResult.fileCount} generated files; ${result.resourceCount} top-level resources in ${result.extensionResourcePhaseCount} extension targets.`);
}

export { extensionResources, manifestScripts, relativeFiles, resourcePhaseBlocks, verify, verifyStoreBuild };
