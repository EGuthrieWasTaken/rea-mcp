// Entry point. The gateway is wired up task by task (logger, HTTP server,
// sessions), following openspec/changes/bootstrap-rea-mcp-gateway/tasks.md.
import { ConfigError, loadConfig } from "./config.js";
import { KeyError, loadKeys } from "./keys.js";

function fail(message: string): void {
  process.stderr.write(`rea-mcp: ${message}\n`);
  process.exitCode = 1;
}

function main(): void {
  try {
    loadConfig(process.env);
    loadKeys(process.env);
  } catch (error) {
    if (error instanceof ConfigError) return fail(`invalid configuration: ${error.message}`);
    if (error instanceof KeyError) return fail(`cannot start without a usable API key: ${error.message}`);
    throw error;
  }
  // Until the server exists this exits non-zero, so nothing can run without
  // authentication by accident.
  fail("the gateway is not wired up yet");
}

main();
