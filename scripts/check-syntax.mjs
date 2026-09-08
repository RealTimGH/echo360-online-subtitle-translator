import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function filesUnder(directory, extensions) {
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (["node_modules", "dist", "coverage", ".git"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(fullPath, extensions));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
}

const javascriptFiles = [
  ...await filesUnder(path.join(repoRoot, "extension"), new Set([".js", ".mjs"])),
  ...await filesUnder(path.join(repoRoot, "scripts"), new Set([".js", ".mjs"])),
].sort();

for (const file of javascriptFiles) {
  run(process.execPath, ["--check", file]);
}

const pythonFiles = [
  ...await filesUnder(path.join(repoRoot, "backend"), new Set([".py"])),
  ...await filesUnder(path.join(repoRoot, "translator"), new Set([".py"])),
  ...await filesUnder(path.join(repoRoot, "tests", "python"), new Set([".py"])),
].sort();

if (pythonFiles.length > 0) {
  const pythonCheck = [
    "from pathlib import Path",
    "import sys",
    "for name in sys.argv[1:]:",
    "    source = Path(name).read_text(encoding='utf-8')",
    "    compile(source, name, 'exec')",
  ].join("\n");
  run(process.env.PYTHON || "python3", ["-c", pythonCheck, ...pythonFiles]);
}

console.log(`Syntax OK: ${javascriptFiles.length} JavaScript files, ${pythonFiles.length} Python files.`);
