// Entry point. The gateway is wired up task by task (HTTP server, sessions),
// following openspec/changes/bootstrap-rea-mcp-gateway/tasks.md.
import { ConfigError, loadConfig } from "./config.js";
import { KeyError, loadKeys } from "./keys.js";
import { createLogger } from "./logger.js";

// A closed stdout (for example a log pipe that went away) must not crash us.
process.stdout.on("error", () => undefined);

function main(): void {
  // Configuration is not known yet, so startup problems are logged at the default level.
  const startupLog = createLogger("info");
  try {
    loadConfig(process.env);
    loadKeys(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      startupLog.error("invalid configuration", { variable: error.variable, reason: error.message });
      process.exitCode = 1;
      return;
    }
    if (error instanceof KeyError) {
      startupLog.error("cannot start without a usable API key", {
        variable: error.variable,
        reason: error.message,
      });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  // Until the server exists this exits non-zero, so nothing can run without
  // authentication by accident.
  startupLog.error("the gateway is not wired up yet");
  process.exitCode = 1;
}

main();
