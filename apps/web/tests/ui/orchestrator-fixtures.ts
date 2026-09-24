/**
 * Sample orchestrator data for the phase 2 views (threads, goals, activity, memory, system,
 * approvals), shaped exactly as the contracts in `@portal/contracts` say the server answers.
 * `setupPortal` serves them from route mocks; specs pass their own through its `portal` option.
 */
import type {
  ActivityEntry,
  Approval,
  ApprovalGrant,
  ConsolidationResult,
  CoreDocument,
  Intent,
  Job,
  JobRun,
  MemoryEntity,
  MemoryRecord,
  MemoryRevision,
  OrchestratorMessage,
  Scope,
  Thread,
  WorldResponse,
} from "../../src/lib/orchestrator/types";

const now = Date.now();
const min = 60_000;
const scope = (extra: Partial<Scope> = {}): Scope => ({
  projectIds: [],
  sessionIds: [],
  pulls: [],
  repos: [],
  people: [],
  taskTypes: [],
  ...extra,
});
const pull42 = { repo: "example/portal", number: 42, url: "https://github.com/example/portal/pull/42" };

export const mainThread: Thread = {
  id: "main",
  kind: "main",
  title: "Main",
  status: "active",
  scope: scope(),
  intentId: null,
  createdAt: now - 30 * 24 * 60 * min,
  updatedAt: now - 10 * min,
  lastMessageAt: now - 10 * min,
};

export const reviewThread: Thread = {
  id: "t-review",
  kind: "side",
  title: "Review example/portal#42",
  status: "active",
  scope: scope({ pulls: [pull42], repos: ["example/portal"] }),
  intentId: "in1",
  createdAt: now - 3 * 60 * min,
  updatedAt: now - 20 * min,
  lastMessageAt: now - 20 * min,
};

export const archivedThread: Thread = {
  id: "t-old",
  kind: "side",
  title: "Clean up merged worktrees",
  status: "archived",
  scope: scope(),
  intentId: null,
  createdAt: now - 5 * 24 * 60 * min,
  updatedAt: now - 4 * 24 * 60 * min,
  lastMessageAt: now - 4 * 24 * 60 * min,
};

export const reviewThreadMessages: OrchestratorMessage[] = [
  {
    id: "rt1",
    role: "assistant",
    metadata: { at: now - 3 * 60 * min, run: { id: "run-h1", kind: "helper" } },
    parts: [{ type: "text", text: "I started a review session for **#42** and will post the findings here." }],
  },
];

export const archivedThreadMessages: OrchestratorMessage[] = [
  {
    id: "ot1",
    role: "assistant",
    metadata: { at: now - 4 * 24 * 60 * min },
    parts: [{ type: "text", text: "Both merged worktrees are gone. Nothing else to do here." }],
  },
];

export const intent: Intent = {
  id: "in1",
  text: "Tell me when #42 merges",
  trigger: "PR example/portal#42 is merged or closed",
  action: "Tell the user, then offer to remove the worktree",
  notes: "Checks are **green**; waiting on one review.",
  scope: scope({ pulls: [pull42] }),
  status: "active",
  expiresAt: now + 7 * 24 * 60 * min,
  fireBudget: 1,
  fires: 0,
  cooldownMs: 0,
  lastFiredAt: null,
  lastCheckedAt: now - 4 * min,
  threadId: "t-review",
  createdAt: now - 3 * 60 * min,
  updatedAt: now - 4 * min,
};

export const tickJob: Job = {
  id: "tick",
  kind: "tick",
  title: "Check for changes",
  schedule: { type: "every", everyMs: 10 * min, idleEveryMs: 60 * min },
  payload: {},
  status: "active",
  nextRunAt: now + 7 * min,
  lastRunAt: now - 3 * min,
  lastRunId: "run-t1",
  intentId: null,
  threadId: null,
  createdBy: "system",
  failures: 0,
  createdAt: now - 30 * 24 * 60 * min,
  updatedAt: now - 3 * min,
};

