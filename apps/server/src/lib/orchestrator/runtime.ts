/**
 * The orchestrator runtime: one shared chat thread, periodic ticks that turn changes into items,
 * and the events the page follows. `createOrchestratorRuntime` works over whatever store, settings,
 * deps, clock, and model it is given (tests pass fakes); `createOrchestratorService` in
 * `src/orchestrator/service.ts` wires the live server into it at boot.
 */
import { randomUUID } from "node:crypto";
import { type LanguageModel, consumeStream, convertToModelMessages, pruneMessages } from "ai";
import { presence as livePresence } from "../presence.ts";
import { CALL_TIMEOUT_MS, createOrchestratorAgent } from "./agent.ts";
import type { OrchestratorDeps, OrchestratorSettingsStore } from "./deps.ts";
import { MEMORY_PROMPT_BYTES, buildDigest, collectSnapshot, truncateBytes } from "./digest.ts";
import { buildLanguageModel, providerOptionsFor } from "./model.ts";
import { httpError, removeProject, startSession } from "./ops.ts";
import { systemPrompt, tickPrompt } from "./prompt.ts";
import { type SchedulerTimers, createScheduler, realTimers } from "./scheduler.ts";
import { newId } from "./store.ts";
import { type ToolContext, createTools } from "./tools/index.ts";
import type {
  Item, OrchestratorEvent, OrchestratorMessage, OrchestratorRuntime, OrchestratorSettings, OrchestratorStatus, OrchestratorStore,
  TickReason, TickReport,
} from "./types.ts";

/** Messages of the thread a chat turn sends to the model. */
export const HISTORY_WINDOW = 40;
/** Messages the stored thread keeps; older ones are dropped. */
export const MAX_THREAD_MESSAGES = 200;
/** What a tool part's input and output become once the message left the history window. */
export const TRIMMED_TOOL_IO = "[trimmed from history]";
/** The scheduler's first tick after the process starts. */
export const FIRST_TICK_DELAY_MS = 60_000;
/** Retry delay after a scheduled tick found a chat turn (or another tick) running. */
export const BUSY_RETRY_MS = 60_000;

export type PresenceSource = { count(): number; subscribe(listener: (count: number) => void): () => void };

