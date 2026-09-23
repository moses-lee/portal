import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();

// Node ends the process on an unhandled rejection, which would take every agent and terminal with
// it. Log instead and keep serving, as Next's server did for the single app: the failed operation
// has already failed, and a restart would not bring it back. Uncaught exceptions are logged and
// kept alive too, for the same parity (an error from one socket or pty must not end every session).
let app: FastifyInstance | null = null;
const logError = (message: string) => (err: unknown) => {
  if (app) app.log.error({ err }, message);
  else console.error(message, err);
};
process.on("unhandledRejection", logError("Unhandled promise rejection"));
process.on("uncaughtException", logError("Uncaught exception"));

try {
  app = await buildApp({ config, logger: true });
} catch (err) {
  // Most often another server holds the database, or the legacy import failed; the message says which.
  console.error(`Portal server did not start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const server = app;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  server.log.info({ signal }, "shutting down");
  // The app's preClose ends the event streams and stops the services first; a request that is
  // still running (a long script, a model call) must not keep the process alive past a grace period.
  setTimeout(() => process.exit(0), 1500).unref();
  await server.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ port: config.port, host: config.host });
} catch (err) {
  // EADDRINUSE and the like: stop the services the boot started and hand back the database.
  server.log.error({ err }, "Portal server could not listen");
  setTimeout(() => process.exit(1), 1500).unref();
  await server.close().catch(() => {});
  process.exit(1);
}
