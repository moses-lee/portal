/**
 * `/api/monitoring/**` (docs/MONITORING.md): the snapshot the Monitoring view polls, the disk
 * refresh, and the manual process stop. Reads are not origin-checked, like the other GETs; the
 * actions are.
 */
import type { FastifyInstance } from "fastify";
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
}
