/**
 * The orchestrator runtime: threads the user chats in (each with its own lock), the background jobs
 * (the jobs service runs them, the silent hourly world refresh among them), and the events the page
 * follows. It builds the
 * hub (see `hub.ts`) over whatever store, settings, deps, clock, and model it is given (tests pass
 * fakes) and attaches the domain services; `createOrchestratorService` in `service.ts` wires the
 * live server into it.
 */
import { randomUUID } from "node:crypto";
import { type LanguageModel, consumeStream, convertToModelMessages, pruneMessages } from "ai";
import type { Sql } from "postgres";
import type { Db } from "../db/client.ts";
import { type ActivityStore, createMemoryActivityStore } from "./activity/store.ts";
import { createActivityService } from "./activity/service.ts";
import { CALL_TIMEOUT_MS, createOrchestratorAgent } from "./agent.ts";
import { isServerAction, runItemAction } from "./approvals/card-actions.ts";
import { createApprovalsService } from "./approvals/service.ts";
import type { OrchestratorDeps, OrchestratorSettingsStore } from "./deps.ts";
import { settleReviewWorktree } from "./jobs/review-cleanup.ts";
import { createReviewPermissionAdvisor } from "./jobs/review-permissions.ts";
import type { ApprovalsService, JobsService, MemoryService, OrchestratorHub, PresenceSource, WorldService } from "./hub.ts";
import { createJobsService } from "./jobs/service.ts";
import { createMemoryService } from "./memory/service.ts";
import { buildLanguageModel, providerOptionsFor, roleChoice } from "./model.ts";
import { httpError } from "./ops.ts";
import { type SchedulerTimers, realTimers } from "./jobs/timers.ts";
import { prepareTurn, runUsage } from "./turn.ts";
import type {
  Item, ItemPatch, OrchestratorEvent, OrchestratorMessage, OrchestratorRuntime, OrchestratorSettings, OrchestratorStatus, OrchestratorStore,
} from "./types.ts";
import { MAIN_THREAD_ID } from "./types.ts";
import { createWorldService } from "./world/service.ts";

/** Messages of the thread a chat turn sends to the model, at most. */
export const HISTORY_WINDOW = 40;
/** Rough tokens of history a chat turn sends; older messages beyond it are left out. */
export const HISTORY_BUDGET_TOKENS = 12_000;
/** Messages the stored thread keeps; older ones are dropped. */
export const MAX_THREAD_MESSAGES = 200;
/** What a tool part's input and output become once the message left the history window. */
export const TRIMMED_TOOL_IO = "[trimmed from history]";
/** A user's chat turn runs a full world refresh first when the newest full build is older than this. */
export const CHAT_REFRESH_AFTER_MS = 5 * 60_000;
export type { PresenceSource } from "./hub.ts";

/** Builders for the domain services; tests and the live server swap in their own. */
export type DomainFactories = {
  jobs?: (hub: OrchestratorHub) => JobsService;
  world?: (hub: OrchestratorHub) => WorldService;
  memory?: (hub: OrchestratorHub) => MemoryService;
  approvals?: (hub: OrchestratorHub) => ApprovalsService;
};

