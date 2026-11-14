import { spawnSync } from "node:child_process";
import { BUILT_MAIN } from "./paths.js";

export interface LogLine {
  time?: string;
  level?: string;
  message?: string;
  [field: string]: unknown;
}

/** Parse stdout as JSON lines; throws if any non-empty line is not a JSON object. */
export const parseLogLines = (stdout: string): LogLine[] =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogLine);

/**
 * Start the real built entry point with exactly the given environment (plus PATH),
 * so the result cannot depend on the environment of the test runner.
 */
export const startGateway = (env: Record<string, string>) =>
  spawnSync(process.execPath, [BUILT_MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
