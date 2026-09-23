/**
 * Shared contract for the "Talk to Portal" orchestrator: a lightweight, model-agnostic assistant
 * that lives outside every project and session. It chats on demand and runs periodic ticks that
 * turn changes in sessions, pull requests, and worktrees into action items.
 *
 * Only erasable TypeScript here (types and plain values): these modules are imported by Node
 * directly in tests and by `server.mjs`, without a build step.
 */
import type { UIMessage } from "ai";

// ---------------------------------------------------------------------------------------------
// Settings (the pure settings module owns storage; these are the shapes it exposes)
// ---------------------------------------------------------------------------------------------

export type OrchestratorProvider = "openai" | "anthropic";
export const orchestratorProviders: readonly OrchestratorProvider[] = ["openai", "anthropic"];

/** Orchestrator settings as served to the browser: keys are reported as present/absent only. */
export type OrchestratorSettings = {
  provider: OrchestratorProvider;
  /** Provider model id, e.g. "gpt-5-mini". */
  model: string;
  /** Tick interval while at least one browser has Portal open. */
  intervalMinutes: number;
  /** Tick interval while no browser is connected. */
  idleIntervalMinutes: number;
  /** True when a key is stored for the provider. The key itself never leaves the server. */
  apiKeys: Record<OrchestratorProvider, boolean>;
};

/** PATCH shape. An empty string for a key clears it. */
export type OrchestratorSettingsPatch = {
  provider?: OrchestratorProvider;
  model?: string;
  intervalMinutes?: number;
  idleIntervalMinutes?: number;
  apiKeys?: Partial<Record<OrchestratorProvider, string>>;
};

export const defaultOrchestratorSettings: OrchestratorSettings = {
  provider: "openai",
  model: "gpt-5-mini",
  intervalMinutes: 10,
  idleIntervalMinutes: 60,
  apiKeys: { openai: false, anthropic: false },
};

// ---------------------------------------------------------------------------------------------
// Items and watches
// ---------------------------------------------------------------------------------------------

/** "needs_you" blocks on the user; "ideas" are low-urgency suggestions. */
export type ItemList = "needs_you" | "ideas";
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
  | "watch_update"
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
  watchId?: string;
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
  list: ItemList;
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

export type ItemPatch = Partial<Pick<Item, "list" | "title" | "body" | "links" | "actions" | "status" | "snoozedUntil">>;

export type WatchStatus = "active" | "done" | "cancelled";

/** A tracked intent the user gave ("review PRs 1, 2, 3 on the monorepo") that later ticks follow up on. */
export type Watch = {
  id: string;
  /** What the user asked for, in their words. */
  intent: string;
  /** The orchestrator's plan and current understanding, Markdown. It rewrites this as things progress. */
  notes: string;
  status: WatchStatus;
  links: { sessionIds: string[]; projectIds: string[]; pulls: PullRef[] };
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number | null;
};

export type WatchPatch = Partial<Pick<Watch, "intent" | "notes" | "status" | "links" | "lastCheckedAt">>;

// ---------------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------------

/** Extra data Portal keeps on each message of the one shared thread. */
export type OrchestratorMessageMetadata = {
  /** Epoch ms when the message was created. */
  at: number;
  /** Set on assistant messages produced by a scheduled or manual tick rather than a user prompt. */
  tick?: { id: string; reason: TickReason };
  /** Items created or updated by this message, shown as cards beneath it. */
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
  /** Active watches whose `lastCheckedAt` is older than the interval (or never). */
  dueWatches: Watch[];
  /** Open and snoozed-but-expired items, briefly. */
  openItems: Pick<Item, "id" | "list" | "kind" | "title" | "fingerprint">[];
  /** The user's memory file, verbatim (capped). */
  memory: string;
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
  openItems: { needs_you: number; ideas: number };
};

/** Pushed over `GET /api/portal/stream` (Server-Sent Events). */
export type OrchestratorEvent =
  | { type: "status"; status: OrchestratorStatus }
  /** The thread changed outside the viewer's own chat turn (a tick appended a message, an action added a user message). Refetch history. */
  | { type: "messages" }
  | { type: "items"; items: Item[] }
  | { type: "watches"; watches: Watch[] }
  | { type: "tick"; report: TickReport };

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/**
 * Persistence for the orchestrator, under `<PORTAL_HOME>/orchestrator/`:
 *   conversation.json  the thread (OrchestratorMessage[])
 *   items.json         Item[]
 *   watches.json       Watch[]
 *   snapshot.json      TickSnapshot | null
 *   ticks.json         the last N TickReports (newest last)
 *   memory.md          free-form notes the model and the user both edit
 * Writes are atomic (tmp + rename) and serialized. An in-memory implementation backs tests.
 */
