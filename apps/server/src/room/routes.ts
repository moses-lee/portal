/**
 * `/api/room/**` (docs/PALACE.md): the room's state for the background scene and the Settings
 * dialog. Reads are not origin-checked, like the other GETs outside the portal routes; the refresh
 * is.
 */
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { rejectCrossOrigin } from "../http/origin.ts";

export function registerRoomRoutes(app: FastifyInstance, ctx: AppContext) {
  /** `GET /api/room` — `RoomState`. The first read starts the environment's resolution; until it lands `source` is "none". */
  app.get("/api/room", async () => ctx.room.state());

  /** `GET /api/room/environment` — `RoomEnvironment`, for debugging and the window's hover card. */
  app.get("/api/room/environment", async () => ctx.room.environment.current());

  /** `POST /api/room/refresh` — looks the location and weather up again past their caches, then answers `RoomState`. */
  app.post("/api/room/refresh", async (req, reply) => {
    if (rejectCrossOrigin(req, reply)) return reply;
    return ctx.room.refresh();
  });
}
