/**
 * The room (docs/PALACE.md): the environment and the census as one `RoomState`, for the routes and
 * the portal stream. Built in `buildApp` with or without the orchestrator; the stream bridge lives
 * there too, so a server without the orchestrator still answers the routes.
 */
import type { RoomEnvironment, RoomState } from "@portal/contracts/room";
import { LAYOUT_VERSION } from "@portal/shared/room";
import type { AppContext } from "../context.ts";
import { type RoomCensusOptions, type RoomCensusService, createRoomCensus } from "./census.ts";
import { type RoomEnvironmentOptions, type RoomEnvironmentService, createRoomEnvironment } from "./environment.ts";

/** `now` is shared by the environment and the census. */
export type RoomOptions = RoomEnvironmentOptions & Pick<RoomCensusOptions, "settleMs" | "censusEveryMs">;

export interface RoomService {
  environment: RoomEnvironmentService;
  census: RoomCensusService;
  /** The state now, without waiting on the network (a stale environment refreshes in the background). */
  state(): Promise<RoomState>;
  /** Refresh the environment and recount the census past their caches, then answer the state. */
  refresh(): Promise<RoomState>;
  /** Called with the whole state whenever the environment or the census changes; answers the unsubscribe function. */
  subscribe(listener: (state: RoomState) => void): () => void;
  dispose(): void;
}

export function createRoomService(
  ctx: Pick<AppContext, "config" | "db" | "log" | "presence" | "sessions"> & { orchestrator?: AppContext["orchestrator"] },
  { settleMs, censusEveryMs, ...options }: RoomOptions = {},
): RoomService {
  const environment = createRoomEnvironment({ config: ctx.config, log: ctx.log }, options);
  const census = createRoomCensus(ctx, { now: options.now, settleMs, censusEveryMs });

  async function assemble(env = environment.current()): Promise<RoomState> {
    const { census: counts, milestones } = await census.current();
    return { environment: env, census: counts, milestones, layoutVersion: LAYOUT_VERSION };
  }

  return {
    environment,
    census,
    state: () => assemble(),
    refresh: async () => {
      const [env] = await Promise.all([environment.refresh({ force: true }), census.current({ force: true })]);
      return assemble(env);
    },
    subscribe(listener) {
      const push = (env: RoomEnvironment) => {
        assemble(env).then(listener, (err: unknown) => ctx.log.warn(`Room: could not build the state (${err instanceof Error ? err.message : String(err)}).`));
      };
      const offEnvironment = environment.subscribe(push);
      const offCensus = census.subscribe(() => push(environment.current()));
      return () => {
        offEnvironment();
        offCensus();
      };
    },
    dispose: () => {
      environment.dispose();
      census.dispose();
    },
  };
}
