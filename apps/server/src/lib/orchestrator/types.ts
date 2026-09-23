/**
 * Server-side contract for the orchestrator: the store and runtime interfaces. The wire types
 * (items, watches, messages, ticks, status, events, settings shapes) live in
 * `@portal/contracts/orchestrator`, shared with the browser, and are re-exported here so the
 * server's modules keep importing everything from one place.
 */
import type {
  Item, ItemPatch, OrchestratorEvent, OrchestratorMessage, OrchestratorStatus, TickReason, TickReport, TickSnapshot, Watch, WatchPatch,
} from "@portal/contracts/orchestrator";

export * from "@portal/contracts/orchestrator";

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/**
 * Persistence for the orchestrator, in Postgres (`orchestrator_*` tables, see `src/db/schema.ts`):
 * one row per message, item, watch, and tick report; the snapshot and the memory text are single
 * documents. Changes to one kind of record are serialized so read-modify-writes never lose each
 * other's work. An in-memory implementation backs tests.
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
// Runtime (implemented in ./runtime.ts, consumed by src/orchestrator/routes.ts)
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

  // Browser presence (which interval applies) comes from the presence counter in the context, which
  // every SSE route opens/closes; the runtime subscribes to it rather than being told.

  subscribe(listener: (event: OrchestratorEvent) => void): () => void;
  /** Stops the scheduler and any in-flight turn. */
  dispose(): Promise<void>;
}
