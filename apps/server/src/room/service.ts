/**
 * The room (docs/PALACE.md): the environment and the census as one `RoomState`, for the routes and
 * the portal stream. Built in `buildApp` with or without the orchestrator; the stream bridge lives
 * there too, so a server without the orchestrator still answers the routes.
 */
import type { RoomState } from "@portal/contracts/room";
import { LAYOUT_VERSION } from "@portal/shared/room";
import type { AppContext } from "../context.ts";
import { type RoomCensusService, createRoomCensus } from "./census.ts";
import { type RoomEnvironmentOptions, type RoomEnvironmentService, createRoomEnvironment } from "./environment.ts";

export type RoomOptions = RoomEnvironmentOptions;

export interface RoomService {
  environment: RoomEnvironmentService;
  census: RoomCensusService;
  /** The state now, without waiting on the network (a stale environment refreshes in the background). */
  state(): Promise<RoomState>;
  /** Refresh the environment past its caches, then answer the state. */
  refresh(): Promise<RoomState>;
  /** Called with the whole state whenever the environment changes; answers the unsubscribe function. */
  subscribe(listener: (state: RoomState) => void): () => void;
  dispose(): void;
}

export function createRoomService(ctx: Pick<AppContext, "config" | "log" | "sessions">, options: RoomOptions = {}): RoomService {
  const environment = createRoomEnvironment({ config: ctx.config, log: ctx.log }, options);
  const census = createRoomCensus(ctx);

  async function assemble(env = environment.current()): Promise<RoomState> {
    const [counts, milestones] = await Promise.all([census.read(), census.milestones()]);
    return { environment: env, census: counts, milestones, layoutVersion: LAYOUT_VERSION };
  }

  return {
    environment,
    census,
    state: () => assemble(),
    refresh: async () => assemble(await environment.refresh({ force: true })),
    subscribe(listener) {
      return environment.subscribe((env) => {
        assemble(env).then(listener, (err: unknown) => ctx.log.warn(`Room: could not build the state (${err instanceof Error ? err.message : String(err)}).`));
      });
    },
    dispose: () => environment.dispose(),
  };
}
