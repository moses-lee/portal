/**
 * Review sessions run unattended, and Claude Code asks before every shell command, so a review used
 * to stop on its first `gh pr view`. Portal now answers those requests itself when the step only
 * reads: the session must belong to an active review goal (the check job's `payload.review`), the
 * setting must be on and the goal must not have opted out, the tool call must be a read or search,
 * or a shell command the read-only checker behind `run_command` vouches for, and the agent must
 * offer an "allow once" option. Everything else waits for the user as before, and the review goal
 * raises its `session_waiting` item. Every answer is Portal's in the transcript (`by: "portal"`,
 * with the reason) and in the activity log.
 */
import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { PermissionAdvice, PermissionAdvisor, PermissionRequestView } from "../../lib/acp-runtime.ts";
import { classifyCommand } from "../approvals/shell.ts";
import type { OrchestratorHub } from "../hub.ts";
import { type ReviewWatch, reviewWatchOf } from "./review-watch.ts";

/** Tool kinds that only look: files read, searched, fetched from memory of the repo. */
const READ_KINDS = new Set<string>(["read", "search"]);

/** What the advisor reads of a tool call: its kind, its input, and its title for the log. */
export type ToolCallView = { kind?: string | null; rawInput?: unknown; title?: string | null };

/** The shell command a tool call would run, when it is one; Claude Code sends `{ command }`, Codex an argv. */
export function commandOf(toolCall: ToolCallView): string | null {
  if (toolCall.kind !== "execute") return null;
  const raw = toolCall.rawInput;
  if (!raw || typeof raw !== "object") return null;
  const command = (raw as { command?: unknown }).command;
  if (typeof command === "string") return command.trim() || null;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const argv = command as string[];
    // `bash -lc "<script>"`: the script is what runs.
    if (argv.length === 3 && /^(ba|z|)sh$/.test(argv[0].split("/").at(-1) ?? "") && /^-l?c$/.test(argv[1])) return argv[2].trim() || null;
    return argv.join(" ").trim() || null;
  }
  return null;
}

/**
 * Portal's answer to one request, or null when the step is not plainly read-only: the "allow once"
 * option for a read or search, or for a shell command the checker accepts. Never "allow always":
 * every later command is judged on its own.
 */
export function adviseReadOnly(toolCall: ToolCallView, options: readonly PermissionOption[]): PermissionAdvice | null {
  const once = options.find((option) => option.kind === "allow_once");
  if (!once) return null;
  if (toolCall.kind && READ_KINDS.has(toolCall.kind)) return { optionId: once.optionId, reason: `Portal allowed this ${toolCall.kind} step of the review: it only reads.` };
  const command = commandOf(toolCall);
  if (!command) return null;
  const verdict = classifyCommand(command);
  if (!verdict.readOnly) return null;
  return { optionId: once.optionId, reason: "Portal allowed this command of the review: it only reads." };
}

/** The active review goal (its check job's watch) that started `sessionId`, if any. */
export async function reviewWatchForSession(hub: OrchestratorHub, sessionId: string): Promise<{ watch: ReviewWatch; intentId: string | null } | null> {
  for (const job of await hub.jobs.listJobs({ kind: ["intent_check"], status: ["active"] })) {
    const watch = reviewWatchOf(job.payload);
    if (watch?.sessions.some((session) => session.sessionId === sessionId)) return { watch, intentId: job.intentId ?? null };
  }
  return null;
}

/** The advisor the orchestrator installs on the sessions runtime. */
export function createReviewPermissionAdvisor(hub: OrchestratorHub): PermissionAdvisor {
  return async (request: PermissionRequestView) => {
    const settings = await hub.settings.orchestrator();
    if (!settings.reviews.answerReadOnly) return null;
    const review = await reviewWatchForSession(hub, request.sessionId);
    if (!review || review.watch.answerPermissions === false) return null;
    const advice = adviseReadOnly(request.toolCall, request.options);
    if (!advice) return null;
    const session = review.watch.sessions.find((entry) => entry.sessionId === request.sessionId);
    void hub.activity.log({
      actor: "system", kind: "session.permission_answered",
      summary: `Allowed a read-only step of the review of ${review.watch.repo}#${session?.pr ?? "?"}: ${oneLine(request.toolCall.title ?? "", 140)}`,
      refs: { sessionId: request.sessionId, ...(review.intentId ? { intentId: review.intentId } : {}) },
      detail: { requestId: request.requestId, optionId: advice.optionId, kind: request.toolCall.kind ?? null, command: commandOf(request.toolCall) },
    });
    return advice;
  };
}

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
