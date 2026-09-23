/**
 * Approvals: the deterministic gate in front of anything irreversible or outbound. The server,
 * not a model, decides what needs one (destructive tools, shell commands outside the read-only
 * allowlist, anything that leaves the machine, server-side card actions carrying agent-written
 * text). A request is its own record and its own event and dialog; it is never a chat message, so
 * text injected into a transcript cannot forge or answer one.
 *
 * Granting can cover more than the one call: `job` covers the same tool for the rest of the job
 * (or intent) that asked, `repo` for one repository, `always` for the tool everywhere. Grants are
 * listed and revocable.
 *
 * In a chat turn the tool call waits for the decision for a while, then reports "pending" and the
 * approved call runs server-side later. In a job the run pauses (`awaiting_approval`) and a
 * Needs-you item links to the request; approving runs the recorded call and resumes the job.
 *
 * HTTP surface:
 *   GET    /api/portal/approvals?status=<s>          { approvals }   (default: pending)
 *   POST   /api/portal/approvals/:id/decide          body ApprovalDecision -> { approval }
 *   GET    /api/portal/approvals/grants               { grants }
 *   DELETE /api/portal/approvals/grants/:id           -> 204 (revoke)
 * Live: `{ type: "approvals", approvals }` with every pending request whenever the set changes.
 */

export type ApprovalScope = "once" | "job" | "repo" | "always";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
/** Why it needs approval. */
export type ApprovalRisk = "write" | "destructive" | "outbound";
export type ApprovalOrigin = "chat" | "job" | "card";

export type Approval = {
  id: string;
  status: ApprovalStatus;
  /** The tool (or card action type) that asked. */
  tool: string;
  /** Short: "Remove worktree feat-x of portal". */
  title: string;
  /** Exactly what will happen, in Markdown: the command, the prompt text, the paths. */
  summary: string;
  /** The recorded call; executing an approval replays exactly this. */
  input: Record<string, unknown>;
  risk: ApprovalRisk;
  origin: ApprovalOrigin;
  /** "owner/name" the call acts on, when there is one; a `repo` grant matches on it. */
  repo: string | null;
  threadId: string | null;
  runId: string | null;
  jobId: string | null;
  intentId: string | null;
  itemId: string | null;
  requestedAt: number;
  /** Pending requests expire; an expired one never runs. */
  expiresAt: number;
  decidedAt: number | null;
  decision: { approve: boolean; scope: ApprovalScope } | null;
  /** The executed call's output (or its error), once it ran. */
  result: unknown;
  error: string | null;
};

export type ApprovalDecision = { approve: boolean; scope?: ApprovalScope };

export type ApprovalGrant = {
  id: string;
  tool: string;
  scope: Exclude<ApprovalScope, "once">;
  jobId: string | null;
  intentId: string | null;
  repo: string | null;
  approvalId: string;
  createdAt: number;
  revokedAt: number | null;
};
