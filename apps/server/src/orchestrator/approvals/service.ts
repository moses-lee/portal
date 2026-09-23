/**
 * Approvals: the deterministic gate in front of anything irreversible or outbound (see
 * `policy.ts` for what is gated and why). A request is a record, an event and a dialog, never a
 * chat message, so nothing a model reads or writes can forge or answer one; only `decide`
 * (behind the same-origin route) does.
 *
 * `gate` wraps the gated tools of a turn. A call covered by a grant runs at once and is logged.
 * Otherwise a pending request is recorded: a chat turn waits a while for the user and then reports
 * the result, the refusal, or "pending"; a background job gets "pending" at once and a Needs-you
 * item links to the request. `decide` records the answer (and a grant for wider scopes), replays
 * the recorded call server-side on approval (rebuilding the tool from a plain context, so it works
 * after a restart too), notes the outcome in the originating thread, resolves the Needs-you item,
 * and resumes the job that asked. Pending requests expire; an expired one never runs.
 */
import { randomUUID } from "node:crypto";
import type { Approval, ApprovalDecision, ApprovalGrant, ApprovalOrigin, ApprovalScope, ApprovalStatus } from "@portal/contracts/approvals";
import type { Tool } from "ai";
import type { ActivityRefs } from "@portal/contracts/activity";
import type { ApprovalsService, DomainToolContext, OrchestratorHub, ToolSet } from "../hub.ts";
import { httpError } from "../ops.ts";
import { type ToolContext, createTools } from "../tools/index.ts";
import type { Item, ItemAction } from "../types.ts";
import { isServerAction, runItemAction } from "./card-actions.ts";
import { createPgApprovalStore } from "./pg-store.ts";
import { type Assessment, assessCardAction, assessToolCall, block, isGatedTool } from "./policy.ts";
import { type ApprovalFilter, type ApprovalStore, createMemoryApprovalStore } from "./store.ts";

/** How long a chat turn's gated call waits for the user before it reports "pending". */
export const CHAT_WAIT_MS = 2 * 60_000;
/** How long a request stays answerable, by where it came from. */
export const EXPIRY_MS: Record<ApprovalOrigin, number> = { chat: 60 * 60_000, card: 60 * 60_000, job: 24 * 60 * 60_000 };

const scopes: readonly ApprovalScope[] = ["once", "job", "repo", "always"];
const statuses: readonly ApprovalStatus[] = ["pending", "approved", "denied", "expired", "cancelled"];

export type ApprovalsOptions = {
  store?: ApprovalStore;
  chatWaitMs?: number;
  expiryMs?: Partial<Record<ApprovalOrigin, number>>;
};

/** The whole approvals domain: the hub's integration surface plus what the routes use. */
export interface ApprovalsDomain extends ApprovalsService {
  list(filter?: ApprovalFilter): Promise<Approval[]>;
  get(id: string): Promise<Approval | null>;
  decide(id: string, decision: ApprovalDecision): Promise<Approval>;
  grants(): Promise<ApprovalGrant[]>;
  revokeGrant(id: string): Promise<ApprovalGrant>;
  /** Expire what ran out of time now (also runs on its own timer and before every read). */
  expireDue(): Promise<Approval[]>;
}

export function isApprovalsDomain(service: ApprovalsService): service is ApprovalsDomain {
  return typeof (service as Partial<ApprovalsDomain>).decide === "function";
}

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (statuses as readonly string[]).includes(value);
}

export function isApprovalScope(value: unknown): value is ApprovalScope {
  return typeof value === "string" && (scopes as readonly string[]).includes(value);
}

type ToolOptions = Parameters<NonNullable<Tool["execute"]>>[1];
type Execute = (input: unknown, options: ToolOptions) => unknown;

/** A chat turn waiting on a request; `claimed` once the user decided, so it waits for the result instead of timing out. */
type Waiter = { resolve: (approval: Approval | null) => void; timer: unknown; claimed: boolean };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const outputError = (output: unknown): string | null =>
  output && typeof output === "object" && typeof (output as { error?: unknown }).error === "string" ? (output as { error: string }).error : null;

const scopeWords: Record<ApprovalScope, string> = { once: "once", job: "for this job", repo: "for this repository", always: "always" };

/** A stable key for "the same call": tool, context, and input with sorted keys. */
function callKey(tool: string, input: unknown, context: (string | null)[]): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
    return value;
  };
  return JSON.stringify([tool, context, sorted(input)]);
}

