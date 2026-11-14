import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** A fresh temporary directory (real path), removed after the test by test/setup.ts. */
export const tempDir = (prefix = "rea-mcp-test-"): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
};

export const removeTempDirs = (): void => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
};
