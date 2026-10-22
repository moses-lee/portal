/**
 * The idle CLI stop's wiring (docs/MONITORING.md, "Idle CLI stop"): the runtime does the stopping
 * (`stopIdleClis`); this follows the user's `sessions.idleStop` settings and records every automatic
 * stop in Activity as `session.cli_stopped_idle`, the way the lifecycle sweep records an idle
 * worktree removal. A stop someone asked for (`POST /api/sessions/:id/stop-cli`) is not logged.
 */
import type { ActivityInput } from "@portal/contracts/activity";
import type { Settings } from "@portal/shared/settings";
import type { AppContext } from "../context.ts";
import type { CliStop, Session } from "../lib/acp-runtime.ts";

/** "2h 5m", "45m": an idle time as Activity reads it. */
export function idleLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** The Activity entry for an automatic stop. */
export function idleStopActivity(session: Pick<Session, "id" | "projectId" | "agentId" | "agentName" | "title">, stop: CliStop): ActivityInput {
  const name = session.title ? `“${session.title}”` : "an untitled session";
  return {
    actor: "system",
    kind: "session.cli_stopped_idle",
    summary: `Stopped ${session.agentName} for ${name} after ${idleLabel(stop.idleMs)} idle; the next message starts it again`,
    refs: { sessionId: session.id, ...(session.projectId ? { projectId: session.projectId } : {}) },
    detail: { agentId: session.agentId, idleMinutes: Math.round(stop.idleMs / 60_000), afterMinutes: Math.round(stop.afterMs / 60_000) },
  };
}

/** The runtime's idle stop settings from the user's settings. */
export function idleStopOptions(settings: Settings) {
  return { enabled: settings.sessions.idleStop.enabled, afterMs: settings.sessions.idleStop.afterMinutes * 60_000 };
}

/**
 * Apply the user's idle stop settings now and on every change, and log automatic stops to Activity
 * (when the orchestrator, which owns the log, runs). Returns the function that undoes both.
 */
export async function wireIdleStop(ctx: Pick<AppContext, "sessions" | "settings" | "log"> & { orchestrator?: AppContext["orchestrator"] }): Promise<() => void> {
  const apply = (settings: Settings) => ctx.sessions.setIdleStopOptions(idleStopOptions(settings));
  apply(await ctx.settings.read());
  const unsubscribeSettings = ctx.settings.subscribe(apply);
  const unsubscribeStops = ctx.sessions.onCliStopped((stop) => {
    if (!stop.automatic) return;
    const session = ctx.sessions.getSession(stop.sessionId);
    const activity = ctx.orchestrator?.hub.activity;
    if (!session || !activity) return;
    activity.log(idleStopActivity(session, stop)).catch((err: unknown) => ctx.log.error({ err }, "Could not log an idle CLI stop"));
  });
  return () => {
    unsubscribeSettings();
    unsubscribeStops();
  };
}