export interface OrchestratorStore {
  ready: Promise<void>;

  readMessages(): Promise<OrchestratorMessage[]>;
  /** Replaces the thread. */
  writeMessages(messages: OrchestratorMessage[]): Promise<void>;
  appendMessages(messages: OrchestratorMessage[]): Promise<void>;

  listItems(): Promise<Item[]>;
  getItem(id: string): Promise<Item | null>;
  /** Finds the open or snoozed item with this fingerprint, if any. */
  findItemByFingerprint(fingerprint: string): Promise<Item | null>;
  createItem(item: Omit<Item, "id" | "createdAt" | "updatedAt" | "status" | "snoozedUntil"> & Partial<Pick<Item, "status" | "snoozedUntil">>): Promise<Item>;
  updateItem(id: string, patch: ItemPatch): Promise<Item>;

  listWatches(): Promise<Watch[]>;
  getWatch(id: string): Promise<Watch | null>;
  createWatch(watch: Pick<Watch, "intent" | "notes"> & Partial<Pick<Watch, "links">>): Promise<Watch>;
  updateWatch(id: string, patch: WatchPatch): Promise<Watch>;

  readSnapshot(): Promise<TickSnapshot | null>;
  writeSnapshot(snapshot: TickSnapshot): Promise<void>;

  listTicks(): Promise<TickReport[]>;
  appendTick(report: TickReport): Promise<void>;

  readMemory(): Promise<string>;
  writeMemory(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Runtime (implemented in ./runtime.ts, consumed by src/app/api/portal/**)
// ---------------------------------------------------------------------------------------------

export interface OrchestratorRuntime {
  ready: Promise<void>;
  status(): Promise<OrchestratorStatus>;
  history(): Promise<OrchestratorMessage[]>;
  /**
   * Runs one chat turn for the user's newest message. Returns the AI SDK UI message stream response
   * (`toUIMessageStreamResponse`); the runtime persists the user message immediately and the
   * assistant message when the stream finishes, then emits a `messages` event.
   * Rejects with an Error whose `status` is 409 when the runtime is not ready (no API key) or busy.
   */
  chat(userMessage: OrchestratorMessage): Promise<Response>;
  /** Cancels the running chat turn or tick, if any. */
  cancel(): void;
  runTick(reason: TickReason): Promise<TickReport>;

  listItems(): Promise<Item[]>;
  updateItem(id: string, patch: ItemPatch): Promise<Item>;
  /** Executes one of an item's actions server-side (open_* actions are browser-only and rejected here). */
  performAction(itemId: string, actionIndex: number): Promise<{ sessionId?: string }>;
  listWatches(): Promise<Watch[]>;
  updateWatch(id: string, patch: WatchPatch): Promise<Watch>;
  listTicks(): Promise<TickReport[]>;
  readMemory(): Promise<string>;
  writeMemory(text: string): Promise<void>;

  // Browser presence (which interval applies) comes from `src/lib/presence.ts`, a process-wide
  // counter that every SSE route opens/closes; the runtime subscribes to it rather than being told.

  subscribe(listener: (event: OrchestratorEvent) => void): () => void;
  /** Stops the scheduler and any in-flight turn. */
  dispose(): Promise<void>;
}

/**
 * HTTP surface (all same-origin checked like the rest of Portal):
 *   GET    /api/portal                 { status }
 *   GET    /api/portal/messages        { messages }
 *   POST   /api/portal/messages        body { message: OrchestratorMessage } -> UI message stream
 *   POST   /api/portal/cancel          -> 204
 *   POST   /api/portal/tick            -> { report }
 *   GET    /api/portal/items           { items }
 *   PATCH  /api/portal/items/[id]      body ItemPatch -> { item }
 *   POST   /api/portal/items/[id]/actions/[index] -> { sessionId? }
 *   GET    /api/portal/watches         { watches }
 *   PATCH  /api/portal/watches/[id]    body WatchPatch -> { watch }
 *   GET    /api/portal/ticks           { ticks }
 *   GET    /api/portal/memory          { memory }
 *   PUT    /api/portal/memory          body { memory } -> { memory }
 *   GET    /api/portal/stream          SSE of OrchestratorEvent; opens with `status`, `items`, `watches`
 */
