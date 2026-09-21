// Local-only audit: node scripts/analyze-sentence-merge.mjs file.vtt [...]
// Optional: --baseline path/to/previous/sentence_merge.js
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baselineIndex = args.indexOf("--baseline");
const baselinePath = baselineIndex < 0 ? null : args.splice(baselineIndex, 2)[1];
if (!args.length || (baselineIndex >= 0 && !baselinePath)) {
  console.error("Usage: node scripts/analyze-sentence-merge.mjs [--baseline previous-module.js] file.vtt [...]");
  process.exit(1);
}
async function load(modulePath) {
  const context = vm.createContext({ window: { Echo360Translator: { constants: {} } } });
  vm.runInContext(await fs.readFile(path.join(root, "extension/vtt.js"), "utf8"), context);
  vm.runInContext(await fs.readFile(modulePath, "utf8"), context);
  return context.window.Echo360Translator;
}
const current = await load(path.join(root, "extension/sentence_merge.js"));
const baseline = baselinePath ? await load(path.resolve(baselinePath)) : null;
const tags = /<\/?(?:v|c|i|b|u|ruby|rt|lang)(?=[\s.>])[^>]*>|<(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}>/g;
const plain = value => value.replace(tags, "").replace(/\s+/g, " ").trim();
const words = value => (plain(value).match(/[\p{L}\p{N}]+(?:['’’-][\p{L}\p{N}]+)*/gu) || []).length;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] || 0;
function audit(ns, source) {
  const cues = ns.vtt.parseVttCues(source);
  const plan = ns.sentenceMerge.build(source);
  const counts = plan.groups.map(group => words(group.text));
  const sourceGroups = cues.map(() => []);
  for (const group of plan.groups) {
    for (const index of group.sourceIndices) sourceGroups[index]?.push(group);
  }
  const displayWords = sourceGroups.map(groups => groups.reduce((sum, group) => sum + words(group.text), 0));
  const wordsPreserved = plain(cues.map(cue => cue.text).join(" ")) === plain(plan.groups.map(group => group.text).join(" "));
  const allCuesMapped = sourceGroups.every(groups => groups.length > 0);
  const originalEnglishUnchanged = ns.sentenceMerge.project(source, plan.vtt, plan, false).originalVtt === source;
  if (!wordsPreserved || !allCuesMapped || !originalEnglishUnchanged) process.exitCode = 1;
  return {
    sourceCues: cues.length, translationUnits: counts.length,
    meanWords: Number((counts.reduce((sum, n) => sum + n, 0) / (counts.length || 1)).toFixed(2)),
    p95Words: percentile(counts, .95), maxWords: Math.max(0, ...counts),
    unitsOver40Words: counts.filter(n => n > 40).length,
    sourceCuesInMultipleGroups: sourceGroups.filter(groups => groups.length > 1).length,
    displayP95SourceWords: percentile(displayWords, .95), displayMaxSourceWords: Math.max(0, ...displayWords),
    wordsPreserved, allCuesMapped, originalEnglishUnchanged,
  };
}
const results = [];
for (const file of args) {
  const source = await fs.readFile(file, "utf8");
  results.push({ file: path.basename(file), ...(baseline ? { baseline: audit(baseline, source) } : {}), current: audit(current, source) });
}
console.log(JSON.stringify(results, null, 2));
