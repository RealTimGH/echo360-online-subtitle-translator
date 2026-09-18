import crypto from "node:crypto";
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
const extensionRoot = path.join(repoRoot, "extension");

function section(text, begin, end) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new Error(`PBX section not found: ${begin}`);
  return text.slice(start + begin.length, finish);
}

function xcodeFileType(name, isDirectory) {
  if (isDirectory) return "folder";
  const extension = path.extname(name).toLowerCase();
  return {
    ".css": "text.css",
    ".html": "text.html",
    ".js": "sourcecode.javascript",
    ".json": "text.json",
  }[extension] || "text";
}

function deterministicId(name, role, usedIds) {
  for (let salt = 0; ; salt += 1) {
    const id = crypto.createHash("sha256")
      .update(`echo360-safari-resource:${name}:${role}:${salt}`)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
}

function insertBefore(text, marker, value) {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`PBX insertion marker not found: ${marker}`);
  return `${text.slice(0, index)}${value}${text.slice(index)}`;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileReferenceId(fileRefs, name) {
  const match = fileRefs.match(
    new RegExp(`\\b([A-F0-9]{24}) /\\* ${escaped(name)} \\*/ = \\{`, "m")
  );
  return match?.[1] || null;
}

function extensionResourceGroupPattern() {
  return /(\n\t\t[A-F0-9]{24} \/\* Resources \*\/ = \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n)((?:(?!\n\t\t[A-F0-9]{24} \/\* )[\s\S])*?)(\n?\t\t\t\);\n\t\t\tname = Resources;\n\t\t\tpath = "Shared \(Extension\)";)/;
}

function sync(project, entries) {
  const originalProject = project;
  const fileRefs = section(project, "/* Begin PBXFileReference section */", "/* End PBXFileReference section */");
  const missing = entries.filter(({ name }) => !fileReferenceId(fileRefs, name));
  const usedIds = new Set(project.match(/\b[A-F0-9]{24}\b/g) || []);
  const additions = missing.map(({ name, isDirectory }) => ({
    name,
    fileRefId: deterministicId(name, "file-ref", usedIds),
    fileType: xcodeFileType(name, isDirectory),
  }));

  if (additions.length) {
    const fileRefLines = additions.map((item) =>
      `\t\t${item.fileRefId} /* ${item.name} */ = {isa = PBXFileReference; lastKnownFileType = ${item.fileType}; name = ${item.name}; path = "../../../extension-store/${item.name}"; sourceTree = "<group>"; };`
    ).join("\n") + "\n";
    project = insertBefore(project, "/* End PBXFileReference section */", fileRefLines);
  }

  const currentFileRefs = section(project, "/* Begin PBXFileReference section */", "/* End PBXFileReference section */");
  const resources = entries.map(({ name, isDirectory }) => ({
    name,
    isDirectory,
    fileRefId: fileReferenceId(currentFileRefs, name),
  }));
  const unresolved = resources.filter(({ fileRefId }) => !fileRefId);
  if (unresolved.length) {
    throw new Error(`Safari resource file references could not be resolved: ${unresolved.map(({ name }) => name).join(", ")}`);
  }

  // A file reference's path is resolved relative to its PBX group. Older
  // versions of this project accidentally put newly added resources in the
  // containing app's Resources group, which changed ../../../extension-store
  // into dist/safari/extension-store. Normalize the path and group placement
  // for every resource so the repair is idempotent and not limited to files
  // that are absent from PBXFileReference.
  for (const resource of resources) {
    const referencePattern = new RegExp(
      `(^\\s*${resource.fileRefId} /\\* ${escaped(resource.name)} \\*/ = \\{[^\\n]*?path = )(?:(?:"[^"]*")|[^;]+)(;[^\\n]*$)`,
      "m"
    );
    project = project.replace(referencePattern, `$1"../../../extension-store/${resource.name}"$2`);

    const childPattern = new RegExp(
      `^\\s*${resource.fileRefId} /\\* ${escaped(resource.name)} \\*/,\\r?\\n?`,
      "gm"
    );
    project = project.replace(childPattern, "");
  }

  const groupPattern = extensionResourceGroupPattern();
  const groupMatch = project.match(groupPattern);
  if (!groupMatch) throw new Error("Shared (Extension) PBX resources group was not found");
  const groupLines = resources.map((resource) =>
    `\t\t\t\t${resource.fileRefId} /* ${resource.name} */,`
  ).join("\n") + "\n";
  project = project.replace(groupPattern, `$1${groupLines}$2$3`);

  const buildFileReferencePattern = (name) => new RegExp(
    `(^\\s*[A-F0-9]{24} /\\* ${escaped(name)} in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = )([A-F0-9]{24})( /\\* ${escaped(name)} \\*/; \\};$)`,
    "gm"
  );
  for (const resource of resources) {
    project = project.replace(
      buildFileReferencePattern(resource.name),
      (_full, prefix, _oldReferenceId, suffix) => `${prefix}${resource.fileRefId}${suffix}`
    );
  }

  const generatedBuildFileLines = [];
  let extensionPhaseIndex = 0;
  project = project.replace(
    /(\n\s*[A-F0-9]{24} \/\* Resources \*\/ = \{\n\s*isa = PBXResourcesBuildPhase;\n\s*buildActionMask = [^\n]+;\n\s*files = \(\n)([\s\S]*?)(\n\s*\);\n\s*runOnlyForDeploymentPostprocessing = 0;\n\s*\};)/g,
    (full, prefix, files, suffix) => {
      if (!files.includes("/* page_probe.js in Resources */")) return full;
      const phaseLines = [];
      for (const resource of resources) {
        if (files.includes(`/* ${resource.name} in Resources */`)) continue;
        const buildId = deterministicId(
          resource.name,
          extensionPhaseIndex === 0 ? "ios-build" : "mac-build",
          usedIds
        );
        generatedBuildFileLines.push(
          `\t\t${buildId} /* ${resource.name} in Resources */ = {isa = PBXBuildFile; fileRef = ${resource.fileRefId} /* ${resource.name} */; };`
        );
        phaseLines.push(`\t\t\t\t${buildId} /* ${resource.name} in Resources */,`);
      }
      extensionPhaseIndex += 1;
      return `${prefix}${phaseLines.length ? phaseLines.join("\n") + "\n" : ""}${files}${suffix}`;
    }
  );
  if (extensionPhaseIndex !== 2) {
    throw new Error(`Expected two Safari extension resource phases, found ${extensionPhaseIndex}`);
  }
  if (generatedBuildFileLines.length) {
    project = insertBefore(
      project,
      "/* End PBXBuildFile section */",
      `${generatedBuildFileLines.join("\n")}\n`
    );
  }
  return {
    project,
    added: additions.map(({ name }) => name),
    changed: project !== originalProject,
  };
}

function run() {
  if (!fs.existsSync(projectPath)) {
    console.log(`Safari Xcode project not present; skipped resource sync: ${projectPath}`);
    return;
  }
  const entries = fs.readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const original = fs.readFileSync(projectPath, "utf8");
  const result = sync(original, entries);
  if (result.project !== original) fs.writeFileSync(projectPath, result.project);
  if (result.added.length) {
    console.log(`Safari Xcode resources added: ${result.added.join(", ")}`);
  } else if (result.changed) {
    console.log("Safari Xcode resources repaired and synchronized.");
  } else {
    console.log("Safari Xcode resources already synchronized.");
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) run();

export { deterministicId, sync, xcodeFileType };
