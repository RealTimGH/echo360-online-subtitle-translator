import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Compare a requested Git revision with the working tree without modifying
// either. Timings exclude module loading, compilation and fixture generation.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const baseline = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11) || "HEAD";
const cueCount = 2000;
const repetitions = 5;

function loadModules(revision) {
  const ns = { constants: {} };
  const context = vm.createContext({ window: { Echo360Translator: ns } });
  for (const name of ["vtt.js", "transcript_model.js"]) {
    const path = `extension/${name}`;
    const source = revision
      ? execFileSync("git", ["show", `${revision}:${path}`], { cwd: repoRoot, encoding: "utf8" })
      : readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    vm.runInContext(source, context, { filename: path });
  }
  return ns;
}

const before = loadModules(baseline);
const after = loadModules(null);
const fixture = (count, text) => "WEBVTT\n\n" + Array.from({ length: count }, (_, index) =>
  `${after.vtt.formatVttTime(index * 2)} --> ${after.vtt.formatVttTime(index * 2 + 1)}\n${text} ${index}\n`
).join("\n");
const originalVtt = fixture(cueCount, "Source caption");
const translatedVtt = fixture(cueCount - 1, "翻译字幕");
const build = (ns) => ns.transcriptModel.buildTranscriptModel({ originalVtt, translatedVtt });
const signature = (model) => Array.from(model.cues, (cue) => [cue.key, cue.translatedText, cue.status]);
assert.deepEqual(signature(build(before)), signature(build(after)), "Alignment semantics changed");

function medianMs(fn) {
  fn(); // Warm up the same path in both revisions.
  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

const beforeMs = medianMs(() => build(before));
const afterMs = medianMs(() => build(after));
console.log(JSON.stringify({
  scenario: "Build transcript model with one missing translated cue",
  baseline,
  node: process.version,
  cueCount,
  translatedCueCount: cueCount - 1,
  repetitions,
  baselineMedianMs: Number(beforeMs.toFixed(2)),
  workingTreeMedianMs: Number(afterMs.toFixed(2)),
  speedup: Number((beforeMs / afterMs).toFixed(2)),
  semantics: "identical cue keys, translated text and statuses",
  limitation: "Synthetic CPU benchmark; not a browser playback, memory or temperature measurement",
}, null, 2));
