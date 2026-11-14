// Entry point. The gateway is wired up task by task (keys, logger, HTTP server,
// sessions), following openspec/changes/bootstrap-rea-mcp-gateway/tasks.md.
import { ConfigError, loadConfig } from "./config.js";

function main(): void {
  try {
    loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`rea-mcp: invalid configuration: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  // Until the server exists this exits non-zero, so nothing can run without
  // authentication by accident.
  process.stderr.write("rea-mcp: the gateway is not wired up yet\n");
  process.exitCode = 1;
}

main();
