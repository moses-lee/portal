/**
 * Wire types for "Talk to Portal", the orchestrator: a coordinator that lives outside every project
 * and session. It chats in threads, runs background jobs (the tick among them) that turn changes in
 * sessions, pull requests, and worktrees into Needs-you items, keeps curated memory, and asks before
 * anything irreversible. The server owns the runtime and its stores; the browser reads these shapes
 * over `/api/portal/**`. The other domains' shapes and routes are in activity.ts, jobs.ts, world.ts,
 * memory.ts, and approvals.ts.
 *
 * Only erasable TypeScript here (types and plain values), so Node can load it without a build step.
 *
 * HTTP surface (all same-origin checked like the rest of Portal):
 *   GET    /api/portal                 { status }
 *   GET    /api/portal/threads         { threads }
 *   GET    /api/portal/messages        { messages }   (the main thread)
 *   POST   /api/portal/messages        body { message: OrchestratorMessage } -> UI message stream (main thread)
 *   GET    /api/portal/threads/:id/messages          { messages }
 *   POST   /api/portal/threads/:id/messages          body { message } -> UI message stream
 *   POST   /api/portal/threads/:id/cancel            -> 204
 *   POST   /api/portal/cancel          -> 204 (the main thread's turn)
 *   POST   /api/portal/tick            -> { report }  (runs the tick job now)
 *   GET    /api/portal/ticks           { ticks }      (the tick job's recent reports)
 *   GET    /api/portal/items           { items }
 *   PATCH  /api/portal/items/:id       body ItemPatch -> { item }
 *   POST   /api/portal/items/:id/actions/:index -> { sessionId?, promptError?, approvalId? }
 *   GET    /api/portal/activity        see activity.ts
 *   GET    /api/portal/stream          SSE of OrchestratorEvent; opens with `status`, `items`, `threads`, `approvals`, `intents`
 */
import type { UIMessage } from "ai";
import type { ActivityEntry } from "./activity.ts";
import type { Approval } from "./approvals.ts";
import type { Intent, JobRun } from "./jobs.ts";

// ---------------------------------------------------------------------------------------------
// Settings (the pure settings module owns storage; these are the shapes it exposes)
// ---------------------------------------------------------------------------------------------

export type OrchestratorProvider = "openai" | "anthropic";
export const orchestratorProviders: readonly OrchestratorProvider[] = ["openai", "anthropic"];

/** Orchestrator settings as served to the browser: keys are reported as present/absent only. */
export type OrchestratorSettings = {
  /** The chat role's provider: chat turns, helpers, curation. */
  provider: OrchestratorProvider;
  /** The chat role's model id, e.g. "claude-opus-5-5". */
  model: string;
  /** The bookkeeping role (tick bookkeeping): a cheap model, possibly on another provider. */
  bookkeeping: ModelChoice;
  /** Tick interval while at least one browser has Portal open. */
  intervalMinutes: number;
  /** Tick interval while no browser is connected. */
  idleIntervalMinutes: number;
  /** When the memory curation pass runs. */
  consolidation: ConsolidationSettings;
  /** True when a key is stored for the provider. The key itself never leaves the server. */
  apiKeys: Record<OrchestratorProvider, boolean>;
};

/**
 * When the consolidator (the memory curation job) runs: nightly at a local time, and whenever the
 * inbox holds enough proposals, at most once per `minIntervalMinutes`. A null turns that trigger
 * off; "Run now" in the Memory view always works.
 */
export type ConsolidationSettings = {
  /** "HH:MM", 24-hour, in the server's time zone. */
  nightlyAt: string | null;
  /** Proposed records in the inbox that start a run. */
  inboxThreshold: number | null;
  /** Least time between the start of the last run and one the inbox starts. */
  minIntervalMinutes: number;
};

/**
 * PATCH shape. An empty string for a key clears it. A provider change without a model resets the
 * model to that provider's default for the role, so the model always follows the provider.
 */
export type OrchestratorSettingsPatch = {
  provider?: OrchestratorProvider;
  model?: string;
  bookkeeping?: Partial<ModelChoice>;
  intervalMinutes?: number;
  idleIntervalMinutes?: number;
  consolidation?: Partial<ConsolidationSettings>;
  apiKeys?: Partial<Record<OrchestratorProvider, string>>;
};

export const defaultOrchestratorSettings: OrchestratorSettings = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  bookkeeping: { provider: "anthropic", model: "claude-haiku-4-5" },
  intervalMinutes: 10,
  idleIntervalMinutes: 60,
  consolidation: { nightlyAt: "03:00", inboxThreshold: 10, minIntervalMinutes: 60 },
  apiKeys: { openai: false, anthropic: false },
};

/** The two jobs a model does: talking with the user and curating (frontier), and tick bookkeeping (cheap). */
export type ModelRole = "chat" | "bookkeeping";
export const modelRoles: readonly ModelRole[] = ["chat", "bookkeeping"];

/** A provider and one of its model ids. */
export type ModelChoice = { provider: OrchestratorProvider; model: string };

