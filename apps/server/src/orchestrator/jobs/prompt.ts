/**
 * What the model reads about jobs and intents: `guidance`, appended to every turn's system prompt
 * by `prompt.ts`, and the prompts of the turns jobs run (an intent check, a helper).
 */
import type { HelperPayload, Intent } from "@portal/contracts/jobs";

export const guidance = `Background work is yours to schedule, at the cadence you judge right:
- "Tell me when X" or "keep an eye on Y": create_intent (the user's words, a precise trigger, the action, a check cadence that fits: minutes for a PR under review, hours for slow things). Its checks fire it; do not poll by hand.
- Later or recurring work that is not a condition: schedule_job. A side task now: run_helper (wait: true when you need the answer in this turn).
- Change the tick's cadence (update_job "tick") only when asked. Cancel intents and jobs once they are no longer needed.`;

const when = (at: number | null) => (at === null ? "never" : new Date(at).toISOString());

/** The single user message of an intent check. */
export function intentCheckPrompt(intent: Intent, now: number): string {
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
    `Fired ${intent.fires} time(s) (budget: ${budget}); last fired ${when(intent.lastFiredAt)}; last checked ${when(intent.lastCheckedAt)}; expires ${when(intent.expiresAt)}.`,
    "",
    "Notes so far:",
    intent.notes.trim() || "(none)",
    "",
    "Do this:",
    "1. Check the trigger with the read-only tools (get_pull, list_sessions, read_transcript, ...). Look only at what the trigger needs.",
    "2. If the trigger holds, call fire_intent with a title and a short body for the user; the server may refuse (cooldown, budget, expiry), and then you stop. After it fired, carry out the action (send_prompt to a session, update an item) as far as the tools allow.",
    "3. Rewrite the notes with update_intent when your understanding changed (what you saw, what is left). Call close_intent when the intent is fulfilled or can never fire.",
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
