import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const docsDir = path.join(repoRoot, "docs");
const errors = [];

async function collectMarkdown(directory, recursive = false) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) found.push(entryPath);
    if (recursive && entry.isDirectory()) found.push(...await collectMarkdown(entryPath, true));
  }
  return found;
}

const markdownPaths = [
  ...await collectMarkdown(repoRoot, false),
  ...await collectMarkdown(docsDir, true),
].sort();

const markdownByPath = new Map();
for (const markdownPath of markdownPaths) {
  const markdown = await fs.readFile(markdownPath, "utf8");
  markdownByPath.set(markdownPath, markdown);
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim();
    if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
    const target = rawTarget.split("#", 1)[0];
    const resolved = path.resolve(path.dirname(markdownPath), decodeURIComponent(target));
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) errors.push(`${path.relative(repoRoot, markdownPath)} links to a non-file: ${rawTarget}`);
    } catch (_) {
      errors.push(`${path.relative(repoRoot, markdownPath)} has a broken local link: ${rawTarget}`);
    }
  }
}

const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
const readme = markdownByPath.get(path.join(repoRoot, "README.md")) || "";
const readmeEn = markdownByPath.get(path.join(repoRoot, "README.en.md")) || "";
const privacy = markdownByPath.get(path.join(repoRoot, "PRIVACY.md")) || "";
const store = markdownByPath.get(path.join(repoRoot, "CHROME_STORE.md")) || "";

function requireText(documentName, documentText, requiredText) {
  if (!documentText.includes(requiredText)) {
    errors.push(`${documentName} must document: ${requiredText}`);
  }
}

requireText("README.md", readme, `当前扩展版本：**${manifest.version}**`);
requireText("README.en.md", readmeEn, `Current extension version: **${manifest.version}**`);
for (const [name, text] of [["README.md", readme], ["README.en.md", readmeEn]]) {
  requireText(name, text, "python -m backend.launcher");
  requireText(name, text, "vitest.config.mjs");
  requireText(name, text, "TRANSLATOR_TASK_TIMEOUT_SECONDS");
}
const canvasMatches = (manifest.content_scripts || [])
  .flatMap((entry) => entry.matches || [])
  .filter((match) => match.includes("canvas.sydney.edu.au"));
for (const match of canvasMatches) {
  const documentedPath = new URL(match.replace("*://", "https://").replaceAll("*", "example")).pathname
    .replaceAll("example", "*");
  requireText("PRIVACY.md", privacy, documentedPath);
  requireText("CHROME_STORE.md", store, documentedPath);
}
requireText("PRIVACY.md", privacy, "google-web");
requireText("PRIVACY.md", privacy, "[SECURITY.md](SECURITY.md)");
for (const permission of (manifest.host_permissions || []).filter((item) => /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):8765\//.test(item))) {
  requireText("CHROME_STORE.md", store, permission);
}
requireText("CHROME_STORE.md", store, "There is no general backend toggle");

if (errors.length > 0) {
  for (const error of errors) console.error(`Documentation error: ${error}`);
  process.exit(1);
}

console.log(`Documentation OK: ${markdownPaths.length} Markdown files; version ${manifest.version} and security/privacy contracts aligned.`);
