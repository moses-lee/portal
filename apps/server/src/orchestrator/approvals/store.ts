/**
 * Persistence for approval requests and grants. The in-memory store backs tests; `pg-store.ts` is
 * the live one (`approvals`, `approval_grants`), and one behaviour test runs against both.
 *
 * Deciding is conditional: only a pending request that has not expired can be decided, and a
 * second decision (a double click, two tabs) finds nothing to change. Grants are never deleted,
 * only revoked, so the list keeps what was once allowed.
 */
import type { Approval, ApprovalGrant, ApprovalScope, ApprovalStatus } from "@portal/contracts/approvals";
import { stripNul } from "../../db/sanitize.ts";
import { newId } from "../store.ts";

export type ApprovalInput = Pick<
  Approval,
  "tool" | "title" | "summary" | "input" | "risk" | "origin" | "repo" | "threadId" | "runId" | "jobId" | "intentId" | "itemId" | "requestedAt" | "expiresAt"
>;

export type GrantScope = ApprovalGrant["scope"];
export type GrantInput = Pick<ApprovalGrant, "tool" | "scope" | "jobId" | "intentId" | "repo" | "approvalId" | "createdAt">;

/** A call looking for a grant: the tool, and the repo, job and intent it runs for. */
export type GrantQuery = {
  tool: string;
  repo: string | null;
  jobId: string | null;
  intentId: string | null;
  /** Only these scopes count (a card action honours `always` grants only); default all. */
  scopes?: GrantScope[];
};

export type ApprovalFilter = {
  /** Any of these statuses; default all. */
  status?: ApprovalStatus[];
  runId?: string;
  /** At most this many, newest first (default 100, at most 500). */
  limit?: number;
};

export const DEFAULT_APPROVAL_LIMIT = 100;
export const MAX_APPROVAL_LIMIT = 500;

export interface ApprovalStore {
  create(input: ApprovalInput): Promise<Approval>;
  get(id: string): Promise<Approval | null>;
  /** Newest first. */
  list(filter?: ApprovalFilter): Promise<Approval[]>;
  /** Decide a pending request that has not expired by `at`; null when there is none to decide. */
  decide(id: string, decision: { approve: boolean; scope: ApprovalScope }, at: number): Promise<Approval | null>;
  /** The executed call's output or error. */
  recordResult(id: string, outcome: { result: unknown; error: string | null }): Promise<Approval | null>;
  /** Mark every pending request whose time ran out by `now` expired; returns them. */
  expire(now: number): Promise<Approval[]>;
  createGrant(input: GrantInput): Promise<ApprovalGrant>;
  /** Newest first; revoked ones only when asked. */
  listGrants(filter?: { includeRevoked?: boolean }): Promise<ApprovalGrant[]>;
  /** Revoke a grant; null when unknown. Revoking twice keeps the first time. */
  revokeGrant(id: string, at: number): Promise<ApprovalGrant | null>;
  /** An active grant covering the call, if any. */
  matchGrant(query: GrantQuery): Promise<ApprovalGrant | null>;
}

export function clampApprovalLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_APPROVAL_LIMIT;
  return Math.max(1, Math.min(MAX_APPROVAL_LIMIT, Math.floor(limit)));
}

const sameRepo = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** Whether `grant` covers the call; the Postgres store asks the same in SQL. */
export function grantCovers(grant: ApprovalGrant, query: GrantQuery): boolean {
  if (grant.revokedAt !== null || grant.tool !== query.tool) return false;
  if (query.scopes && !query.scopes.includes(grant.scope)) return false;
  switch (grant.scope) {
    case "always": return true;
    case "repo": return sameRepo(grant.repo, query.repo);
    case "job": return (query.jobId !== null && grant.jobId === query.jobId) || (query.intentId !== null && grant.intentId === query.intentId);
    default: return false;
  }
}

export function buildApproval(input: ApprovalInput, id: string): Approval {
  return { ...input, id, status: "pending", decidedAt: null, decision: null, result: null, error: null };
}

export function createMemoryApprovalStore(): ApprovalStore {
  const approvals = new Map<string, Approval>();
  const grants = new Map<string, ApprovalGrant>();
  /** Insertion order breaks ties between records created in the same millisecond. */
  const order = new Map<string, number>();
  let counter = 0;
  const newest = <T extends { id: string }>(time: (row: T) => number) => (a: T, b: T) => time(b) - time(a) || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
  // NUL-free like the Postgres store, so both answer the same.
  const copy = <T>(value: T): T => stripNul(structuredClone(value));

  return {
    async create(input) {
      const approval = buildApproval(copy(input), newId((id) => approvals.has(id)));
      approvals.set(approval.id, approval);
      order.set(approval.id, counter++);
      return copy(approval);
    },
    async get(id) {
      const found = approvals.get(id);
      return found ? copy(found) : null;
    },
    async list(filter = {}) {
      return [...approvals.values()]
        .filter((row) => (!filter.status || filter.status.includes(row.status)) && (!filter.runId || row.runId === filter.runId))
        .sort(newest((row) => row.requestedAt))
        .slice(0, clampApprovalLimit(filter.limit))
        .map(copy);
    },
    async decide(id, decision, at) {
      const current = approvals.get(id);
      if (!current || current.status !== "pending" || current.expiresAt <= at) return null;
      const next: Approval = { ...current, status: decision.approve ? "approved" : "denied", decidedAt: at, decision: { ...decision } };
      approvals.set(id, next);
      return copy(next);
    },
    async recordResult(id, { result, error }) {
      const current = approvals.get(id);
      if (!current) return null;
      const next: Approval = { ...current, result: copy(result ?? null), error };
      approvals.set(id, next);
      return copy(next);
    },
    async expire(now) {
      const expired: Approval[] = [];
      for (const row of approvals.values()) {
        if (row.status !== "pending" || row.expiresAt > now) continue;
        const next: Approval = { ...row, status: "expired" };
        approvals.set(row.id, next);
        expired.push(copy(next));
      }
      return expired;
    },
    async createGrant(input) {
      const grant: ApprovalGrant = { ...input, id: newId((id) => grants.has(id)), revokedAt: null };
      grants.set(grant.id, grant);
      order.set(grant.id, counter++);
      return { ...grant };
    },
    async listGrants({ includeRevoked = false } = {}) {
      return [...grants.values()].filter((grant) => includeRevoked || grant.revokedAt === null).sort(newest((grant) => grant.createdAt)).map((grant) => ({ ...grant }));
    },
    async revokeGrant(id, at) {
      const current = grants.get(id);
      if (!current) return null;
      const next = current.revokedAt === null ? { ...current, revokedAt: at } : current;
      grants.set(id, next);
      return { ...next };
    },
    async matchGrant(query) {
      const found = [...grants.values()].sort(newest((grant) => grant.createdAt)).find((grant) => grantCovers(grant, query));
      return found ? { ...found } : null;
    },
  };
}