export type OrchestratorRuntimeOptions = {
  store: OrchestratorStore;
  settingsStore: OrchestratorSettingsStore;
  deps: OrchestratorDeps;
  timers?: SchedulerTimers;
  /** Open browser streams; the app's counter (`ctx.presence`), or a fake in tests. */
  presence: PresenceSource;
  /** Builds the model for a turn from the settings and the stored key; tests pass a mock. */
  model?: (settings: OrchestratorSettings, apiKey: string) => LanguageModel;
  /** The live database, for the Postgres-backed domain stores; omitted in tests (in-memory stores). */
  db?: Db | null;
  /** The postgres.js client behind `db`, for LISTEN/NOTIFY. */
  sql?: Sql | null;
  /** Where activity is recorded; in memory unless given. */
  activityStore?: ActivityStore;
  domains?: DomainFactories;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The text of a message's text parts, joined. */
function messageText(message: OrchestratorMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** Events after which the status (line and counts) is pushed again, coalesced into one push. */
const statusSources = new Set<OrchestratorEvent["type"]>(["run", "jobs", "intents", "items", "memory", "approvals"]);

/** Item statuses a user change moves to, as activity kinds. */
const itemChangeKind: Record<string, string> = { resolved: "item.resolved", dismissed: "item.dismissed" };

type Part = OrchestratorMessage["parts"][number];

function isToolPart(part: Part): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/**
 * A tool part with its traffic replaced by a placeholder, or null when there was nothing left to
 * trim. The type, name, and state stay so the UI still shows "Ran X".
 */
function trimToolPart(part: Part): Part | null {
  const record = part as unknown as Record<string, unknown>;
  const fields = ["input", "output", "rawInput"].filter((field) => field in record && record[field] !== TRIMMED_TOOL_IO);
  if (fields.length === 0) return null;
  const trimmed: Record<string, unknown> = { ...record };
  for (const field of fields) trimmed[field] = TRIMMED_TOOL_IO;
  return trimmed as unknown as Part;
}

/**
 * Whether a user's chat turn should refresh the world (GitHub included) before it starts: when no
 * full build exists yet, or the newest is older than `maxAgeMs`. The refresh also brings the change
 * log up to date, so the turn's Recent changes section is current.
 */
export function needsChatRefresh(lastFullAt: number | null, now: number, maxAgeMs = CHAT_REFRESH_AFTER_MS): boolean {
  return lastFullAt === null || now - lastFullAt > maxAgeMs;
}

/**
 * The thread as it should be stored: at most `MAX_THREAD_MESSAGES`, and messages the next chat turn
 * will not send any more (older than `HISTORY_WINDOW`) keep their text but lose their tool inputs and
 * outputs, which is where a thread's bulk lives. `changed` is false when nothing had to move.
 */
export function trimThread(messages: OrchestratorMessage[]): { messages: OrchestratorMessage[]; changed: boolean } {
  let changed = messages.length > MAX_THREAD_MESSAGES;
  const kept = messages.slice(-MAX_THREAD_MESSAGES);
  const outsideWindow = Math.max(0, kept.length - HISTORY_WINDOW);
  const result = kept.map((message, index) => {
    if (index >= outsideWindow) return message;
    let touched = false;
    const parts = message.parts.map((part) => {
      const next = isToolPart(part) ? trimToolPart(part) : null;
      if (next) touched = true;
      return next ?? part;
    });
    if (!touched) return message;
    changed = true;
    return { ...message, parts };
  });
  return { messages: result, changed };
}

/**
 * A message's rough size as the model will see it. Tool traffic before the newest message is pruned
 * from the request, so only text counts there; the newest message counts whole.
 */
function messageTokens(message: OrchestratorMessage, newest: boolean): number {
  const chars = newest ? JSON.stringify(message.parts).length : message.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  return Math.ceil(chars / 4);
}

/**
 * The thread window a chat turn sends: the newest messages, at most `HISTORY_WINDOW` and about
 * `HISTORY_BUDGET_TOKENS`, starting at a user message. The newest message is always kept.
 */
export function historyWindow(messages: OrchestratorMessage[], budgetTokens = HISTORY_BUDGET_TOKENS): OrchestratorMessage[] {
  const recent = messages.slice(-HISTORY_WINDOW);
  let start = recent.length;
  let used = 0;
  while (start > 0) {
    const cost = messageTokens(recent[start - 1], start === recent.length);
    if (start < recent.length && used + cost > budgetTokens) break;
    used += cost;
    start--;
  }
  const kept = recent.slice(start);
  const firstUser = kept.findIndex((message) => message.role === "user");
  return firstUser > 0 ? kept.slice(firstUser) : kept;
}

export function createOrchestratorRuntime({
  store, settingsStore, deps, timers = realTimers, presence, model: buildModel = buildLanguageModel, db = null, sql = null,
  activityStore = createMemoryActivityStore(), domains = {},
}: OrchestratorRuntimeOptions): OrchestratorRuntime {
  const listeners = new Set<(event: OrchestratorEvent) => void>();
  /** The chat turn running in each thread; a thread takes one turn at a time. */
  const chatTurns = new Map<string, AbortController>();
  let disposed = false;
  let statusQueued = false;

  function emit(event: OrchestratorEvent) {
    // Runs, jobs, intents, items, memory (the inbox), and approvals all feed the status line and its counts.
    if (statusSources.has(event.type) && !statusQueued) {
      statusQueued = true;
      queueMicrotask(() => {
        statusQueued = false;
        void emitStatus();
      });
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        // A subscriber's bug must not fail the turn or starve the other subscribers.
        console.error("Orchestrator listener failed:", err);
      }
    }
  }

  // Services read their siblings from the hub at call time, so the order below does not matter.
  const hub = {
    store, settings: settingsStore, deps, presence, timers, db, sql, emit,
    async model(role) {
      const settings = await settingsStore.orchestrator();
      const choice = roleChoice(settings, role);
      const apiKey = await settingsStore.apiKey(choice.provider);
      if (!apiKey) return null;
      return { role, choice, model: buildModel({ ...settings, ...choice }, apiKey), providerOptions: providerOptionsFor(choice.provider) };
    },
  } as OrchestratorHub;
  hub.activity = createActivityService({ store: activityStore, emit, now: () => timers.now() });
  hub.jobs = (domains.jobs ?? ((h: OrchestratorHub) => createJobsService(h, { trimThread: trimStoredThread })))(hub);
  hub.world = (domains.world ?? createWorldService)(hub);
  hub.memory = (domains.memory ?? createMemoryService)(hub);
  hub.approvals = (domains.approvals ?? createApprovalsService)(hub);

  // Never rejects: everything awaits it, and the job worker starts from it.
  const ready = Promise.all([store.ready, hub.jobs.ready, hub.world.ready, hub.memory.ready, hub.approvals.ready]).then(() => {})
    .catch((err) => { console.error("Could not start the Portal orchestrator:", err); });

  const emitStatus = () => status().then((current) => emit({ type: "status", status: current })).catch(() => {});
  const emitItems = () => store.listItems().then((items) => emit({ type: "items", items })).catch(() => {});

  async function settingsAndKey() {
    const settings = await settingsStore.orchestrator();
    return { settings, apiKey: await settingsStore.apiKey(settings.provider) };
  }

  // The jobs service replans every presence-aware job itself; the page needs the new status.
  const unsubscribePresence = presence.subscribe(() => { void emitStatus(); });
  const unsubscribeSettings = settingsStore.subscribe(() => { void emitStatus(); });
  void ready.then(() => {
    if (disposed) return;
    hub.jobs.start();
    // Review sessions run unattended: Portal answers their read-only permission requests itself.
    deps.sessions.setPermissionAdvisor(createReviewPermissionAdvisor(hub));
  });

  /** Keep a stored thread bounded; runs after every persisted turn. */
  async function trimStoredThread(threadId: string) {
    try {
      const { messages, changed } = trimThread(await store.readMessages(threadId));
      if (changed) await store.writeMessages(messages, threadId);
    } catch (err) {
      console.error("Could not trim a Portal thread:", err);
    }
  }

  /**
   * Before a user's chat turn builds its context: a full world refresh when the last one is stale,
   * sharing any refresh already in flight. Never throws; a turn goes ahead on the world it has.
   */
  async function refreshBeforeChat(): Promise<void> {
    try {
      if (needsChatRefresh(await hub.world.lastFullAt(), timers.now())) await hub.world.refresh("chat");
    } catch (err) {
      console.error(`Could not refresh the world before a chat turn (${errorMessage(err)}).`);
    }
  }

  function releaseChat(threadId: string, controller: AbortController) {
    if (chatTurns.get(threadId) === controller) chatTurns.delete(threadId);
  }

  /** The status bar's line: what is running, else what comes next (the world refresh is never either). */
  function statusLine(runs: OrchestratorStatus["runs"], nextJob: OrchestratorStatus["nextJob"], ready: boolean): string {
    if (!ready) return "Add an API key in Settings to start Portal.";
    if (runs.length > 0) {
      const names = runs.map((run) => run.summary ?? (run.kind === "chat" ? "Answering" : `Running ${run.kind}`));
      return `${[...new Set(names)].join(" · ")}…`;
    }
    return nextJob ? `Idle · next: ${nextJob.title}` : "Idle";
  }

  async function status(): Promise<OrchestratorStatus> {
    await ready;
    const { settings, apiKey } = await settingsAndKey();
    const [items, nextDue, inbox, approvals, intents] = await Promise.all([
      store.listItems(), hub.jobs.nextDue(), hub.memory.inboxCount(), hub.approvals.pending(), hub.jobs.listIntents({ status: ["active"] }),
    ]);
    const needsYou = items.filter((item) => item.status === "open").length;
    const running = hub.jobs.running();
    const runs = running.map(({ id, kind, jobId, threadId, startedAt, summary }) => ({ id, kind, jobId, threadId, startedAt, summary }));
    const nextJob = nextDue?.nextRunAt != null ? { id: nextDue.id, title: nextDue.title, at: nextDue.nextRunAt } : null;
    return {
      ready: !!apiKey, provider: settings.provider, model: settings.model, busy: chatTurns.size > 0, presence: presence.count(),
      busyThreads: [...chatTurns.keys()], runs, nextJob,
      counts: { needsYou, inbox, approvals: approvals.length, intents: intents.length },
      line: statusLine(runs, nextJob, !!apiKey),
    };
  }

  async function chat(userMessage: OrchestratorMessage, threadId: string = MAIN_THREAD_ID): Promise<Response> {
    await ready;
    if (disposed) throw httpError("Portal is shutting down.", 409);
    const thread = await store.getThread(threadId);
    if (!thread) throw httpError(`Unknown thread "${threadId}".`, 404);
    if (thread.status !== "active") throw httpError("This thread is archived.", 409);
    const { settings, apiKey } = await settingsAndKey();
    if (!apiKey) throw httpError(`No ${settings.provider} API key is stored. Add one in Settings to talk to Portal.`, 409);
    if (chatTurns.has(threadId)) throw httpError("Portal is still answering in this thread; wait for it or cancel it.", 409);
    const controller = new AbortController();
    chatTurns.set(threadId, controller);
    void emitStatus();
    const touched = new Set<string>();
    const at = timers.now();
    let prepared: Awaited<ReturnType<typeof prepareTurn>> = null;
    try {
      // Ids are the thread's React keys and the SDK's merge handle, so a client id that is already taken gets replaced.
      const taken = new Set((await store.readMessages(threadId)).map((stored) => stored.id));
      const id = userMessage.id && !taken.has(userMessage.id) ? userMessage.id : randomUUID();
      const message: OrchestratorMessage = { ...userMessage, id, role: "user", metadata: { ...userMessage.metadata, at } };
      await store.appendMessages([message], threadId);
      await refreshBeforeChat();
      const recent = historyWindow(await store.readMessages(threadId));
      const text = messageText(message);
      prepared = await prepareTurn(hub, {
        kind: "chat", role: "chat", trigger: "user", threadId, interactive: true, query: text, touched,
        summary: threadId === MAIN_THREAD_ID ? "Answering" : `Answering in ${thread.title}`,
      });
      if (!prepared) throw httpError(`No ${settings.provider} API key is stored. Add one in Settings to talk to Portal.`, 409);
      const turn = prepared;
      // Older turns keep their text but lose their tool traffic: the model answers from what it said, not from every listing it fetched.
      const modelMessages = pruneMessages({
        messages: await convertToModelMessages(recent, { tools: turn.tools, ignoreIncompleteToolCalls: true }),
        reasoning: "all",
        toolCalls: "before-last-message",
      });
      const agent = createOrchestratorAgent({
        model: turn.model.model, tools: turn.tools, system: turn.system, providerOptions: turn.model.providerOptions, loader: turn.loader,
      });
      const result = await agent.stream({ messages: modelMessages, abortSignal: controller.signal, timeout: CALL_TIMEOUT_MS });
      let settled = false;
      return result.toUIMessageStreamResponse<OrchestratorMessage>({
        originalMessages: recent,
        generateMessageId: randomUUID,
        // The assistant message carries its own time, not the user message's. The `start` part is
        // emitted before the model answers, so the stored value is the one set when the turn finishes.
        messageMetadata: ({ part }) => {
          if (part.type === "start") return { at: timers.now(), run: { id: turn.run.id, kind: "chat" as const } };
          if (part.type === "finish") return { at: timers.now(), run: { id: turn.run.id, kind: "chat" as const }, itemIds: [...touched] };
          return undefined;
        },
        onFinish: async ({ responseMessage, isAborted }) => {
          if (settled) return;
          settled = true;
          if (responseMessage.parts.length > 0) {
            await store.appendMessages([responseMessage], threadId).catch((err: unknown) => console.error("Could not save the assistant message:", err));
          }
          await trimStoredThread(threadId);
          const usage = await Promise.resolve(result.totalUsage).then(runUsage, () => null);
          await turn.finish({ status: isAborted || controller.signal.aborted ? "cancelled" : "succeeded", usage, summary: text.slice(0, 120) });
          void hub.activity.log({
            actor: "user", kind: "chat.turn", summary: `Asked: ${text.slice(0, 160)}`,
            refs: { threadId, runId: turn.run.id }, detail: { items: [...touched] },
          });
          releaseChat(threadId, controller);
          emit({ type: "messages", threadId });
          void emitStatus();
          if (touched.size > 0) void emitItems();
        },
        onError: (err) => {
          console.error("Orchestrator chat failed:", err);
          return errorMessage(err);
        },
        // Finish (and persist) even when the browser closes the stream early.
        consumeSseStream: ({ stream }) => consumeStream({ stream }),
      });
    } catch (err) {
      await prepared?.finish({ status: "failed", error: errorMessage(err) });
      releaseChat(threadId, controller);
      void emitStatus();
      throw err;
    }
  }

  async function performAction(itemId: string, actionIndex: number): Promise<{ sessionId?: string; promptError?: string; approvalId?: string }> {
    await ready;
    const item = await store.getItem(itemId);
    if (!item) throw httpError(`Unknown item "${itemId}".`, 404);
    if (item.status !== "open" && item.status !== "snoozed") throw httpError(`This item is ${item.status}; its actions no longer run.`, 409);
    const action = item.actions[actionIndex];
    if (!action) throw httpError("The item has no such action.", 404);
    if (!isServerAction(action)) throw httpError(`The ${action.type} action runs in the browser.`, 400);
    const approval = await hub.approvals.guardAction(item, actionIndex, action);
    const refs = { itemId, ...(item.links.projectId ? { projectId: item.links.projectId } : {}), ...(item.links.sessionId ? { sessionId: item.links.sessionId } : {}) };
    if (approval) {
      void hub.activity.log({ actor: "user", kind: "item.action", summary: `Asked to run "${action.label ?? action.type}" on ${item.title}; waiting for approval`, refs: { ...refs, approvalId: approval.id } });
      return { approvalId: approval.id };
    }
    // The same code path an approved action replays through.
    return runItemAction(hub, item, action);
  }

  async function updateItem(id: string, patch: ItemPatch) {
    const item = await store.updateItem(id, patch);
    void hub.activity.log({
      actor: "user", kind: (patch.status && itemChangeKind[patch.status]) ?? "item.updated",
      summary: patch.status ? `Marked "${item.title}" ${patch.status}` : `Edited "${item.title}"`, refs: { itemId: id },
    });
    void emitItems();
    void emitStatus();
    // Findings read: the review's worktree can go (see jobs/review-cleanup.ts).
    if (patch.status === "resolved" || patch.status === "dismissed") void settleReviewWorktree(hub, item);
    return item;
  }

  return {
    ready,
    hub,
    status,
    listThreads: () => store.listThreads(),
    history: (threadId = MAIN_THREAD_ID) => store.readMessages(threadId),
    chat,
    cancel(threadId = MAIN_THREAD_ID) {
      chatTurns.get(threadId)?.abort();
    },
    listItems: () => store.listItems(),
    updateItem,
    performAction,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      deps.sessions.setPermissionAdvisor(null);
      unsubscribePresence();
      unsubscribeSettings();
      for (const controller of chatTurns.values()) controller.abort();
      await hub.jobs.dispose().catch((err: unknown) => console.error("Could not stop the job worker:", err));
    },
  };
}
