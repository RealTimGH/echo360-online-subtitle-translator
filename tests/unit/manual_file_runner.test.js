import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evalModule, makeFullNs } from "../helpers/load-module.js";

describe("manual full-file translation runner", () => {
  let directory, manual, sourceVtt, created, jobPath, runnerPath;
  beforeEach(() => {
    window.Echo360Translator = makeFullNs();
    evalModule("vtt.js");
    evalModule("manual_translation.js");
    manual = window.Echo360Translator.manualTranslation;
    directory = mkdtempSync(join(tmpdir(), "echo360-file-job-"));
    const stamp = (i) => new Date(i * 1000).toISOString().slice(11, 23);
    sourceVtt = "WEBVTT\n\n" + Array.from({ length: 82 }, (_, i) =>
      `${stamp(i)} --> ${stamp(i + 1)}\n<v Lecturer>We have 3 books.`).join("\n\n");
    created = manual.createTranslationPackage({ sourceVtt, sourceHash: "file-runner", target: "ZH", vtt: window.Echo360Translator.vtt });
    created.translationPackage = manual.createFilePackage(created.workflow);
    jobPath = join(directory, "input.translate.json");
    runnerPath = join(directory, "runner.py");
    writeFileSync(jobPath, JSON.stringify(created.translationPackage));
    writeFileSync(runnerPath, manual.fileRunnerSource());
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const run = (runner, job, ...args) => spawnSync("python3", [runner, job, ...args], { encoding: "utf8" });

  it("reads bounded parts and assembles exactly one importable full result without translating any text itself", () => {
    const next = JSON.parse(run(runnerPath, jobPath, "next").stdout);
    expect(Object.keys(next.cues)).toHaveLength(80);
    expect(run(runnerPath, jobPath, "finish", join(directory, "early.json")).status).not.toBe(0);
    const partPath = join(directory, "part.json");
    const authored = Object.fromEntries(Object.keys(next.cues).map((id) => [id, "我们有 3 本书。"]));
    writeFileSync(partPath, JSON.stringify(authored));
    expect(run(runnerPath, jobPath, "accept", partPath).status).toBe(0);
    // A new helper process resumes persisted progress instead of repeating 80 rows.
    const remaining = JSON.parse(run(runnerPath, jobPath, "next").stdout);
    expect(Object.keys(remaining.cues)).toHaveLength(2);
    writeFileSync(partPath, JSON.stringify(Object.fromEntries(Object.keys(remaining.cues).map((id) => [id, "我们有 3 本书。"]))));
    expect(run(runnerPath, jobPath, "accept", partPath).status).toBe(0);
    expect(JSON.parse(run(runnerPath, jobPath, "next").stdout).complete).toBe(true);
    const output = join(directory, "full.translated.json");
    expect(run(runnerPath, jobPath, "finish", output).status).toBe(0);
    const result = manual.validateWorkflowResult(readFileSync(output, "utf8"), { ...created, sourceVtt }, { vtt: window.Echo360Translator.vtt });
    expect(result.complete).toBe(true);
    expect(result.cueCount).toBe(82);
    expect(result.translatedVtt).toContain("<v Lecturer>我们有 3 本书。");
  });

  it("rejects duplicate IDs, wrong quantities and empty-content parts without advancing progress", () => {
    const next = JSON.parse(run(runnerPath, jobPath, "next").stdout);
    const partPath = join(directory, "part.json");
    const authored = Object.fromEntries(Object.keys(next.cues).map((id) => [id, "我们有 3 本书。"]));
    for (const bad of ["我们有 4 本书。", "。", ""]) {
      writeFileSync(partPath, JSON.stringify({ ...authored, c000001: bad }));
      expect(run(runnerPath, jobPath, "accept", partPath).status).not.toBe(0);
      expect(JSON.parse(run(runnerPath, jobPath, "next").stdout).accepted).toBe(0);
    }
    writeFileSync(partPath, '{"c000001":"甲","c000001":"乙"}');
    expect(run(runnerPath, jobPath, "accept", partPath).stderr).toContain("duplicate key");
  });

  it("plans independent files for workers and merges only through the coordinator", () => {
    const plan = JSON.parse(run(runnerPath, jobPath, "plan").stdout);
    expect(plan.tasks.map((task) => task.count)).toEqual([80, 2]);
    expect(JSON.parse(run(runnerPath, jobPath, "next").stdout).accepted).toBe(0);
    for (const task of [...plan.tasks].reverse()) {
      const input = JSON.parse(readFileSync(task.input, "utf8"));
      writeFileSync(task.output, JSON.stringify(Object.fromEntries(Object.keys(input.cues).map((id) => [id, "我们有 3 本书。"]))));
    }
    // Out-of-order completion is safe; only the coordinator updates progress.
    for (const task of plan.tasks) expect(run(runnerPath, jobPath, "accept", task.output).status).toBe(0);
    expect(JSON.parse(run(runnerPath, jobPath, "next").stdout).complete).toBe(true);
  });

  it("keeps separated repair regions from being joined into a false continuous passage", () => {
    created.workflow.accepted = Object.fromEntries(created.workflow.records.slice(1, -1).map((record) => [record.id, "我们有 3 本书。"]));
    const repair = manual.createFilePackage(created.workflow);
    expect(Object.keys(repair.cues)).toEqual(["c000001", "c000082"]);
    expect(repair.context["c000001:after"]).toContain("3 books");
    writeFileSync(jobPath, JSON.stringify(repair));
    const first = JSON.parse(run(runnerPath, jobPath, "next").stdout);
    expect(Object.keys(first.cues)).toEqual(["c000001"]);
    expect(first.context_after).toContain("3 books");
  });
});
