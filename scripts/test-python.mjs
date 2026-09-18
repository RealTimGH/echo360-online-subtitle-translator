import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const localInterpreters = process.platform === "win32"
  ? [
    resolve(projectRoot, "backend", ".venv", "Scripts", "python.exe"),
    resolve(projectRoot, ".backend-build-venv", "Scripts", "python.exe"),
  ]
  : [
    resolve(projectRoot, "backend", ".venv", "bin", "python"),
    resolve(projectRoot, ".backend-build-venv", "bin", "python"),
  ];
const candidates = [
  process.env.ECHO360_TEST_PYTHON,
  ...localInterpreters,
  process.platform === "win32" ? "python" : "python3",
  "python",
].filter(Boolean);
const expectedDependencies = Object.fromEntries(
  readFileSync(resolve(projectRoot, "backend", "requirements.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("=="))
    .map((line) => line.split("==", 2))
);

function supportedRuntime(interpreter) {
  const probe = spawnSync(interpreter, [
    "-c",
    [
      "import sys, json, importlib.metadata",
      "assert sys.version_info >= (3, 10)",
      "expected = json.loads(sys.argv[1])",
      "actual = {name: importlib.metadata.version(name) for name in expected}",
      "assert actual == expected, f'dependency mismatch: expected={expected} actual={actual}'",
      "print(sys.executable)",
      "print(sys.version.split()[0])",
      "print(' '.join(f'{name}={version}' for name, version in actual.items()))",
    ].join("; "),
    JSON.stringify(expectedDependencies),
  ], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : "";
}

let selected = null;
for (const candidate of candidates) {
  if (candidate.includes("/") || candidate.includes("\\")) {
    if (!existsSync(candidate)) continue;
  }
  const details = supportedRuntime(candidate);
  if (details) {
    selected = { interpreter: candidate, details };
    break;
  }
}

if (!selected) {
  console.error(
    "No supported Python 3.10+ interpreter with the current backend dependencies was found. " +
    "Create backend/.venv and install backend/requirements.txt, or set ECHO360_TEST_PYTHON."
  );
  process.exit(1);
}

console.log(`Python test runtime:\n${selected.details}`);

const result = spawnSync(
  selected.interpreter,
  ["-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Unable to run Python tests with ${selected.interpreter}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
