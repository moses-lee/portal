/**
 * Server-side contract for the orchestrator: the store and runtime interfaces. The wire types
 * (items, messages, snapshots, status, events, settings shapes) live in
 * `@portal/contracts/orchestrator`, shared with the browser, and are re-exported here so the
 * server's modules keep importing everything from one place.
 */
import type {
  BulkItemStatus, BulkItemsResponse, Item, ItemPatch, ItemStatus, MessagePage, OrchestratorEvent, OrchestratorMessage, OrchestratorStatus, TickSnapshot,
} from "@portal/contracts/orchestrator";
import type { WorkspaceView } from "@portal/contracts/workspace";
import type { QueuedPrompt } from "@portal/contracts/types";

import type { OrchestratorHub } from "./hub.ts";

export * from "@portal/contracts/orchestrator";

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/** A stored message with its position in the chat (the store's ordinal; the paging cursor). */
export type MessageRow = { ordinal: number; message: OrchestratorMessage };

/** One page of the chat: the newest `limit` messages, those before a cursor, or those after one. */
export type MessagePageQuery = { before?: number; after?: number; limit: number };

export type ItemFilter = { status?: ItemStatus[] };

/**
 * Persistence for the orchestrator, in Postgres (`orchestrator_*` tables, see `src/db/schema.ts`):
 * one row per message and item; the snapshot and the memory text are single documents (jobs, runs,
 * and intents have their own store, see `jobs/store.ts`). Changes to one kind of record are serialized so read-modify-writes never lose each
 * other's work. An in-memory implementation backs tests.
 */
export interface OrchestratorStore {
  ready: Promise<void>;

  /** The chat's messages in order. */
  readMessages(): Promise<OrchestratorMessage[]>;
  /** The chat's messages with their ordinals, oldest first. */
  readMessageRows(): Promise<MessageRow[]>;
  /** One page of the chat (see `MessagePage`); ordinals are the cursors. */
  readMessagePage(query: MessagePageQuery): Promise<MessagePage>;
  /** One message by its id, or null. */
  getMessage(id: string): Promise<OrchestratorMessage | null>;
  /** Replaces the chat's messages (the importer); ordinals are reassigned. */
  writeMessages(messages: OrchestratorMessage[]): Promise<void>;
  /** Appends to the chat. */
  appendMessages(messages: OrchestratorMessage[]): Promise<void>;
  /** Drops the messages at or below `ordinal` (trimming the chat's head in place). */
  deleteMessagesThrough(ordinal: number): Promise<void>;
  /** Replaces one stored message, keeping its ordinal (trimming tool traffic in place). */
  replaceMessage(ordinal: number, message: OrchestratorMessage): Promise<void>;

  /** Items newest first; all of them, or those in the given statuses. */
  listItems(filter?: ItemFilter): Promise<Item[]>;
  getItem(id: string): Promise<Item | null>;
  /** Finds the open or snoozed item with this fingerprint, if any. */
  findItemByFingerprint(fingerprint: string): Promise<Item | null>;
  createItem(item: Omit<Item, "id" | "createdAt" | "updatedAt" | "status" | "snoozedUntil"> & Partial<Pick<Item, "status" | "snoozedUntil">>): Promise<Item>;
  updateItem(id: string, patch: ItemPatch): Promise<Item>;

  readSnapshot(): Promise<TickSnapshot | null>;
  writeSnapshot(snapshot: TickSnapshot): Promise<void>;

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
  /**
   * One page of the chat: the newest `limit` messages, or those before/after a cursor. Tool parts
   * come without their input and output (`toolIO: "omitted"`); `message` has the whole message.
   */
  history(query?: Partial<MessagePageQuery>): Promise<MessagePage>;
  /** One message in full, or null. */
  message(id: string): Promise<OrchestratorMessage | null>;
  /**
   * Runs one chat turn for the user's newest message. Returns the AI SDK UI message stream response
   * (`toUIMessageStreamResponse`); the runtime persists the user message immediately and the
   * assistant message when the stream finishes, then emits a `messages` event. One turn at a time:
   * rejects with status 409 while Portal is answering or when no key is stored. Jobs never block it.
   * `view` is what the sending device is looking at (docs/WORKSPACE.md); the turn's prompt names it.
   */
  chat(userMessage: OrchestratorMessage, view?: WorkspaceView | null): Promise<Response>;
  /** Cancels the running chat turn, if any, and drops the queue. Background jobs keep going. */
  cancel(): QueuedPrompt[];
  /** The chat's composer; the same editing, pause, and stop semantics as session queues. */
  queue(): QueuedPrompt[];
  enqueue(text: string, view?: WorkspaceView | null): Promise<{ queued: QueuedPrompt; position: number }>;
  updateQueued(id: string, text: string): QueuedPrompt;
  beginQueueEdit(id: string): QueuedPrompt;
  cancelQueueEdit(id: string): QueuedPrompt | null;
  removeQueued(id: string): QueuedPrompt | null;

  listItems(filter?: ItemFilter): Promise<Item[]>;
  updateItem(id: string, patch: ItemPatch): Promise<Item>;
  /**
   * Moves every item in `ids` to `status` (the attention page's bulk resolve or dismiss). Unknown ids
   * are skipped and listed in `missing`; one activity entry stands for the batch, and items and
   * status are pushed once.
   */
  updateItems(ids: string[], status: BulkItemStatus): Promise<BulkItemsResponse>;
  /**
   * Executes one of an item's actions server-side (open_* actions are browser-only and rejected
   * here). Only open or snoozed items act (409 otherwise). An action the approval gate holds back
   * answers `{ approvalId }` and runs once approved.
   */
  performAction(itemId: string, actionIndex: number): Promise<{ sessionId?: string; promptError?: string; approvalId?: string }>;

  // Browser presence (which cadence presence-aware jobs follow) comes from the presence counter in the context, which
  // every SSE route opens/closes; the runtime subscribes to it rather than being told.

  subscribe(listener: (event: OrchestratorEvent) => void): () => void;
  /** Stops the job worker and any in-flight turn. */
  dispose(): Promise<void>;
}