/** The model each role uses on a provider unless the user picked another one. */
export const defaultModels: Record<OrchestratorProvider, Record<ModelRole, string>> = {
  anthropic: { chat: "claude-opus-5-5", bookkeeping: "claude-haiku-4-5" },
  openai: { chat: "gpt-5", bookkeeping: "gpt-5-mini" },
};

// ---------------------------------------------------------------------------------------------
// Scope: what a thread, an intent, or a memory record is about
// ---------------------------------------------------------------------------------------------

export type Scope = {
  projectIds: string[];
  sessionIds: string[];
  pulls: PullRef[];
  /** "owner/name" */
  repos: string[];
  /** GitHub logins. */
  people: string[];
  /** Task-type slugs, e.g. "code-review". */
  taskTypes: string[];
};

export const emptyScope = (): Scope => ({ projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] });

// ---------------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------------

/** The one thread the user talks in; side threads (one per task) are created by the agent only. */
export const MAIN_THREAD_ID = "main";

export type ThreadKind = "main" | "side";
export type ThreadStatus = "active" | "archived";

export type Thread = {
  id: string;
  kind: ThreadKind;
  title: string;
  status: ThreadStatus;
  /** What the thread is about; memory retrieval in its turns narrows to this. Empty for the main thread. */
  scope: Scope;
  /** The intent the thread was opened for, when there is one. */
  intentId: string | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
};

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export type ItemStatus = "open" | "snoozed" | "resolved" | "dismissed";

export type ItemKind =
  | "session_finished"
  | "session_waiting"
  | "session_offline"
  | "pr_checks_failing"
  | "pr_changes_requested"
  | "pr_conflicts"
  | "pr_review_requested"
  | "pr_merged"
  | "pr_closed"
  | "worktree_merged"
  | "worktree_dirty"
  | "folder_missing"
  /** Items from before intents replaced watches. */
  | "watch_update"
  /** An intent fired or needs the user. */
  | "intent_update"
  /** A review session finished; the item carries its findings. */
  | "review_findings"
  /** A background job is paused on an approval; the item links to it. */
  | "approval_needed"
  /** Claims the user stated or confirmed are past their review date; the item links to the Memory view. */
  | "memory_reconfirm"
  | "custom";

/** A GitHub pull request reference, independent of whether Portal has the repo locally. */
export type PullRef = {
  /** "owner/name" */
  repo: string;
  number: number;
  url: string;
};

export type ItemLinks = {
  projectId?: string;
  sessionId?: string;
  pull?: PullRef;
  intentId?: string;
  jobId?: string;
  threadId?: string;
  approvalId?: string;
};

/** A button on an item card. Every action maps onto something the server can do without the model. */
export type ItemAction =
  | { type: "open_session"; sessionId: string; label?: string }
  | { type: "open_url"; url: string; label?: string }
  | { type: "start_session"; projectId: string; prompt: string; agentId?: string; label?: string }
  | { type: "send_prompt"; sessionId: string; prompt: string; label?: string }
  | { type: "remove_worktree"; projectId: string; label?: string }
  /** Sends `text` to the orchestrator as if the user typed it, e.g. "Set up a review for owner/repo#42". */
  | { type: "ask_portal"; text: string; label?: string };

export type Item = {
  id: string;
  kind: ItemKind;
  title: string;
  /** Short Markdown body; one to three sentences. */
  body: string;
  links: ItemLinks;
  actions: ItemAction[];
  /** Stable identity of the underlying condition, e.g. "pr_checks_failing:owner/repo#42". Dedupes across ticks. */
  fingerprint: string;
  status: ItemStatus;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms until which a snoozed item stays hidden; null otherwise. */
  snoozedUntil: number | null;
};

export type ItemPatch = Partial<Pick<Item, "kind" | "title" | "body" | "links" | "actions" | "status" | "snoozedUntil">>;

// ---------------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------------

/** Extra data Portal keeps on each message of the one shared thread. */
export type OrchestratorMessageMetadata = {
  /** Epoch ms when the message was created. */
  at: number;
  /** Set on assistant messages produced by a scheduled or manual tick rather than a user prompt. */
  tick?: { id: string; reason: TickReason };
  /** The run that produced an assistant message (chat turn, tick, helper, intent check). */
  run?: { id: string; kind: JobRun["kind"] };
  /** Items created or updated by this message. The thread does not show them (they live in Needs you); the audit trail does. */
  itemIds?: string[];
};

export type OrchestratorMessage = UIMessage<OrchestratorMessageMetadata>;

// ---------------------------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------------------------

export type TickReason = "schedule" | "manual";

/** Everything the pre-scan compares between ticks. Kept small: ids and states, no bodies. */
export type TickSnapshot = {
  at: number;
  sessions: Record<string, {
    activity: "idle" | "working" | "waiting" | "connecting" | "error";
    lastActiveAt: number;
    title: string | null;
    projectId: string;
    /** The agent link at snapshot time; "finished" only counts between two live readings. Absent in snapshots from before this field. */
    link?: "live" | "connecting" | "offline";
  }>;
  /** Keyed by "owner/name#number". */
  pulls: Record<string, PullAttention>;
  /** Keyed by worktree project id. */
  worktrees: Record<string, { branch: string; merged: boolean; dirty: boolean; parentId: string | null }>;
  /** Project ids whose folder is missing. */
  missingProjects: string[];
};