export type OrchestratorRuntimeOptions = {
  store: OrchestratorStore;
  settingsStore: OrchestratorSettingsStore;
  deps: OrchestratorDeps;
  timers?: SchedulerTimers;
  presence?: PresenceSource;
  /** Builds the model for a turn from the settings and the stored key; tests pass a mock. */
  model?: (settings: OrchestratorSettings, apiKey: string) => LanguageModel;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Which items changed between two listings, by what happened to them. */
function itemDelta(before: Map<string, Item>, after: Item[]) {
  const delta = { created: [] as string[], updated: [] as string[], resolved: [] as string[] };
  for (const item of after) {
    const was = before.get(item.id);
    if (!was) delta.created.push(item.id);
    else if (was.updatedAt !== item.updatedAt) (item.status === "resolved" && was.status !== "resolved" ? delta.resolved : delta.updated).push(item.id);
  }
  return delta;
}

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

/** The thread window a chat turn sends: the last `HISTORY_WINDOW` messages, starting at a user message. */
export function historyWindow(messages: OrchestratorMessage[]): OrchestratorMessage[] {
  const recent = messages.slice(-HISTORY_WINDOW);
  const firstUser = recent.findIndex((message) => message.role === "user");
  return firstUser > 0 ? recent.slice(firstUser) : recent;
}

export function createOrchestratorRuntime({
  store, settingsStore, deps, timers = realTimers, presence = livePresence, model: buildModel = buildLanguageModel,
}: OrchestratorRuntimeOptions): OrchestratorRuntime {
  const listeners = new Set<(event: OrchestratorEvent) => void>();
  const startedAt = timers.now();
  let busy: "chat" | "tick" | null = null;
  let current: AbortController | null = null;
  /** The newest report, from the store at start and then from this process. */
  let lastReport: TickReport | null = null;
  /** When the last tick of this process finished; the schedule counts from here. */
  let lastTickEnd: number | null = null;
  let lastBusyAt: number | null = null;
  let disposed = false;

  const ready = store.ready.then(async () => {
    lastReport = (await store.listTicks()).at(-1) ?? null;
  });

  function emit(event: OrchestratorEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        // A subscriber's bug must not fail the turn or starve the other subscribers.
        console.error("Orchestrator listener failed:", err);
      }
    }
  }
  const emitStatus = () => status().then((current) => emit({ type: "status", status: current })).catch(() => {});
  const emitItems = () => store.listItems().then((items) => emit({ type: "items", items })).catch(() => {});
  const emitWatches = () => store.listWatches().then((watches) => emit({ type: "watches", watches })).catch(() => {});

  async function settingsAndKey() {
    const settings = await settingsStore.orchestrator();
    return { settings, apiKey: await settingsStore.apiKey(settings.provider) };
  }

  /** The interval that applies now: attended Portals tick more often. */
  function intervalMs(settings: OrchestratorSettings): number {
    return (presence.count() > 0 ? settings.intervalMinutes : settings.idleIntervalMinutes) * 60_000;
  }

  async function nextTickAt(): Promise<number | null> {
    if (disposed) return null;
    const { settings, apiKey } = await settingsAndKey();
    if (!apiKey) return null;
    if (lastBusyAt !== null && lastBusyAt > (lastTickEnd ?? -Infinity)) return lastBusyAt + BUSY_RETRY_MS;
    return lastTickEnd === null ? startedAt + FIRST_TICK_DELAY_MS : lastTickEnd + intervalMs(settings);
  }

  const scheduler = createScheduler({ tick: () => runTick("schedule"), nextTickAt, timers });
  const unsubscribePresence = presence.subscribe(() => { void scheduler.reschedule(); void emitStatus(); });
  const unsubscribeSettings = settingsStore.subscribe(() => { void scheduler.reschedule(); void emitStatus(); });
  void ready.then(() => scheduler.reschedule());

  const login = () => deps.github.login().catch(() => null);

  /** The digest as get_tick_digest reports it: a look, not a tick, so snoozes are left alone. */
  async function digestNow() {
    const { settings } = await settingsAndKey();
    const previous = await store.readSnapshot();
    const now = timers.now();
    const snapshot = await collectSnapshot({ deps, previous, now, log: [] });
    return buildDigest({ store, snapshot, prevSnapshot: previous, intervalMs: intervalMs(settings), now, wakeSnoozed: false });
  }

  function toolContext(touched: Set<string>, interactive: boolean): ToolContext {
    return {
      store, settings: settingsStore, deps, touched, interactive, now: () => timers.now(),
      self: {
        digest: digestNow,
        schedule: async () => {
          const { settings, apiKey } = await settingsAndKey();
          return {
            ready: !!apiKey, intervalMinutes: settings.intervalMinutes, idleIntervalMinutes: settings.idleIntervalMinutes,
            presence: presence.count(), nextTickAt: scheduler.plannedAt(), lastTickAt: lastReport?.finishedAt ?? null,
          };
        },
        lastTick: async () => lastReport,
      },
    };
  }

  /** Keep the stored thread bounded; runs after every persisted turn. */
  async function trimStoredThread() {
    try {
      const { messages, changed } = trimThread(await store.readMessages());
      if (changed) await store.writeMessages(messages);
    } catch (err) {
      console.error("Could not trim the Portal thread:", err);
    }
  }

  function release(controller: AbortController) {
    if (current === controller) current = null;
    busy = null;
  }

  async function status(): Promise<OrchestratorStatus> {
    await ready;
    const { settings, apiKey } = await settingsAndKey();
    const items = await store.listItems();
    const open = (list: Item["list"]) => items.filter((item) => item.status === "open" && item.list === list).length;
    return {
      ready: !!apiKey, provider: settings.provider, model: settings.model, busy: busy !== null,
      intervalMinutes: settings.intervalMinutes, idleIntervalMinutes: settings.idleIntervalMinutes, presence: presence.count(),
      lastTick: lastReport, nextTickAt: scheduler.plannedAt(), openItems: { needs_you: open("needs_you"), ideas: open("ideas") },
    };
  }

  async function chat(userMessage: OrchestratorMessage): Promise<Response> {
    await ready;
    if (disposed) throw httpError("Portal is shutting down.", 409);
    const { settings, apiKey } = await settingsAndKey();
    if (!apiKey) throw httpError(`No ${settings.provider} API key is stored. Add one in Settings to talk to Portal.`, 409);
    if (busy) throw httpError(busy === "tick" ? "A tick is running; try again in a moment." : "Portal is still answering; wait for it or cancel it.", 409);
    busy = "chat";
    const controller = new AbortController();
    current = controller;
    void emitStatus();
    const touched = new Set<string>();
    const at = timers.now();
    try {
      // Ids are the thread's React keys and the SDK's merge handle, so a client id that is already taken gets replaced.
      const taken = new Set((await store.readMessages()).map((stored) => stored.id));
      const id = userMessage.id && !taken.has(userMessage.id) ? userMessage.id : randomUUID();
      const message: OrchestratorMessage = { ...userMessage, id, role: "user", metadata: { ...userMessage.metadata, at } };
      await store.appendMessages([message]);
      const recent = historyWindow(await store.readMessages());
      const tools = createTools(toolContext(touched, true));
      // Older turns keep their text but lose their tool traffic: the model answers from what it said, not from every listing it fetched.
      const modelMessages = pruneMessages({
        messages: await convertToModelMessages(recent, { tools, ignoreIncompleteToolCalls: true }),
        reasoning: "all",
        toolCalls: "before-last-message",
      });
      const [memory, githubLogin] = await Promise.all([store.readMemory(), login()]);
      const agent = createOrchestratorAgent({
        model: buildModel(settings, apiKey), tools,
        system: systemPrompt({ login: githubLogin, now: at, memory: truncateBytes(memory, MEMORY_PROMPT_BYTES) }),
        providerOptions: providerOptionsFor(settings.provider),
      });
      const result = await agent.stream({ messages: modelMessages, abortSignal: controller.signal, timeout: CALL_TIMEOUT_MS });
      let settled = false;
      return result.toUIMessageStreamResponse<OrchestratorMessage>({
        originalMessages: recent,
        generateMessageId: randomUUID,
        // The assistant message carries its own time, not the user message's. The `start` part is
        // emitted before the model answers, so the stored value is the one set when the turn finishes.
        messageMetadata: ({ part }) => {
          if (part.type === "start") return { at: timers.now() };
          if (part.type === "finish") return { at: timers.now(), itemIds: [...touched] };
          return undefined;
        },
        onFinish: async ({ responseMessage }) => {
          if (settled) return;
          settled = true;
          if (responseMessage.parts.length > 0) {
            await store.appendMessages([responseMessage]).catch((err: unknown) => console.error("Could not save the assistant message:", err));
          }
          await trimStoredThread();
          release(controller);
          emit({ type: "messages" });
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
      release(controller);
      void emitStatus();
      throw err;
    }
  }

  async function performTick(report: TickReport, signal: AbortSignal): Promise<void> {
    const { log } = report;
    const { settings, apiKey } = await settingsAndKey();
    if (!apiKey) {
      log.push(`No ${settings.provider} API key is stored; nothing was checked.`);
      report.error = "not ready";
      return;
    }
    const previous = await store.readSnapshot();
    const now = timers.now();
    const before = new Map((await store.listItems()).map((item) => [item.id, item]));
    const snapshot = await collectSnapshot({ deps, previous, now, log });
    const digest = await buildDigest({ store, snapshot, prevSnapshot: previous, intervalMs: intervalMs(settings), now });
    report.changes = digest.changes.length;
    for (const change of digest.changes) log.push(`${change.resolvesItemId ? "Cleared" : "Changed"}: ${change.summary} (${change.fingerprint})`);
    if (digest.dueWatches.length > 0) log.push(`Due watches: ${digest.dueWatches.map((watch) => watch.id).join(", ")}.`);

    if (digest.changes.length > 0 || digest.dueWatches.length > 0) {
      const touched = new Set<string>();
      const tools = createTools(toolContext(touched, false));
      const agent = createOrchestratorAgent({
        model: buildModel(settings, apiKey), tools,
        system: systemPrompt({ login: await login(), now, memory: digest.memory }),
        providerOptions: providerOptionsFor(settings.provider),
      });
      report.modelInvoked = true;
      const result = await agent.generate({ prompt: tickPrompt(digest), abortSignal: signal, timeout: CALL_TIMEOUT_MS });
      report.usage = { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
      const text = result.text.trim();
      if (text && text !== "NO_UPDATE") {
        await store.appendMessages([{
          id: randomUUID(), role: "assistant", parts: [{ type: "text", text }],
          metadata: { at: timers.now(), tick: { id: report.id, reason: report.reason }, itemIds: [...touched] },
        }]);
        await trimStoredThread();
        log.push("Posted a note to the thread.");
        emit({ type: "messages" });
      } else {
        log.push("No note for the user (NO_UPDATE).");
      }
      for (const watch of digest.dueWatches) await store.updateWatch(watch.id, { lastCheckedAt: now }).catch(() => {});
      if (digest.dueWatches.length > 0) void emitWatches();
    } else {
      log.push("Nothing changed; the model was not invoked.");
    }
    await store.writeSnapshot(snapshot);

    // What happened to items, read back from the store (snoozes waking up count too).
    const delta = itemDelta(before, await store.listItems());
    report.itemsCreated = delta.created;
    report.itemsUpdated = delta.updated;
    report.itemsResolved = delta.resolved;
    if (report.modelInvoked) log.push(`Items: ${delta.created.length} created, ${delta.updated.length} updated, ${delta.resolved.length} resolved.`);
    if (delta.created.length + delta.updated.length + delta.resolved.length > 0) void emitItems();
  }

  async function runTick(reason: TickReason): Promise<TickReport> {
    await ready;
    const report: TickReport = {
      id: newId(), reason, startedAt: timers.now(), finishedAt: timers.now(), modelInvoked: false, changes: 0,
      itemsCreated: [], itemsUpdated: [], itemsResolved: [], log: [], error: null, usage: null,
    };
    if (busy || disposed) {
      lastBusyAt = report.startedAt;
      report.error = "busy";
      report.log.push(disposed ? "Portal is shutting down." : `Skipped: a ${busy} is already running; retrying in a minute.`);
      void scheduler.reschedule();
      return report;
    }
    busy = "tick";
    const controller = new AbortController();
    current = controller;
    void emitStatus();
    try {
      await performTick(report, controller.signal);
    } catch (err) {
      report.error = errorMessage(err);
      report.log.push(`Failed: ${report.error}`);
    }
    report.finishedAt = timers.now();
    lastReport = report;
    lastTickEnd = report.finishedAt;
    await store.appendTick(report).catch((err: unknown) => console.error("Could not save the tick report:", err));
    release(controller);
    // Whatever started this tick, the next one counts from its end; the status pushed below carries that time.
    await scheduler.reschedule();
    emit({ type: "tick", report });
    void emitStatus();
    return report;
  }

  async function performAction(itemId: string, actionIndex: number): Promise<{ sessionId?: string; promptError?: string }> {
    await ready;
    const item = await store.getItem(itemId);
    if (!item) throw httpError(`Unknown item "${itemId}".`, 404);
    const action = item.actions[actionIndex];
    if (!action) throw httpError("The item has no such action.", 404);
    switch (action.type) {
      case "start_session":
        // The session exists even when its prompt failed; the caller gets both facts.
        return startSession(deps, { projectId: action.projectId, agentId: action.agentId, prompt: action.prompt });
      case "send_prompt":
        await deps.sessions.prompt(action.sessionId, action.prompt);
        return {};
      case "remove_worktree":
        await removeProject(deps, { id: action.projectId, deleteWorktree: true });
        return {};
      default:
        throw httpError(`The ${action.type} action runs in the browser.`, 400);
    }
  }

  return {
    ready,
    status,
    history: () => store.readMessages(),
    chat,
    cancel() {
      current?.abort();
    },
    runTick,
    listItems: () => store.listItems(),
    async updateItem(id, patch) {
      const item = await store.updateItem(id, patch);
      void emitItems();
      void emitStatus();
      return item;
    },
    listWatches: () => store.listWatches(),
    async updateWatch(id, patch) {
      const watch = await store.updateWatch(id, patch);
      void emitWatches();
      return watch;
    },
    listTicks: () => store.listTicks(),
    readMemory: () => store.readMemory(),
    writeMemory: (text) => store.writeMemory(text),
    performAction,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      scheduler.stop();
      unsubscribePresence();
      unsubscribeSettings();
      current?.abort();
    },
  };
}
