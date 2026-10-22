/**
 * `/api/monitoring/**` (docs/MONITORING.md): the snapshot the Monitoring view polls, the disk
 * refresh, and the manual process stop. Reads are not origin-checked, like the other GETs; the
 * actions are.
 */
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { FOLDER_CHECK_MAX, type FolderCheckResult } from "@portal/contracts/monitoring";
import { expandHome } from "@portal/shared/monitoring";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";

export function registerMonitoringRoutes(app: FastifyInstance, ctx: AppContext) {
  /**
   * `GET /api/monitoring` — `MonitoringSnapshot`: the latest sample and the 24 h history, the
   * attributed process table (read at most once per 5 s), the session and worktree rows, and the
   * cached disk survey with its age. Starts a survey when the cached one is older than 10 minutes.
   */
  app.get("/api/monitoring", async () => ctx.monitoring.snapshot());

  /** `POST /api/monitoring/disk/refresh` — starts a disk survey now (or joins the running one) -> `{ disk: MonitoringDisk }`. */
  app.post("/api/monitoring/disk/refresh", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    return { disk: ctx.monitoring.refreshDisk() };
  });

  /**
   * `POST /api/monitoring/processes/:pid/stop` — SIGTERM to the process (its group, when it leads
   * one), SIGKILL after 5 s -> `{ pid, target: "group" | "process" }`. 404 when the pid is not in the
   * latest process table, 403 when nothing is charged with it or the signal would reach the server.
   */
  app.post<{ Params: { pid: string } }>("/api/monitoring/processes/:pid/stop", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const pid = Number(req.params.pid);
    if (!/^\d+$/.test(req.params.pid) || !Number.isSafeInteger(pid)) return reply.code(400).send({ error: "Expected a numeric pid." });
    return ctx.monitoring.stopProcess(pid);
  });

  /**
   * `POST /api/monitoring/folders/check` `{ paths: string[] }` -> `FolderCheckResult`: whether each
   * folder exists now (one `stat` each, `~` expanded), for the watched-folder warning in Settings,
   * without waiting for a disk survey. At most 20 paths.
   */
  app.post<{ Body: { paths?: unknown } }>("/api/monitoring/folders/check", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || !paths.every((entry): entry is string => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 4096)) {
      return reply.code(400).send({ error: "Expected { paths: string[] }." });
    }
    if (paths.length > FOLDER_CHECK_MAX) return reply.code(400).send({ error: `At most ${FOLDER_CHECK_MAX} paths.` });
    const home = os.homedir();
    const result: FolderCheckResult = {
      paths: await Promise.all(
        paths.map(async (given) => {
          const expanded = expandHome(given.trim(), home);
          // Only an absolute path names a folder; a relative one would be read against the server's cwd.
          const exists = path.isAbsolute(expanded) && (await stat(expanded).then((info) => info.isDirectory(), () => false));
          return { path: given, expanded, exists };
        }),
      ),
    };
    return result;
  });
}