/** One pull request that concerns the user, from `gh search prs` across all of GitHub. */
export type PullAttention = PullRef & {
  title: string;
  author: string;
  /** Why this PR is in the list. A PR can be both. */
  roles: ("author" | "reviewer")[];
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  checks: "passing" | "failing" | "pending" | null;
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  mergeable: "mergeable" | "conflicting" | "unknown";
  updatedAt: number;
  /** The Portal project (main checkout) for this repo when one exists, else null. */
  localProjectId: string | null;
  /** The Portal worktree project already on this PR's head branch, when one exists. */
  worktreeProjectId: string | null;
};

/** One line of the digest: something that changed since the previous snapshot. */
export type DigestChange = {
  kind: ItemKind;
  /** One sentence, ready to become an item title. */
  summary: string;
  /** Compact Markdown for the item body of an aggregated change (one bullet per PR); absent otherwise. */
  detail?: string;
  links: ItemLinks;
  /** The fingerprint an item for this change should carry, so the model never invents one. */
  fingerprint: string;
  /** Set when an open item with this fingerprint already exists: the model should update, not create. */
  existingItemId: string | null;
  /** Set when the condition behind an open item cleared: the model should resolve that item. */
  resolvesItemId?: string | null;
};

/** What `get_tick_digest` returns. Built deterministically; the model sees nothing else about the world unless it asks. */
export type TickDigest = {
  at: number;
  /** Timestamp of the snapshot this was diffed against; null on the very first tick. */
  since: number | null;
  changes: DigestChange[];
  /** Open and snoozed-but-expired items, briefly. */
  openItems: Pick<Item, "id" | "kind" | "title" | "fingerprint">[];
  /** Dismissed items whose condition cleared; the tick resolves them without the model. */
  released: string[];
  /** Fingerprints left out of `changes` because the user dismissed their item. */
  suppressed: string[];
};

export type TickReport = {
  id: string;
  reason: TickReason;
  startedAt: number;
  finishedAt: number;
  /** False when the pre-scan found nothing new and the model was not invoked. */
  modelInvoked: boolean;
  changes: number;
  itemsCreated: string[];
  itemsUpdated: string[];
  itemsResolved: string[];
  /** One line per thing considered and decided, for the activity log. */
  log: string[];
  error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /**
   * The model stopped at its step cap before it was done. The snapshot is then kept, so the next
   * tick offers the same changes again (items already made are matched by fingerprint); a second
   * capped tick in a row advances it anyway rather than loop.
   */
  capped?: boolean;
};

// ---------------------------------------------------------------------------------------------
// Runtime status and live events (what the API routes and the page consume)
// ---------------------------------------------------------------------------------------------

export type OrchestratorStatus = {
  /** False when no API key is stored for the configured provider; the page shows "Add API key". */
  ready: boolean;
  provider: OrchestratorProvider;
  model: string;
  /** True while a chat turn or a tick is running. */
  busy: boolean;
  intervalMinutes: number;
  idleIntervalMinutes: number;
  /** How many browsers currently hold a Portal event stream open. Drives which interval applies. */
  presence: number;
  lastTick: TickReport | null;
  nextTickAt: number | null;
  /** Threads with a chat turn running; each thread has its own lock, and jobs never take one. */
  busyThreads: string[];
  /** Runs in progress right now (chat turns and background jobs), oldest first. */
  runs: Pick<JobRun, "id" | "kind" | "jobId" | "threadId" | "startedAt" | "summary">[];
  /** The next job due, for the status line. */
  nextJob: { id: string; title: string; at: number } | null;
  counts: { needsYou: number; inbox: number; approvals: number; intents: number };
  /** One line for the live status bar: what is running, else what comes next. */
  line: string;
};

/** Pushed over `GET /api/portal/stream` (Server-Sent Events). */
export type OrchestratorEvent =
  | { type: "status"; status: OrchestratorStatus }
  /** A thread changed outside the viewer's own chat turn (a job appended a message). Refetch that thread; absent `threadId` means the main thread. */
  | { type: "messages"; threadId?: string }
  | { type: "threads"; threads: Thread[] }
  | { type: "activity"; entry: ActivityEntry }
  /** Jobs changed; refetch `/api/portal/jobs`. */
  | { type: "jobs" }
  | { type: "intents"; intents: Intent[] }
  /** A run started or finished. */
  | { type: "run"; run: JobRun }
  | { type: "approvals"; approvals: Approval[] }
  /** Memory records changed; refetch what is shown. */
  | { type: "memory"; recordIds: string[] }
  /** The world state was rebuilt. */
  | { type: "world"; at: number }
  | { type: "items"; items: Item[] }
  | { type: "tick"; report: TickReport };
