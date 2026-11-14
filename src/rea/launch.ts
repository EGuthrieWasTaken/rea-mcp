// How REA is started (design D8). One internal configuration point, so tests can
// substitute the fake stdio server, and so the child's environment is built from an
// allowlist in exactly one place.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isHeapSize, type Environment } from "../config.js";

export interface ReaLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** The whole environment of the child: nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The variables a REA child may inherit from the gateway, unchanged. A variable is passed
 * only if it is on this list AND set. In particular no `REA_MCP_API_KEY*` variable is
 * here, nor any other secret, nor the five REA settings that cannot be combined with a
 * checkpoint directory. REA_GHIDRA_STARTUP_TIMEOUT_MS is passed exactly as given: REA
 * validates it itself, and only when a Ghidra session starts.
 */
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "JAVA_HOME",
  "GHIDRA_INSTALL_DIR",
  "TMPDIR",
  "REA_GHIDRA_STARTUP_TIMEOUT_MS",
] as const;

export function childEnvironment(env: Environment): Record<string, string> {
  const child: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = env[name];
    if (value !== undefined && value !== "") child[name] = value;
  }
  // The maximum heap of Ghidra's JVM. REA builds -Xmx from GHIDRA_HEADLESS_MAXMEM (then
  // GHIDRA_MAXMEM, then 2G) and blanks JAVA_TOOL_OPTIONS and the other Java option
  // variables, so this is the one route that works (design D10). GHIDRA_MAX_HEAP is the
  // operator's setting; the child only ever sees the variable REA reads. The format was
  // checked at startup, and is checked again so nothing odd can reach -Xmx.
  const heap = env.GHIDRA_MAX_HEAP?.trim();
  if (heap !== undefined && isHeapSize(heap)) child.GHIDRA_HEADLESS_MAXMEM = heap;
  return child;
}

/** Raised at startup when the pinned `rea-agents` dependency cannot be found. */
export class ReaNotInstalledError extends Error {
  constructor() {
    super("the rea-agents dependency is not installed");
    this.name = "ReaNotInstalledError";
  }
}

/**
 * `node <rea-agents>/scripts/rea.mjs mcp`: verified in docs/DESIGN.md section 1.2.
 * It runs under the gateway's own Node, directly, with no shell and no `npx` (which
 * would reach the network at start).
 */
export function productionLaunch(env: Environment): ReaLaunch {
  let script: string;
  try {
    const manifest = createRequire(import.meta.url).resolve("rea-agents/package.json");
    script = join(dirname(manifest), "scripts", "rea.mjs");
  } catch {
    throw new ReaNotInstalledError();
  }
  if (!existsSync(script)) throw new ReaNotInstalledError();
  return { command: process.execPath, args: [script, "mcp"], env: childEnvironment(env) };
}
