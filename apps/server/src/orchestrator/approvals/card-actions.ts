/**
 * Running a server-side card action (start a session, send a prompt, remove a worktree). One code
 * path for both callers: `performAction` when the button needs no approval, and the approvals
 * service when an approved action is replayed, so an approved click does exactly what an
 * unguarded one would have.
 */
import type { OrchestratorHub } from "../hub.ts";
import { removeProject, requireSession, startSession } from "../ops.ts";
import type { Item, ItemAction } from "../types.ts";

export type ServerAction = Extract<ItemAction, { type: "start_session" | "send_prompt" | "remove_worktree" }>;
export type ActionOutcome = { sessionId?: string; promptError?: string };

export function isServerAction(action: ItemAction): action is ServerAction {
  return action.type === "start_session" || action.type === "send_prompt" || action.type === "remove_worktree";
}

/**
 * Run `action` and log it as the user's (they clicked it, and approved it when it asked). `item`
 * is the card it came from, or null when the card is gone by the time an approval replays it.
 */
export async function runItemAction(
  hub: Pick<OrchestratorHub, "deps" | "activity">,
  item: Pick<Item, "id" | "title" | "links"> | null,
  action: ServerAction,
  extraRefs: { approvalId?: string } = {},
): Promise<ActionOutcome> {
  const { deps } = hub;
  let outcome: ActionOutcome = {};
  switch (action.type) {
    case "start_session":
      // The session exists even when its prompt failed; the caller gets both facts.
      outcome = await startSession(deps, { projectId: action.projectId, agentId: action.agentId, prompt: action.prompt });
      break;
    case "send_prompt":
      // Cards stored before ids were kept full may carry a prefix.
      await deps.sessions.prompt((await requireSession(deps, action.sessionId)).id, action.prompt);
      break;
    case "remove_worktree":
      await removeProject(deps, { id: action.projectId, deleteWorktree: true });
      break;
  }
  const links = item?.links ?? {};
  void hub.activity.log({
    actor: "user", kind: "item.action", summary: `Ran "${action.label ?? action.type}"${item ? ` on ${item.title}` : ""}`,
    refs: {
      ...(item ? { itemId: item.id } : {}), ...(links.projectId ? { projectId: links.projectId } : {}),
      ...(outcome.sessionId ?? links.sessionId ? { sessionId: outcome.sessionId ?? links.sessionId } : {}), ...extraRefs,
    },
    detail: { action: action.type, ...(outcome.promptError ? { promptError: outcome.promptError } : {}) },
  });
  return outcome;
}