export const intentJob: Job = {
  ...tickJob,
  id: "j-pr42",
  kind: "intent_check",
  title: "Check example/portal#42 until merged",
  schedule: { type: "every", everyMs: 2 * min },
  status: "active",
  nextRunAt: now + 1.5 * min,
  intentId: "in1",
  threadId: "t-review",
  createdBy: "agent",
};

export const nightlyJob: Job = {
  ...tickJob,
  id: "j-nightly",
  kind: "consolidate",
  title: "Curate memory",
  schedule: { type: "cron", expr: "0 3 * * *" },
  status: "paused",
  nextRunAt: null,
  lastRunAt: null,
  createdBy: "agent",
};

export const tickRun: JobRun = {
  id: "run-t1",
  jobId: "tick",
  kind: "tick",
  threadId: null,
  parentRunId: null,
  status: "succeeded",
  trigger: "schedule",
  startedAt: now - 3 * min,
  finishedAt: now - 3 * min + 12_400,
  model: { provider: "anthropic", model: "claude-haiku-4-5" },
  usage: { inputTokens: 1200, outputTokens: 80 },
  log: ["Considered PR #42: still failing."],
  result: null,
  summary: "One change: checks failing on #42.",
  error: null,
};

export const failedRun: JobRun = {
  ...tickRun,
  id: "run-h0",
  jobId: "j-pr42",
  kind: "intent_check",
  status: "failed",
  startedAt: now - 30 * min,
  finishedAt: now - 30 * min + 3000,
  model: { provider: "anthropic", model: "claude-opus-5-5" },
  usage: { inputTokens: 5400, outputTokens: 220, cachedInputTokens: 4000 },
  log: [],
  summary: null,
  error: "GitHub rate limit reached.",
};

export function activityEntries(count = 3): ActivityEntry[] {
  const base: ActivityEntry[] = [
    {
      id: 103,
      at: now - 2 * min,
      actor: "agent",
      kind: "memory.proposed",
      summary: "Proposed: octocat prefers squash merges.",
      refs: { recordId: "r-prop", entityId: "e-octo" },
      detail: null,
    },
    {
      id: 102,
      at: now - 5 * min,
      actor: "agent",
      kind: "job.scheduled",
      summary: "Scheduled a check of example/portal#42 every 2 minutes.",
      refs: { jobId: "j-pr42", threadId: "t-review", pull: pull42 },
      detail: { everyMs: 120000 },
    },
    {
      id: 101,
      at: now - 9 * min,
      actor: "user",
      kind: "item.resolved",
      summary: "Resolved: checks are failing on example/portal#42.",
      refs: { itemId: "i1", sessionId: "s1" },
      detail: null,
    },
  ];
  // Older filler, so paging has something to fetch.
  for (let i = base.length; i < count; i++)
    base.push({
      id: 103 - i,
      at: now - (10 + i) * min,
      actor: "system",
      kind: "tool.call",
      summary: `Ran get_tick_digest (${i}).`,
      refs: {},
      detail: { tool: "get_tick_digest" },
    });
  return base;
}

export const globalEntity: MemoryEntity = {
  id: "e-global",
  type: "global",
  key: "global",
  name: "Global",
  summary: "How the user likes to work, everywhere.",
  activeRecords: 1,
  createdAt: now - 10 * 24 * 60 * min,
  updatedAt: now - min,
};
export const octoEntity: MemoryEntity = {
  id: "e-octo",
  type: "person",
  key: "octocat",
  name: "octocat",
  summary: "",
  activeRecords: 0,
  createdAt: now - 60 * min,
  updatedAt: now - 2 * min,
};
export const repoEntity: MemoryEntity = {
  id: "e-repo",
  type: "repo",
  key: "example/portal",
  name: "example/portal",
  summary: "The **Portal** monorepo.",
  activeRecords: 2,
  createdAt: now - 10 * 24 * 60 * min,
  updatedAt: now - 5 * min,
};

