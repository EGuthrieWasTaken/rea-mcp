// Entry point. The gateway is wired up task by task (authentication, sessions),
// following openspec/changes/bootstrap-rea-mcp-gateway/tasks.md.
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createKeyVerifier } from "./auth.js";
import { createGatewayServer, listen, shutdown } from "./http/server.js";
import { createFailureLimiter } from "./http/ratelimit.js";
import { KeyError, loadKeys } from "./keys.js";
import { createLogger } from "./logger.js";

// A closed stdout (for example a log pipe that went away) must not crash us.
process.stdout.on("error", () => undefined);

async function main(): Promise<void> {
  // Configuration is not known yet, so startup problems are logged at the default level.
  const startupLog = createLogger("info");
  let config: Config;
  let keys: readonly string[];
  try {
    config = loadConfig(process.env);
    keys = loadKeys(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      startupLog.error("invalid configuration", { variable: error.variable, reason: error.message });
    } else if (error instanceof KeyError) {
      startupLog.error("cannot start without a usable API key", {
        variable: error.variable,
        reason: error.message,
      });
    } else {
      throw error;
    }
    // Nothing is listening: refusal happens before the port is opened.
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  // Only digests of the keys are kept from here on.
  const limiter = createFailureLimiter();
  const server = createGatewayServer({
    logger,
    verifier: createKeyVerifier(keys),
    limiter,
    allowedHosts: config.allowedHosts,
    trustProxy: config.trustProxy,
  });

  // Handlers go in before the port opens, so there is no moment at which a signal
  // meets the default action (an abrupt exit) instead of a clean shutdown.
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { reason: signal });
    void shutdown(server).then(() => {
      limiter.close();
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  try {
    await listen(server, config.port);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    logger.error("cannot listen", { port: config.port, reason: code });
    process.exitCode = 1;
    return;
  }
  // A signal that arrived while the port was opening: finish what it asked for.
  if (stopping) {
    await shutdown(server);
    return;
  }
  logger.info("listening", { port: config.port });
  logger.warn("the MCP endpoint is not wired up in this build; /mcp answers 404");
}

void main();
