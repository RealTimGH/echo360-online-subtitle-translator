import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const extensionDir = path.join(repoRoot, "extension");
const manifestPath = path.join(extensionDir, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const errors = [];
const referencedFiles = new Set();

function addReference(value, source) {
  if (!value || typeof value !== "string") return;
  if (/^(?:[a-z]+:|#)/i.test(value)) return;
  referencedFiles.add(JSON.stringify({ value: value.split(/[?#]/, 1)[0], source }));
}

addReference(manifest.options_page, "manifest.options_page");
addReference(manifest.action?.default_popup, "manifest.action.default_popup");
addReference(manifest.background?.service_worker, "manifest.background.service_worker");
for (const [size, icon] of Object.entries(manifest.icons || {})) addReference(icon, `manifest.icons.${size}`);
for (const [size, icon] of Object.entries(manifest.action?.default_icon || {})) addReference(icon, `manifest.action.default_icon.${size}`);

for (const [index, contentScript] of (manifest.content_scripts || []).entries()) {
  const scripts = contentScript.js || [];
  if (new Set(scripts).size !== scripts.length) {
    errors.push(`manifest.content_scripts[${index}] contains duplicate script entries`);
  }
  for (const script of scripts) addReference(script, `manifest.content_scripts[${index}].js`);
  for (const stylesheet of contentScript.css || []) addReference(stylesheet, `manifest.content_scripts[${index}].css`);
}

for (const [index, resourceGroup] of (manifest.web_accessible_resources || []).entries()) {
  for (const resource of resourceGroup.resources || []) addReference(resource, `manifest.web_accessible_resources[${index}]`);
}

for (const htmlName of [manifest.options_page, manifest.action?.default_popup].filter(Boolean)) {
  const html = await fs.readFile(path.join(extensionDir, htmlName), "utf8");
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(attributePattern)) addReference(match[1], htmlName);
}

const backgroundName = manifest.background?.service_worker;
if (backgroundName) {
  const background = await fs.readFile(path.join(extensionDir, backgroundName), "utf8");
  const importCall = background.match(/\bimportScripts\s*\(([^)]*)\)/s);
  if (!importCall) {
    errors.push(`${backgroundName} does not declare its classic-script dependencies with importScripts()`);
  } else {
    for (const match of importCall[1].matchAll(/["']([^"']+)["']/g)) {
      addReference(match[1], `${backgroundName}:importScripts`);
    }
  }
}

for (const encoded of referencedFiles) {
  const { value, source } = JSON.parse(encoded);
  try {
    const stat = await fs.stat(path.join(extensionDir, value));
    if (!stat.isFile()) errors.push(`${source} references a non-file: ${value}`);
  } catch (_) {
    errors.push(`${source} references a missing file: ${value}`);
  }
}

const isolatedGuard = await fs.readFile(path.join(extensionDir, "assessment_guard.js"), "utf8");
const mainGuard = await fs.readFile(path.join(extensionDir, "assessment_guard_main.js"), "utf8");
if (isolatedGuard !== mainGuard) {
  errors.push("assessment_guard.js and assessment_guard_main.js have drifted apart");
}

if (manifest.manifest_version !== 3) errors.push("extension manifest must use Manifest V3");
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") {
  errors.push("extension pages must keep the explicit self-only Content Security Policy");
}

if (errors.length > 0) {
  for (const error of errors) console.error(`Structure error: ${error}`);
  process.exit(1);
}

console.log(`Extension structure OK: ${referencedFiles.size} referenced files verified.`);
