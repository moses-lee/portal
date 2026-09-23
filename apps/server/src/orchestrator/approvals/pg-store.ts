/** Approval requests and grants in Postgres (`approvals`, `approval_grants`). */
import { and, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Approval, ApprovalGrant } from "@portal/contracts/approvals";
import type { Db } from "../../db/client.ts";
import { stripNul } from "../../db/sanitize.ts";
import { approvalGrants, approvals } from "../../db/schema.ts";
import { newId } from "../store.ts";
import { type ApprovalStore, buildApproval, clampApprovalLimit } from "./store.ts";

type Row = typeof approvals.$inferSelect;
type GrantRow = typeof approvalGrants.$inferSelect;

const fromRow = (row: Row): Approval => ({
  id: row.id, status: row.status as Approval["status"], tool: row.tool, title: row.title, summary: row.summary, input: row.input,
  risk: row.risk as Approval["risk"], origin: row.origin as Approval["origin"], repo: row.repo, threadId: row.threadId, runId: row.runId,
  jobId: row.jobId, intentId: row.intentId, itemId: row.itemId, requestedAt: row.requestedAt, expiresAt: row.expiresAt,
  decidedAt: row.decidedAt, decision: (row.decision as Approval["decision"]) ?? null, result: row.result ?? null, error: row.error,
});

const fromGrantRow = (row: GrantRow): ApprovalGrant => ({
  id: row.id, tool: row.tool, scope: row.scope as ApprovalGrant["scope"], jobId: row.jobId, intentId: row.intentId, repo: row.repo,
  approvalId: row.approvalId, createdAt: row.createdAt, revokedAt: row.revokedAt,
});

export function createPgApprovalStore({ db }: { db: Db }): ApprovalStore {
  return {
    async create(raw) {
      const approval = stripNul(buildApproval(raw, newId()));
      const [row] = await db.insert(approvals).values({ ...approval, decision: null, result: null }).returning();
      return fromRow(row);
    },
    async get(id) {
      const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
      return row ? fromRow(row) : null;
    },
    async list(filter = {}) {
      const where: SQL[] = [];
      if (filter.status) where.push(filter.status.length ? inArray(approvals.status, filter.status) : sql`false`);
      if (filter.runId) where.push(eq(approvals.runId, filter.runId));
      const rows = await db.select().from(approvals).where(where.length ? and(...where) : undefined)
        .orderBy(desc(approvals.requestedAt), desc(approvals.id)).limit(clampApprovalLimit(filter.limit));
      return rows.map(fromRow);
    },
    async decide(id, decision, at) {
      const [row] = await db.update(approvals)
        .set({ status: decision.approve ? "approved" : "denied", decidedAt: at, decision: { approve: decision.approve, scope: decision.scope } })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending"), gt(approvals.expiresAt, at)))
        .returning();
      return row ? fromRow(row) : null;
    },
    async recordResult(id, { result, error }) {
      const [row] = await db.update(approvals)
        .set({ result: stripNul(result ?? null), error: error === null ? null : stripNul(error) })
        .where(eq(approvals.id, id))
        .returning();
      return row ? fromRow(row) : null;
    },
    async expire(now) {
      const rows = await db.update(approvals).set({ status: "expired" })
        .where(and(eq(approvals.status, "pending"), lte(approvals.expiresAt, now)))
        .returning();
      return rows.map(fromRow);
    },
    async createGrant(raw) {
      const input = stripNul(raw);
      const [row] = await db.insert(approvalGrants).values({ ...input, id: newId(), revokedAt: null }).returning();
      return fromGrantRow(row);
    },
    async listGrants({ includeRevoked = false } = {}) {
      const rows = await db.select().from(approvalGrants).where(includeRevoked ? undefined : isNull(approvalGrants.revokedAt))
        .orderBy(desc(approvalGrants.createdAt), desc(approvalGrants.id));
      return rows.map(fromGrantRow);
    },
    async revokeGrant(id, at) {
      const [updated] = await db.update(approvalGrants).set({ revokedAt: at })
        .where(and(eq(approvalGrants.id, id), isNull(approvalGrants.revokedAt))).returning();
      if (updated) return fromGrantRow(updated);
      const [row] = await db.select().from(approvalGrants).where(eq(approvalGrants.id, id));
      return row ? fromGrantRow(row) : null;
    },
    async matchGrant({ tool, repo, jobId, intentId, scopes }) {
      const covers: SQL[] = [eq(approvalGrants.scope, "always")];
      if (repo !== null) covers.push(and(eq(approvalGrants.scope, "repo"), sql`lower(${approvalGrants.repo}) = ${repo.toLowerCase()}`)!);
      if (jobId !== null) covers.push(and(eq(approvalGrants.scope, "job"), eq(approvalGrants.jobId, jobId))!);
      if (intentId !== null) covers.push(and(eq(approvalGrants.scope, "job"), eq(approvalGrants.intentId, intentId))!);
      const where: SQL[] = [eq(approvalGrants.tool, tool), isNull(approvalGrants.revokedAt), or(...covers)!];
      if (scopes) where.push(scopes.length ? inArray(approvalGrants.scope, scopes) : sql`false`);
      const [row] = await db.select().from(approvalGrants).where(and(...where))
        .orderBy(desc(approvalGrants.createdAt), desc(approvalGrants.id)).limit(1);
      return row ? fromGrantRow(row) : null;
    },
  };
}
