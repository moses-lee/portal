/**
 * Server-side contract for the orchestrator: the store and runtime interfaces. The wire types
 * (items, watches, messages, ticks, status, events, settings shapes) live in
 * `@portal/contracts/orchestrator`, shared with the browser, and are re-exported here so the
 * server's modules keep importing everything from one place.
 */
import type {
  Item, ItemPatch, OrchestratorEvent, OrchestratorMessage, OrchestratorStatus, Scope, Thread, TickReason, TickReport, TickSnapshot, Watch, WatchPatch,
} from "@portal/contracts/orchestrator";

import type { OrchestratorHub } from "./hub.ts";

export * from "@portal/contracts/orchestrator";

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/** A side thread as the agent opens it. */
export type ThreadInput = { title: string; scope?: Partial<Scope>; intentId?: string | null };
export type ThreadPatch = Partial<Pick<Thread, "title" | "status" | "scope" | "intentId">>;

/**
 * Persistence for the orchestrator, in Postgres (`orchestrator_*` tables, see `src/db/schema.ts`):
 * one row per message, item, watch, and tick report; the snapshot and the memory text are single
 * documents. Changes to one kind of record are serialized so read-modify-writes never lose each
 * other's work. An in-memory implementation backs tests.
 */
export interface OrchestratorStore {
  ready: Promise<void>;

  /** A thread's messages in order; `threadId` defaults to the main thread. */
  readMessages(threadId?: string): Promise<OrchestratorMessage[]>;
  /** Replaces the thread's messages. */
  writeMessages(messages: OrchestratorMessage[], threadId?: string): Promise<void>;
  /** Appends to the thread and moves its `lastMessageAt`. */
  appendMessages(messages: OrchestratorMessage[], threadId?: string): Promise<void>;

  /** Every thread, the main one first, then side threads newest first. */
  listThreads(): Promise<Thread[]>;
  getThread(id: string): Promise<Thread | null>;
  createThread(input: ThreadInput): Promise<Thread>;
  updateThread(id: string, patch: ThreadPatch): Promise<Thread>;

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
  /** The shared parts and domain services; domain routes reach their service through it. */
  hub: OrchestratorHub;
  status(): Promise<OrchestratorStatus>;
  listThreads(): Promise<Thread[]>;
  /** A thread's messages; the main thread when `threadId` is omitted. */
  history(threadId?: string): Promise<OrchestratorMessage[]>;
  /**
   * Runs one chat turn in a thread (default: main) for the user's newest message. Returns the AI
   * SDK UI message stream response (`toUIMessageStreamResponse`); the runtime persists the user
   * message immediately and the assistant message when the stream finishes, then emits a
   * `messages` event. Each thread has its own lock: rejects with status 409 while that thread is
   * answering or when no key is stored, 404 for an unknown thread. Jobs never block it.
   */
  chat(userMessage: OrchestratorMessage, threadId?: string): Promise<Response>;
  /** Cancels the chat turn running in a thread (default: main), if any. Background jobs keep going. */
  cancel(threadId?: string): void;
  runTick(reason: TickReason): Promise<TickReport>;

  listItems(): Promise<Item[]>;
  updateItem(id: string, patch: ItemPatch): Promise<Item>;
  /**
   * Executes one of an item's actions server-side (open_* actions are browser-only and rejected
   * here). Only open or snoozed items act (409 otherwise). An action the approval gate holds back
   * answers `{ approvalId }` and runs once approved.
   */
  performAction(itemId: string, actionIndex: number): Promise<{ sessionId?: string; promptError?: string; approvalId?: string }>;
  listWatches(): Promise<Watch[]>;
  updateWatch(id: string, patch: WatchPatch): Promise<Watch>;
  listTicks(): Promise<TickReport[]>;
  readMemory(): Promise<string>;
  writeMemory(text: string): Promise<void>;

  // Browser presence (which interval applies) comes from the presence counter in the context, which
  // every SSE route opens/closes; the runtime subscribes to it rather than being told.

  subscribe(listener: (event: OrchestratorEvent) => void): () => void;
  /** Stops the scheduler, the job worker, and any in-flight turn. */
  dispose(): Promise<void>;
}
