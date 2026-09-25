/**
 * Wire types for "Talk to Portal", the orchestrator: a coordinator that lives outside every project
 * and session. It chats in threads, knows the user's world (refreshed quietly in the background and
 * diffed into a change log its chat turns read), runs the background jobs the agent schedules
 * (intent checks, helpers, memory curation), keeps curated memory, and asks before anything
 * irreversible. The server owns the runtime and its stores; the browser reads these shapes
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
  /** The bookkeeping role (intent checks and other cheap background turns): a cheap model, possibly on another provider. */
  bookkeeping: ModelChoice;
  /** When the memory curation pass runs. */
  consolidation: ConsolidationSettings;
  /** How Portal treats the review sessions it starts. */
  reviews: ReviewSettings;
  /** When a session counts as stalled. */
  stalls: StallSettings;
  /** True when a key is stored for the provider. The key itself never leaves the server. */
  apiKeys: Record<OrchestratorProvider, boolean>;
};

/**
 * Review sessions run unattended. With `answerReadOnly`, Portal answers their permission requests
 * for read-only steps (file reads, searches, shell commands its read-only checker vouches for) with
 * "allow once", each answer marked as Portal's in the transcript; everything else waits for the
 * user as before. Off, every request waits for the user.
 */
export type ReviewSettings = {
  answerReadOnly: boolean;
};

/**
 * A session with an open turn is hung once neither its processes used CPU nor the agent produced
 * output for `hungAfterMinutes`. Hung and dead sessions are the only ones Portal calls stalled.
 */
export type StallSettings = {
  hungAfterMinutes: number;
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
  consolidation?: Partial<ConsolidationSettings>;
  reviews?: Partial<ReviewSettings>;
  stalls?: Partial<StallSettings>;
  apiKeys?: Partial<Record<OrchestratorProvider, string>>;
};

export const defaultOrchestratorSettings: OrchestratorSettings = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  bookkeeping: { provider: "anthropic", model: "claude-haiku-4-5" },
  consolidation: { nightlyAt: "03:00", inboxThreshold: 10, minIntervalMinutes: 60 },
  reviews: { answerReadOnly: true },
  stalls: { hungAfterMinutes: 15 },
  apiKeys: { openai: false, anthropic: false },
};

/** The two jobs a model does: talking with the user and curating (frontier), and background bookkeeping such as intent checks (cheap). */
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
  /** A session's turn ended because it was cancelled (Stop, cancel_turn, stop_session). */
  | "session_stopped"
  | "session_waiting"
  | "session_offline"
  | "session_hung"
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
  /** Stable identity of the underlying condition, e.g. "pr:owner/repo#42". Dedupes items; a dismissal holds for it until the condition clears. */
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
  /**
   * Set on the "Scheduled check" notes the tick posted before it became a silent world refresh. No
   * new message carries it; old ones keep it so the thread still labels them.
   */
  tick?: { id: string; reason: TickReason };
  /** The run that produced an assistant message (chat turn, helper, intent check, curation). */
  run?: { id: string; kind: JobRun["kind"] };
  /** Items created or updated by this message. The thread does not show them (they live in Needs you); the audit trail does. */
  itemIds?: string[];
};

export type OrchestratorMessage = UIMessage<OrchestratorMessageMetadata>;

// ---------------------------------------------------------------------------------------------
// Snapshots (what each full world refresh diffs against the previous one)
// ---------------------------------------------------------------------------------------------

/** Why an old tick ran; only old "Scheduled check" notes still carry it (see `OrchestratorMessageMetadata.tick`). */
export type TickReason = "schedule" | "manual";

/** Everything a full world refresh compares with the previous one. Kept small: ids and states, no bodies. */
export type TickSnapshot = {
  at: number;
  sessions: Record<string, {
    activity: "idle" | "working" | "waiting" | "connecting" | "error";
    lastActiveAt: number;
    title: string | null;
    projectId: string;
    /** The agent link at snapshot time; "finished" only counts between two live readings. Absent in snapshots from before this field. */
    link?: "live" | "connecting" | "offline";
    /** Set when the session went idle since the previous snapshot because its turn was cancelled. */
    stopped?: true;
    /** The derived liveness state (see `SessionLiveness`). Absent in snapshots from before this field. */
    liveness?: "dead" | "blocked" | "busy" | "hung" | "idle";
    /** For a dead or hung session, what its liveness summary said (why the agent was lost, or how long it has been quiet). */
    stall?: string;
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
  /** When the PR was opened. Absent in snapshots and builds from before this field. */
  createdAt?: number | null;
  /**
   * When its head commit was made: the cheap stand-in for the last push that the search can give
   * (GitHub no longer reports push times). Absent in snapshots and builds from before this field.
   */
  pushedAt?: number | null;
  /** The Portal project (main checkout) for this repo when one exists, else null. */
  localProjectId: string | null;
  /** The Portal worktree project already on this PR's head branch, when one exists. */
  worktreeProjectId: string | null;
};

// ---------------------------------------------------------------------------------------------
// Runtime status and live events (what the API routes and the page consume)
// ---------------------------------------------------------------------------------------------

export type OrchestratorStatus = {
  /** False when no API key is stored for the configured provider; the page shows "Add API key". */
  ready: boolean;
  provider: OrchestratorProvider;
  model: string;
  /** True while a chat turn is running. */
  busy: boolean;
  /** How many browsers currently hold a Portal event stream open. Jobs with an idle cadence follow it. */
  presence: number;
  /** Threads with a chat turn running; each thread has its own lock, and jobs never take one. */
  busyThreads: string[];
  /** Runs in progress right now (chat turns and background jobs), oldest first. The world refresh is not listed. */
  runs: Pick<JobRun, "id" | "kind" | "jobId" | "threadId" | "startedAt" | "summary">[];
  /** The next job due, for the status line (never the world refresh). */
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
  | { type: "items"; items: Item[] };
