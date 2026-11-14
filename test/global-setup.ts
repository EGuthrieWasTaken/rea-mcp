// Builds the gateway once per test run so integration tests can start the real
// entry point as a child process (exit codes, signals and stdio are process-level
// behaviour). The output goes under the repository because compiled files must
// resolve `node_modules` from where they sit.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export default function setup(): void {
  const outDir = fileURLToPath(new URL("../.test-build", import.meta.url));
  rmSync(outDir, { recursive: true, force: true });
  const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", outDir], {
    cwd: root,
    stdio: "pipe",
  });
  // Test fixtures (the fake REA) are compiled beside it, into .test-build/fixtures.
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.fixtures.json"], { cwd: root, stdio: "pipe" });
}