const record = (extra: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "entityId" | "key" | "body">): MemoryRecord => ({
  type: "preference",
  status: "active",
  scope: scope(),
  authority: "user_stated",
  source: { kind: "message", threadId: "main", quote: "keep reviews short" },
  trust: 0.9,
  pinned: false,
  reviewBy: null,
  supersedes: null,
  supersededBy: null,
  createdAt: now - 60 * min,
  updatedAt: now - 60 * min,
  ...extra,
});

export const memoryRecords: MemoryRecord[] = [
  record({ id: "r-style", entityId: "e-global", key: "review-style", body: "Keep reviews short and list blockers first.", pinned: true }),
  record({
    id: "r-tests-v1",
    entityId: "e-repo",
    key: "test-command",
    body: "Run `pnpm test` before pushing.",
    status: "superseded",
    supersededBy: "r-tests",
    updatedAt: now - 30 * min,
  }),
  record({
    id: "r-tests",
    entityId: "e-repo",
    key: "test-command",
    type: "convention",
    body: "Run `pnpm -r test` before pushing.",
    supersedes: "r-tests-v1",
    authority: "user_confirmed",
    source: { kind: "ui" },
    updatedAt: now - 30 * min,
  }),
  record({
    id: "r-ci",
    entityId: "e-repo",
    key: "ci-provider",
    type: "fact",
    body: "CI runs on GitHub Actions.",
    authority: "observed",
    trust: 0.6,
    source: { kind: "pull", pull: pull42, quote: "Workflow: ci.yml" },
    reviewBy: now - 24 * 60 * min,
  }),
  record({
    id: "r-prop",
    entityId: "e-octo",
    key: "merge-style",
    type: "preference",
    body: "Prefers squash merges.",
    status: "proposed",
    sightings: [{ kind: "pull", pull: pull42, quote: "squash on merge, as usual" }],
    authority: "observed",
    trust: 0.5,
    source: { kind: "session", sessionId: "s1", quote: "please squash this" },
  }),
];

export const memoryRevisions: MemoryRevision[] = [
  {
    id: 1,
    recordId: "r-tests",
    entityId: "e-repo",
    at: now - 30 * min,
    actor: "user",
    action: "superseded",
    before: memoryRecords[1],
    after: memoryRecords[2],
    reason: "The workspace needs -r",
    runId: null,
  },
];

/** The seeded curation job, nightly at 03:00. */
export const consolidateJob: Job = {
  ...tickJob,
  id: "consolidate",
  kind: "consolidate",
  title: "Curate memory",
  schedule: { type: "cron", expr: "0 3 * * *", tz: "Europe/Berlin" },
  nextRunAt: now + 5 * 60 * min,
  lastRunId: "run-c1",
};

const curationResult: ConsolidationResult = {
  digest: "Memory curation promoted 1, rewrote 1 summary; 1 left in the inbox.\n\n**Promoted**\n- repo example/portal · `ci-provider`: CI runs on GitHub Actions. (Seen in two PRs.)",
  line: "Memory curation promoted 1, rewrote 1 summary; 1 left in the inbox.",
  counts: { promoted: 1, superseded: 0, rejected: 0, expired: 0, left: 1, reconfirm: 0, summarized: 1 },
  changes: [
    {
      action: "promoted", entityId: "e-repo", entity: "repo example/portal", recordId: "r-ci", key: "ci-provider", reason: "Seen in two PRs.",
      before: { ...memoryRecords[3], status: "proposed" }, after: memoryRecords[3],
    },
    {
      action: "left", entityId: "e-octo", entity: "person octocat", recordId: "r-prop", key: "merge-style", reason: "Only one session says so.",
      before: memoryRecords[4], after: null,
    },
    {
      action: "summarized", entityId: "e-repo", entity: "repo example/portal", recordId: null, key: null, reason: null, before: null, after: null,
      summary: { before: "The Portal monorepo.", after: "The **Portal** monorepo; CI on GitHub Actions." },
    },
  ],
  refused: null,
  considered: { inbox: 2, active: 3, overdue: 0, entities: 3 },
  note: null,
};

