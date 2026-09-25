/**
 * What the model reads about jobs and intents: `guidance`, appended to every turn's system prompt
 * by `prompt.ts`, and the prompts of the turns jobs run (an intent check, a helper).
 */
import type { HelperPayload, Intent } from "@portal/contracts/jobs";
import type { SessionMeta } from "../../lib/types.ts";
import { snapshotActivity } from "../digest.ts";
import { matchId } from "../ids.ts";
import { livenessGuidance } from "../world/prompt.ts";

export const guidance = `Background work is yours to schedule, at the cadence you judge right:
- "Monitor PR N" or "tell me when N merges": monitor_pull (no model runs its checks; it reports state changes only and ends when the PR merges or closes). "Stop monitoring N": cancel_intent with pull.
- Any other "tell me when X" or "keep an eye on Y": create_intent (the user's words, a precise trigger, the action, a check cadence that fits: minutes for a PR under review, hours for slow things). Its checks fire it; do not poll by hand.
- Later or recurring work that is not a condition: schedule_job. A side task now: run_helper (wait: true when you need the answer in this turn).
- Cancel intents and jobs once they are no longer needed.
- When the user corrects what an intent reported, or its premise proves wrong, update_intent its notes (or cancel_intent) in the same turn, before its next check repeats the mistake.`;

const when = (at: number | null) => (at === null ? "never" : new Date(at).toISOString());

/** Each scoped session as Portal sees it at the check, so a failed lookup is never mistaken for a deleted session. */
function sessionRows(ids: string[], sessions: SessionMeta[] | null): string[] {
  if (!sessions) return ["- Portal could not read its sessions this time: conclude nothing about them from this check."];
  return ids.map((id) => {
    const { candidates: found } = matchId(sessions, id);
    if (found.length > 1) return `- ${id}: matches ${found.length} sessions; resolve_session tells which.`;
    if (found.length === 0) return `- ${id}: not among Portal's ${sessions.length} sessions right now.`;
    const [session] = found;
    // Liveness says whether the agent is moving; lastActiveAt is only the user's last prompt.
    const liveness = session.liveness ? ` · ${session.liveness.summary}` : "";
    return `- ${session.id} "${session.title ?? "untitled"}" · ${session.agentName} · ${snapshotActivity(session)} · link ${session.link.status}${liveness} · last prompt ${when(session.lastActiveAt)}`;
  });
}

/** The single user message of an intent check; `sessions` is Portal's session list read for it (null when it could not be read). */
export function intentCheckPrompt(intent: Intent, now: number, sessions: SessionMeta[] | null = null): string {
  const scope = [
    intent.scope.pulls.length ? `PRs ${intent.scope.pulls.map((pull) => `${pull.repo}#${pull.number}`).join(", ")}` : "",
    intent.scope.sessionIds.length ? `sessions ${intent.scope.sessionIds.join(", ")}` : "",
    intent.scope.projectIds.length ? `projects ${intent.scope.projectIds.join(", ")}` : "",
    intent.scope.repos.length ? `repos ${intent.scope.repos.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  const budget = intent.fireBudget === null ? "unlimited" : `${intent.fireBudget - intent.fires} of ${intent.fireBudget} left`;
  return [
    `Intent check at ${when(now)} for intent ${intent.id}.`,
    `The user asked: "${intent.text}"`,
    `Trigger: ${intent.trigger}`,
    `Action when it fires: ${intent.action}`,
    ...(scope ? [`Scope: ${scope}`] : []),
    `Fired ${intent.fires} time(s) (budget: ${budget}); last fired ${when(intent.lastFiredAt)}${intent.lastFiredTitle ? ` ("${intent.lastFiredTitle}")` : ""}; last checked ${when(intent.lastCheckedAt)}; expires ${when(intent.expiresAt)}.`,
    ...(intent.scope.sessionIds.length ? ["", "Scoped sessions as Portal sees them now (live state, not a lookup):", ...sessionRows(intent.scope.sessionIds, sessions)] : []),
    "",
    "Notes so far:",
    intent.notes.trim() || "(none)",
    "",
    "Do this:",
    "1. Check the trigger with the read-only tools (get_pull, list_sessions, read_transcript, ...). Look only at what the trigger needs. A failed lookup is not proof something is gone: before reporting a session deleted or missing, confirm it with the list above and resolve_session or list_sessions.",
    `   ${livenessGuidance}`,
    "2. Fire on change, not on state: call fire_intent only when something new happened since the last firing (the notes say what was reported). A condition already reported that still holds is not news: reply NO_UPDATE. The server refuses a repeat of the last firing, and during the cooldown, past the budget, or after expiry; then you stop. After it fired, carry out the action (send_prompt to a session, update an item) as far as the tools allow.",
    "3. Rewrite the notes with update_intent when your understanding changed: what you saw (observations, not guesses), what you reported and when, what is left. Call close_intent when the intent is fulfilled or can never fire.",
    "4. Reply with one or two sentences for the user's thread when the intent fired, else with exactly NO_UPDATE.",
  ].join("\n");
}

/** The single user message of a helper sub-turn. */
export function helperPrompt(payload: Pick<HelperPayload, "prompt">): string {
  return [
    "You are running as a helper: a bounded sub-task Portal started. Nobody reads your intermediate steps.",
    "Do the task below with the tools you have, then answer with the result only: concise, factual, in Markdown without headers.",
    "",
    payload.prompt.trim(),
  ].join("\n");
}