const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};

/** What the dialog says when the policy itself failed: the raw call, so the user still sees exactly what would run. */
function fallbackAssessment(tool: string, input: unknown): Assessment {
  return { risk: "write", title: `Run ${tool}`, summary: `Call \`${tool}\` with:\n\n${block(JSON.stringify(input, null, 2) ?? "null", "json")}`, repo: null };
}

export function createApprovalsService(hub: OrchestratorHub, options: ApprovalsOptions = {}): ApprovalsDomain {
  const store = options.store ?? (hub.db ? createPgApprovalStore({ db: hub.db }) : createMemoryApprovalStore());
  const chatWaitMs = options.chatWaitMs ?? CHAT_WAIT_MS;
  const expiry = { ...EXPIRY_MS, ...options.expiryMs };
  const waiters = new Map<string, Set<Waiter>>();
  let sweep: unknown = null;
  const now = () => hub.timers.now();

  const refsOf = (approval: Approval): ActivityRefs => ({
    approvalId: approval.id,
    ...(approval.runId ? { runId: approval.runId } : {}), ...(approval.threadId ? { threadId: approval.threadId } : {}),
    ...(approval.jobId ? { jobId: approval.jobId } : {}), ...(approval.intentId ? { intentId: approval.intentId } : {}),
    ...(approval.itemId ? { itemId: approval.itemId } : {}),
  });

  async function emitPending() {
    try {
      hub.emit({ type: "approvals", approvals: await store.list({ status: ["pending"] }) });
    } catch (err) {
      console.error("Could not publish the pending approvals:", err);
    }
  }

  const emitItems = () => hub.store.listItems().then((items) => hub.emit({ type: "items", items }), () => {});

  /** Plan the next expiry sweep at the earliest pending deadline; nothing is planned while none is pending. */
  async function scheduleSweep() {
    if (sweep !== null) hub.timers.clearTimeout(sweep);
    sweep = null;
    const pending = await store.list({ status: ["pending"], limit: 500 });
    if (pending.length === 0) return;
    const next = Math.min(...pending.map((approval) => approval.expiresAt));
    sweep = hub.timers.setTimeout(() => {
      sweep = null;
      void expireDue().then(scheduleSweep).catch((err: unknown) => console.error("Could not expire approvals:", err));
    }, Math.max(0, next - now()) + 1);
  }

  // ---------------------------------------------------------------------------------------------
  // Chat turns waiting for a decision
  // ---------------------------------------------------------------------------------------------

  function waitFor(id: string, ms: number, signal: AbortSignal | undefined): Promise<Approval | null> {
    return new Promise((resolve) => {
      const set = waiters.get(id) ?? new Set<Waiter>();
      waiters.set(id, set);
      const finish = (approval: Approval | null) => {
        if (!set.delete(waiter)) return;
        if (set.size === 0) waiters.delete(id);
        hub.timers.clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(approval);
      };
      const onAbort = () => finish(null);
      const waiter: Waiter = { resolve: finish, timer: null, claimed: false };
      waiter.timer = hub.timers.setTimeout(() => { if (!waiter.claimed) finish(null); }, ms);
      set.add(waiter);
      if (signal?.aborted) finish(null);
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The user decided: waiting turns keep waiting past their timeout, for the result. */
  function claimWaiters(id: string) {
    for (const waiter of waiters.get(id) ?? []) waiter.claimed = true;
  }

  /** Hand the final record to every waiting turn; true when one took it (so no thread note is needed). */
  function settleWaiters(approval: Approval): boolean {
    const set = waiters.get(approval.id);
    if (!set || set.size === 0) return false;
    for (const waiter of [...set]) waiter.resolve(approval);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Side effects of a request's life: thread notes, Needs-you items
  // ---------------------------------------------------------------------------------------------

  async function postNote(approval: Approval, text: string) {
    const threadId = approval.threadId;
    if (!threadId) return;
    try {
      await hub.store.appendMessages([{ id: randomUUID(), role: "assistant", parts: [{ type: "text", text }], metadata: { at: now() } }], threadId);
      hub.emit({ type: "messages", threadId });
    } catch (err) {
      console.error("Could not post an approval note:", err);
    }
  }

  const fingerprintOf = (approval: Approval) => `approval_needed:${approval.id}`;

  async function raiseNeedsYou(approval: Approval) {
    try {
      if (await hub.store.findItemByFingerprint(fingerprintOf(approval))) return;
      const body = `A background job is paused until you decide.\n\n${approval.summary}`;
      await hub.store.createItem({
        list: "needs_you", kind: "approval_needed", title: `Approve: ${approval.title}`.slice(0, 200),
        body: body.length > 2000 ? `${body.slice(0, 1999)}…` : body,
        links: {
          approvalId: approval.id, ...(approval.jobId ? { jobId: approval.jobId } : {}),
          ...(approval.intentId ? { intentId: approval.intentId } : {}), ...(approval.threadId ? { threadId: approval.threadId } : {}),
        },
        actions: [], fingerprint: fingerprintOf(approval),
      });
      void emitItems();
    } catch (err) {
      console.error("Could not raise the Needs-you item for an approval:", err);
    }
  }

  async function resolveNeedsYou(approval: Approval) {
    try {
      const item = await hub.store.findItemByFingerprint(fingerprintOf(approval));
      if (!item) return;
      await hub.store.updateItem(item.id, { status: "resolved", snoozedUntil: null });
      void emitItems();
    } catch (err) {
      console.error("Could not resolve the Needs-you item for an approval:", err);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------------------------

  type RequestInput = Pick<Approval, "tool" | "origin" | "threadId" | "runId" | "jobId" | "intentId" | "itemId"> & { input: Record<string, unknown>; assessment: Assessment };

  /** A pending request for the call, reusing an identical pending one (a model that retries asks once). */
  async function request({ assessment, ...call }: RequestInput): Promise<Approval> {
    await expireDue();
    const key = callKey(call.tool, call.input, [call.origin, call.threadId, call.jobId, call.intentId, call.itemId]);
    const same = (await store.list({ status: ["pending"], limit: 500 }))
      .find((row) => callKey(row.tool, row.input, [row.origin, row.threadId, row.jobId, row.intentId, row.itemId]) === key);
    if (same) return same;
    const at = now();
    const approval = await store.create({
      ...call, title: assessment.title, summary: assessment.summary, risk: assessment.risk, repo: assessment.repo,
      requestedAt: at, expiresAt: at + expiry[call.origin],
    });
    void hub.activity.log({
      actor: call.origin === "card" ? "user" : "agent", kind: "approval.requested", summary: `Asked for approval: ${approval.title}`,
      refs: refsOf(approval), detail: { tool: approval.tool, risk: approval.risk, repo: approval.repo },
    });
    await emitPending();
    await scheduleSweep().catch(() => {});
    return approval;
  }

  async function expireDue(): Promise<Approval[]> {
    const expired = await store.expire(now());
    if (expired.length === 0) return expired;
    for (const approval of expired) {
      settleWaiters(approval);
      void hub.activity.log({ actor: "system", kind: "approval.expired", summary: `Approval expired unanswered: ${approval.title}`, refs: refsOf(approval) });
      await resolveNeedsYou(approval);
      await postNote(approval, `**Expired:** ${approval.title}. Nobody answered in time, so it did not run.`);
    }
    await emitPending();
    return expired;
  }

  /** The classic tools over the hub alone; what an approved call replays through, whether or not its turn is still around. */
  function replayTools(): ToolSet {
    const unavailable = async () => { throw new Error("Not available when replaying an approved call."); };
    const ctx: ToolContext = {
      store: hub.store, settings: hub.settings, deps: hub.deps, touched: new Set(), interactive: true, now,
      self: { digest: unavailable, schedule: unavailable, lastTick: unavailable },
    };
    return createTools(ctx) as unknown as ToolSet;
  }

  /** Run the recorded call; its output, or throws. */
  async function replay(approval: Approval): Promise<unknown> {
    if (approval.origin === "card") {
      const action = approval.input.action as ItemAction | undefined;
      if (!action || typeof action !== "object" || !isServerAction(action)) throw new Error("The recorded card action cannot be run.");
      const itemId = typeof approval.input.itemId === "string" ? approval.input.itemId : null;
      const item = itemId ? await hub.store.getItem(itemId).catch(() => null) : null;
      return runItemAction(hub, item, action, { approvalId: approval.id });
    }
    const tool = replayTools()[approval.tool];
    if (!tool?.execute) throw new Error(`"${approval.tool}" cannot be replayed.`);
    return tool.execute(approval.input, { toolCallId: `approval-${approval.id}`, messages: [], context: undefined });
  }

  function checkScope(approval: Approval, scope: ApprovalScope) {
    if (scope === "once") return;
    if (approval.origin === "card") {
      if (approval.tool === "remove_worktree") throw httpError("Removing a worktree can only be approved once.", 400);
      if (scope !== "always") throw httpError("A card action can be approved once or always.", 400);
    }
    if (scope === "job" && !approval.jobId && !approval.intentId) throw httpError("A job grant needs a request that came from a job or an intent.", 400);
    if (scope === "repo" && !approval.repo) throw httpError("A repository grant needs a request that acts on a known repository.", 400);
  }

  async function decide(id: string, { approve, scope: requested }: ApprovalDecision): Promise<Approval> {
    if (typeof approve !== "boolean") throw httpError("Expected { approve: boolean, scope? }.", 400);
    if (requested !== undefined && !isApprovalScope(requested)) throw httpError(`"scope" must be one of ${scopes.join(", ")}.`, 400);
    const scope: ApprovalScope = approve ? (requested ?? "once") : "once";
    await expireDue();
    const current = await store.get(id);
    if (!current) throw httpError(`Unknown approval "${id}".`, 404);
    if (current.status !== "pending") throw httpError(`This request is already ${current.status}.`, 409);
    if (approve) checkScope(current, scope);
    const decided = await store.decide(id, { approve, scope }, now());
    if (!decided) throw httpError("This request is no longer pending.", 409);
    claimWaiters(id);
    if (approve && scope !== "once") {
      await store.createGrant({
        tool: decided.tool, scope, jobId: scope === "job" ? decided.jobId : null, intentId: scope === "job" ? decided.intentId : null,
        repo: scope === "repo" ? decided.repo : null, approvalId: decided.id, createdAt: now(),
      });
    }
    void hub.activity.log({
      actor: "user", kind: "approval.decided",
      summary: approve ? `Approved ${scopeWords[scope]}: ${decided.title}` : `Declined: ${decided.title}`,
      refs: refsOf(decided), detail: { approve, scope },
    });
    await emitPending();
    await scheduleSweep().catch(() => {});

    let final = decided;
    if (approve) {
      let result: unknown = null;
      let error: string | null = null;
      try {
        result = await replay(decided);
        error = outputError(result);
      } catch (err) {
        error = errorMessage(err);
      }
      final = (await store.recordResult(id, { result, error })) ?? { ...decided, result, error };
      void hub.activity.log({
        actor: "system", kind: "approval.executed", summary: error ? `${final.title} failed: ${error}` : `Ran the approved call: ${final.title}`,
        refs: refsOf(final), detail: { tool: final.tool, ...(error ? { error } : {}) },
      });
    }
    const delivered = settleWaiters(final);
    if (!delivered) {
      const note = !approve ? `**Declined:** ${final.title}. It did not run.`
        : final.error ? `**Approved:** ${final.title}, but it failed: ${final.error}`
        : `**Approved:** ${final.title}. It ran.`;
      await postNote(final, note);
    }
    await resolveNeedsYou(final);
    if (approve && final.jobId) {
      await hub.jobs.runNow(final.jobId, "approval").catch((err: unknown) => console.error("Could not resume the job after an approval:", err));
    }
    return final;
  }

  // ---------------------------------------------------------------------------------------------
  // The gate
  // ---------------------------------------------------------------------------------------------

  async function assess(tool: string, input: unknown): Promise<Assessment | null> {
    try {
      return await assessToolCall(hub.deps, tool, input);
    } catch (err) {
      console.error(`Could not assess a ${tool} call; asking for approval:`, err);
      return fallbackAssessment(tool, input);
    }
  }

  function pendingOutput(approval: Approval, origin: "chat" | "job") {
    return {
      pending: true, approvalId: approval.id,
      note: origin === "chat"
        ? "The user has not answered Portal's approval dialog yet. The call runs by itself once they approve it. Tell the user it is waiting for their approval in Portal; do not retry it and do not ask for approval in chat."
        : "This call needs the user's approval. A Needs-you item links to the request; the call runs by itself once approved, and this job runs again afterwards. Do not retry it; finish what you can without it.",
    };
  }

  async function guarded(name: string, execute: Execute, input: unknown, toolOptions: ToolOptions, ctx: DomainToolContext) {
    const { turn } = ctx;
    const assessment = await assess(name, input);
    if (!assessment) return execute(input, toolOptions);
    const grant = await store.matchGrant({ tool: name, repo: assessment.repo, jobId: turn.jobId, intentId: turn.intentId });
    if (grant) {
      void hub.activity.log({
        actor: "system", kind: "approval.granted", summary: `Allowed by a ${grant.scope} grant: ${assessment.title}`,
        refs: { runId: turn.runId, ...(turn.threadId ? { threadId: turn.threadId } : {}), ...(turn.jobId ? { jobId: turn.jobId } : {}), approvalId: grant.approvalId },
        detail: { tool: name, grantId: grant.id, scope: grant.scope },
      });
      return execute(input, toolOptions);
    }
    const approval = await request({
      tool: name, input: asRecord(input), assessment, origin: turn.origin, threadId: turn.threadId, runId: turn.runId,
      jobId: turn.jobId, intentId: turn.intentId, itemId: null,
    });
    if (turn.origin === "job") {
      await raiseNeedsYou(approval);
      return pendingOutput(approval, "job");
    }
    const settled = await waitFor(approval.id, chatWaitMs, toolOptions?.abortSignal);
    if (settled?.status === "approved") return settled.result ?? (settled.error ? { error: settled.error } : null);
    if (settled?.status === "denied") return { error: `The user declined this ${name} call in Portal's approval dialog. It did not run; do not retry it unless they ask.` };
    if (settled?.status === "expired") return { error: "The approval request expired unanswered; the call did not run." };
    return pendingOutput(approval, "chat");
  }

  function gate(tools: ToolSet, ctx: DomainToolContext): ToolSet {
    const wrapped: ToolSet = { ...tools };
    for (const [name, tool] of Object.entries(tools)) {
      const execute = tool.execute as Execute | undefined;
      if (!execute || !isGatedTool(name)) continue;
      wrapped[name] = { ...tool, execute: (input: unknown, toolOptions: ToolOptions) => guarded(name, execute, input, toolOptions, ctx) } as Tool;
    }
    return wrapped;
  }

  async function guardAction(item: Item, actionIndex: number, action: ItemAction): Promise<Approval | null> {
    if (!isServerAction(action)) return null;
    if (action.type !== "remove_worktree") {
      const grant = await store.matchGrant({ tool: action.type, repo: null, jobId: null, intentId: null, scopes: ["always"] });
      if (grant) {
        void hub.activity.log({
          actor: "system", kind: "approval.granted", summary: `Allowed by an always grant: "${action.label ?? action.type}" on ${item.title}`,
          refs: { itemId: item.id, approvalId: grant.approvalId }, detail: { tool: action.type, grantId: grant.id, scope: grant.scope },
        });
        return null;
      }
    }
    const assessment = await assessCardAction(hub.deps, action).catch(() => null) ?? fallbackAssessment(action.type, action);
    return request({
      tool: action.type, input: { itemId: item.id, actionIndex, action: { ...action } }, assessment, origin: "card",
      threadId: null, runId: null, jobId: null, intentId: null, itemId: item.id,
    });
  }

  async function revokeGrant(id: string): Promise<ApprovalGrant> {
    const grant = await store.revokeGrant(id, now());
    if (!grant) throw httpError(`Unknown grant "${id}".`, 404);
    void hub.activity.log({
      actor: "user", kind: "approval.revoked", summary: `Revoked the ${grant.scope} grant for ${grant.tool}`,
      refs: { approvalId: grant.approvalId, ...(grant.jobId ? { jobId: grant.jobId } : {}), ...(grant.intentId ? { intentId: grant.intentId } : {}) },
      detail: { grantId: grant.id, tool: grant.tool, scope: grant.scope, repo: grant.repo },
    });
    return grant;
  }

  const ready = scheduleSweep().catch((err: unknown) => { console.error("Could not plan the approvals' expiry:", err); });

  return {
    ready,
    gate,
    guardAction,
    decide,
    revokeGrant,
    expireDue,
    async pending() {
      await expireDue();
      return store.list({ status: ["pending"] });
    },
    async hasPendingFor(runId) {
      await expireDue();
      return (await store.list({ status: ["pending"], runId, limit: 1 })).length > 0;
    },
    async list(filter) {
      await expireDue();
      return store.list(filter);
    },
    get: (id) => store.get(id),
    grants: () => store.listGrants(),
  };
}