export const curationRun: JobRun = {
  ...tickRun,
  id: "run-c1",
  jobId: "consolidate",
  kind: "consolidate",
  startedAt: now - 8 * 60 * min,
  finishedAt: now - 8 * 60 * min + 41_000,
  model: { provider: "anthropic", model: "claude-opus-5-5" },
  usage: { inputTokens: 18_000, outputTokens: 900 },
  log: ["Nightly run.", curationResult.line],
  result: curationResult,
  summary: curationResult.line,
};

export const coreDocument: CoreDocument = {
  text: "# Directives\n- Keep reviews short and list blockers first.\n\n# Entities\n- global: How the user likes to work\n- repo example/portal: The Portal monorepo",
  generatedAt: now - 5 * min,
  tokens: 64,
};

export const worldResponse: WorldResponse = {
  world: {
    at: now - 2 * min,
    login: "developer",
    projects: [
      { id: "p1", name: "portal", path: "/workspace/portal", repo: "example/portal", defaultBranch: "main", worktree: null, missing: false, branch: "main" },
      {
        id: "p2",
        name: "improve-chat-experience",
        path: "/workspace/portal-worktree",
        repo: "example/portal",
        defaultBranch: "main",
        worktree: { parentId: "p1", branch: "feature/improve-chat-experience", dirty: true, merged: false },
        missing: false,
        branch: "feature/improve-chat-experience",
      },
    ],
    repos: [{ repo: "example/portal", defaultBranch: "main", projectIds: ["p1", "p2"] }],
    sessions: [
      {
        id: "s1",
        title: "Improve the chat experience",
        projectId: "p2",
        agentId: "claude",
        agentName: "Claude Code",
        activity: "working",
        link: "live",
        createdAt: now - 60 * min,
        lastActiveAt: now - min,
      },
    ],
    terminals: [],
    pulls: [
      {
        ...pull42,
        title: "Improve the chat experience",
        author: "developer",
        roles: ["author"],
        state: "open",
        draft: false,
        baseBranch: "main",
        headBranch: "feature/improve-chat-experience",
        checks: "failing",
        reviewDecision: "review_required",
        mergeable: "mergeable",
        updatedAt: now - 10 * min,
        localProjectId: "p1",
        worktreeProjectId: "p2",
      },
    ],
    intents: [],
    jobs: [],
    items: [],
    errors: [],
    snapshot: { at: now, sessions: {}, pulls: {}, worktrees: {}, missingProjects: [] },
  },
  rendered: "## Projects\n- portal (example/portal, main)\n  - worktree improve-chat-experience [dirty]\n## Pull requests\n- example/portal#42 Improve the chat experience: checks failing",
  tokens: 1450,
};

export const grants: ApprovalGrant[] = [
  { id: "g1", tool: "remove_worktree", scope: "repo", jobId: null, intentId: null, repo: "example/portal", approvalId: "a0", createdAt: now - 60 * min, revokedAt: null },
  { id: "g2", tool: "run_shell", scope: "always", jobId: null, intentId: null, repo: null, approvalId: "a-1", createdAt: now - 90 * min, revokedAt: now - 30 * min },
];

export const approval: Approval = {
  id: "a1",
  status: "pending",
  tool: "remove_worktree",
  title: "Remove worktree improve-chat-experience of portal",
  summary: "Deletes the folder `/workspace/portal-worktree` and the branch **feature/improve-chat-experience**.",
  input: { projectId: "p2", deleteBranch: true },
  risk: "destructive",
  origin: "job",
  repo: "example/portal",
  threadId: "t-review",
  runId: "run-h1",
  jobId: "j-pr42",
  intentId: "in1",
  itemId: null,
  requestedAt: now - min,
  expiresAt: now + 60 * min,
  decidedAt: null,
  decision: null,
  result: null,
  error: null,
};

export const chatApproval: Approval = {
  ...approval,
  id: "a2",
  tool: "run_shell",
  title: "Run git push in portal",
  summary: "```sh\ngit push origin HEAD\n```",
  input: { command: "git push origin HEAD", cwd: "/workspace/portal" },
  risk: "outbound",
  origin: "chat",
  repo: null,
  threadId: "main",
  jobId: null,
  intentId: null,
  requestedAt: now - 30_000,
};
