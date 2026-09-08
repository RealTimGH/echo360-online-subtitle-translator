import { spawnSync } from "node:child_process";
import process from "node:process";


const forwardedArgs = process.argv.slice(2);
const configuredPython = (process.env.PYTHON || "").trim();
const candidates = configuredPython
  ? [[configuredPython, []]]
  : process.platform === "win32"
    ? [["py", ["-3"]], ["python", []]]
    : [["python3", []], ["python", []]];

for (const [command, prefixArgs] of candidates) {
  const result = spawnSync(command, [...prefixArgs, "scripts/build-backend.py", ...forwardedArgs], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

console.error("Python 3 was not found. Set PYTHON to the interpreter from the backend build environment.");
process.exit(1);

