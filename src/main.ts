// Entry point: validate everything, then listen. Nothing is opened until the
// configuration, the keys, the work directory and REA itself have all checked out.
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createKeyVerifier } from "./auth.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createFailureLimiter } from "./http/ratelimit.js";
import { createGatewayServer, listen, shutdown } from "./http/server.js";
import { KeyError, loadKeys } from "./keys.js";
import { createLogger } from "./logger.js";
import { productionLaunch, ReaNotInstalledError, type ReaLaunch } from "./rea/launch.js";
import { SessionManager } from "./sessions/manager.js";
import { shutdownTiming } from "./sessions/timing.js";

// A closed stdout (for example a log pipe that went away) must not crash us.
process.stdout.on("error", () => undefined);

const errorCode = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown error";

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

  // Sessions get their working directories here. Say so plainly if it cannot be used,
  // rather than failing obscurely on the first session.
  const sessionsDir = join(config.workDir, "sessions");
  try {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    accessSync(sessionsDir, constants.W_OK);
  } catch (error) {
    logger.error("the work directory is not usable", {
      reason: `${config.workDir} is not writable (${errorCode(error)})`,
    });
    process.exitCode = 1;
    return;
  }

  let launch: ReaLaunch;
  try {
    launch = productionLaunch(process.env);
  } catch (error) {
    if (!(error instanceof ReaNotInstalledError)) throw error;
    logger.error("cannot find REA", { reason: error.message });
    process.exitCode = 1;
    return;
  }

  const { graceMs, budgetMs } = shutdownTiming(config.checkpointDir !== undefined);

  // Only digests of the keys are kept from here on.
  const limiter = createFailureLimiter();
  const sessions = new SessionManager({
    logger,
    launch,
    sessionsDir,
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.sessionIdleTimeoutSec * 1000,
    terminationGraceMs: graceMs,
  });
  const server = createGatewayServer({
    logger,
    verifier: createKeyVerifier(keys),
    limiter,
    mcp: sessions.handler,
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
    // No new sessions from here on; the server stops accepting connections, the live
    // sessions are stopped in parallel, and only then are the remaining connections cut.
    sessions.beginShutdown();
    // The sequence guarantees a SIGKILL within grace + 2 s, so this is a safety net only.
    const deadline = setTimeout(() => {
      logger.error("shutdown deadline exceeded", { reason: `${budgetMs} ms` });
      process.exit(1);
    }, budgetMs);
    deadline.unref();
    void shutdown(server, () => sessions.closeAll()).then(() => {
      clearTimeout(deadline);
      limiter.close();
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  try {
    await listen(server, config.port);
  } catch (error) {
    logger.error("cannot listen", { port: config.port, reason: errorCode(error) });
    process.exitCode = 1;
    return;
  }
  // A signal that arrived while the port was opening: finish what it asked for.
  if (stopping) {
    await shutdown(server);
    return;
  }
  logger.info("listening", { port: config.port });
}

void main();
