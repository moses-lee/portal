import type { Page } from "@playwright/test";
import { applySettingsPatch, defaultSettings } from "../../src/lib/settings";
import type {
  GithubSummary,
  ProjectSummary,
  RemovedProjectSummary,
  SessionSummary,
  StoredEvent,
  SessionMetaEvent,
  PortalEvent,
} from "../../src/lib/types";
import type {
  ActivityEntry,
  Approval,
  ApprovalGrant,
  ApprovalScope,
  CoreDocument,
  Intent,
  Item,
  Job,
  JobRun,
  MemoryEntity,
  MemoryRecord,
  MemoryRevision,
  OrchestratorEvent,
  OrchestratorMessage,
  OrchestratorStatus,
  Thread,
  TickReport,
  WorldResponse,
} from "../../src/lib/orchestrator/types";
import { coreDocument, mainThread, worldResponse } from "./orchestrator-fixtures";

const now = Date.now();
export const project: ProjectSummary = {
  id: "p1",
  name: "portal",
  path: "/workspace/portal",
  displayPath: "~/repos/portal",
  createdAt: now,
  exists: true,
  git: {
    root: "/workspace/portal",
    displayRoot: "~/repos/portal",
    branch: "main",
    detached: false,
  },
};
export const worktree: ProjectSummary = {
  ...project,
  id: "p2",
  name: "improve-chat-experience",
  path: "/workspace/portal-worktree",
  displayPath: "~/.portal/worktrees/portal/improve-chat-experience",
  worktree: { parentId: "p1", branch: "feature/improve-chat-experience" },
  git: { ...project.git!, branch: "feature/improve-chat-experience" },
};
/** A removed worktree project whose folder is gone but whose branch and parent survive. */
export const removedProject: RemovedProjectSummary = {
  id: "p9",
  name: "feat/old-branch",
  path: "/workspace/portal-old",
  displayPath: "~/.portal/worktrees/portal/feat-old-branch",
  worktree: { parentId: "p1", branch: "feat/old-branch" },
  removedAt: now - 7200000,
  exists: false,
  parentName: "portal",
  sessionCount: 2,
  lastActiveAt: now - 86400000,
  restorable: true,
  reason: null,
};
export const firstTitle =
  "Improve the chat experience and simplify the agent settings";
export const secondTitle =
  "Investigate long session titles overlapping the pin icon";
const state: SessionSummary["state"] = {
  modes: null,
  commands: [
    { name: "review", description: "Review the current changes" },
    { name: "help", description: "Show available commands" },
  ],
  configOptions: [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "sonnet",
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
    {
      id: "mode",
      category: "mode",
      name: "Mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "plan", name: "Plan" },
      ],
    },
    {
      id: "effort",
      category: "thought_level",
      name: "Reasoning effort",
      description: "How much time the agent spends reasoning.",
      type: "select",
      currentValue: "high",
      options: [
        {
          group: "levels",
          name: "Effort",
          options: [
            { value: "high", name: "High" },
            { value: "low", name: "Low" },
          ],
        },
      ],
    },
    { id: "fast", name: "Fast mode", type: "boolean", currentValue: false },
  ],
};
export function makeSession(
  id: string,
  title: string,
  agentId = "claude",
  p = worktree,
): SessionSummary {
  return {
    id,
    title,
    agentId,
    agentName: agentId === "claude" ? "Claude Code" : "Codex",
    projectId: p.id,
    project: { id: p.id, name: p.name },
    createdAt: now,
    lastActiveAt: now - 3600000,
    cwd: p.path,
    displayCwd: p.displayPath,
    cwdMissing: false,
    git: p.git,
    state: structuredClone(state),
    busy: false,
    awaitingPermission: false,
    link: { status: "live" },
  };
}
export const sessions = [
  makeSession("s1", firstTitle),
  makeSession("s2", secondTitle, "codex"),
  makeSession("s3", "Review the pull request and its checks", "codex", project),
];
/**
 * Eight conversations in `project`, most recently active first, and one in the worktree: enough to
 * push a project past the sidebar's five-row cap.
 */
export function manySessions(): SessionSummary[] {
  const base = Date.now();
  return [
    ...Array.from({ length: 8 }, (_, i) =>
      makeSession(`m${i + 1}`, `Conversation ${i + 1}`, "claude", project),
    ).map((entry, i) => ({ ...entry, lastActiveAt: base - i * 60_000 })),
    {
      ...makeSession("w1", "Worktree work", "codex", worktree),
      lastActiveAt: base - 10 * 60_000,
    },
  ];
}

const raw: PortalEvent[] = [
  {
    type: "user",
    text: "Let's simplify this workspace. Give the conversation more room and make the important things easier to find.",
  },
  { type: "turn_start" },
  {
    type: "update",
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "I'll start with the hierarchy, then inspect the composer and session navigation.",
      },
    },
  },
  {
    type: "update",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool1",
      title: "Read the chat layout and composer components",
      kind: "read",
      status: "completed",
      content: [],
      rawInput: { path: "src/components/SessionPane.tsx" },
      rawOutput: "Read 320 lines.",
    },
  },
  {
    type: "update",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool2",
      title: "Adjust the conversation layout",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "src/components/Chat.tsx",
          oldText: 'const width = "100%";\n',
          newText: 'const width = "840px";\n',
        },
      ],
    },
  },
  {
    type: "update",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "The conversation now has a little more room to breathe. I found three places where we can make the biggest difference.\n\n### A calmer place to work\n\n1. **Keep the conversation in focus.** Give messages a comfortable reading width and let secondary details step back.\n2. **Bring the controls together.** One composer, with agent settings a click away.\n3. **Make every session easy to find.** Clear titles, recognizable agents, and less repeated information.\n\n```tsx\n<Conversation\n  session={activeSession}\n  maxWidth={840}\n/>\n```\n\nThe branch and working directory stay right where you need them, below the message box.",
      },
    },
  },
  { type: "turn_end", stopReason: "end_turn" },
];
export const events: StoredEvent[] = raw.map((event, seq) => ({
  ...event,
  seq,
  ts: now,
}));

/** What the source control panel shows by default: an approved PR with no checks that merges cleanly. */
export const githubSummary: GithubSummary = {
  branch: worktree.git!.branch,
  detached: false,
  defaultBranch: "main",
  upstream: "origin/feature/improve-chat-experience",
  ahead: 2,
  behind: 0,
  fetchedAt: now,
  fetchError: null,
  repoUrl: "https://github.com/example/portal",
  logBase: "origin/main",
  diff: { source: "pull", baseBranch: "main", additions: 123, deletions: 45, files: 8 },
  commits: [
    {
      sha: "abc123",
      short: "abc123",
      subject: "Make conversations easier to read",
      author: "Developer",
      committedAt: now,
      head: true,
      remoteHead: false,
      base: false,
    },
  ],
  cursor: null,
  pull: {
    number: 42,
    title: "Improve the chat experience and simplify workspace navigation",
    author: "developer",
    url: "https://github.com/example/portal/pull/42",
    state: "open",
    draft: false,
    baseBranch: "main",
    headSha: "abc123",
    reviewDecision: "approved",
    unresolvedThreads: 0,
    comments: 2,
    checks: null,
    mergeable: "mergeable",
  },
  pullError: null,
  conflicts: { status: "clean", base: "main", source: "local" },
  at: now,
};

/** The same PR in trouble: a failing check, conflicts with main, and open review threads; every git action applies. */
export const failingGithubSummary: GithubSummary = {
  ...githubSummary,
  pull: {
    ...githubSummary.pull!,
    unresolvedThreads: 2,
    comments: 3,
    checks: {
      state: "failing",
      passing: 1,
      failing: 1,
      pending: 0,
      checks: [
        {
          name: "Lint",
          state: "passing",
          url: "https://github.com/example/portal/actions/runs/1",
        },
        {
          name: "Unit tests",
          state: "failing",
          url: "https://github.com/example/portal/actions/runs/2",
        },
      ],
    },
    mergeable: "conflicting",
  },
  conflicts: {
    status: "conflicts",
    base: "main",
    files: ["src/a.ts"],
    source: "local",
  },
};

/** Talk to Portal's defaults: ready, idle, one check due in seven minutes (`setupPortal` re-times it per test). */
export const portalStatus: OrchestratorStatus = {
  ready: true,
  provider: "openai",
  model: "gpt-5-mini",
  busy: false,
  intervalMinutes: 10,
  idleIntervalMinutes: 60,
  presence: 1,
  lastTick: null,
  nextTickAt: now + 7 * 60_000,
  openItems: { needs_you: 1, ideas: 0 },
  busyThreads: [],
  runs: [],
  nextJob: { id: "tick", title: "Check for changes", at: now + 7 * 60_000 },
  counts: { needsYou: 1, inbox: 0, approvals: 0, intents: 0 },
  line: "Idle · next: Check for changes",
};

/** A failing-checks item on PR #42 with one action of each browser-side kind. */
export const portalItem: Item = {
  id: "i1",
  list: "needs_you",
  kind: "pr_checks_failing",
  title: "Checks are failing on example/portal#42",
  body: "**Unit tests** failed on the latest push. The other check passed.",
  links: { projectId: "p2", sessionId: "s1", pull: { repo: "example/portal", number: 42, url: "https://github.com/example/portal/pull/42" } },
  actions: [
    { type: "open_session", sessionId: "s1" },
    { type: "open_url", url: "https://github.com/example/portal/pull/42" },
    { type: "ask_portal", text: "Set up a fix for example/portal#42" },
  ],
  fingerprint: "pr_checks_failing:example/portal#42",
  status: "open",
  createdAt: now - 600_000,
  updatedAt: now - 600_000,
  snoozedUntil: null,
};

/** One user question, then a scheduled tick's answer that ran a tool and produced `portalItem`. */
export const portalMessages: OrchestratorMessage[] = [
  {
    id: "m1",
    role: "user",
    metadata: { at: now - 3_600_000 },
    parts: [{ type: "text", text: "What needs me today?" }],
  },
  {
    id: "m2",
    role: "assistant",
    metadata: { at: now - 3_500_000 },
    parts: [{ type: "text", text: "Nothing yet. I will keep an eye on your pull requests." }],
  },
  {
    id: "m3",
    role: "assistant",
    metadata: { at: now - 600_000, tick: { id: "t1", reason: "schedule" }, itemIds: ["i1"] },
    parts: [
      { type: "step-start" },
      {
        type: "tool-get_tick_digest",
        toolCallId: "call1",
        state: "output-available",
        input: {},
        output: { changes: 1 },
      },
      { type: "text", text: "The **unit tests** on PR #42 started failing after your last push." },
    ],
  },
];

export const portalTickReport: TickReport = {
  id: "t2",
  reason: "manual",
  startedAt: now,
  finishedAt: now + 1500,
  modelInvoked: true,
  changes: 2,
  itemsCreated: ["i2"],
  itemsUpdated: [],
  itemsResolved: [],
  log: ["Considered PR #42: still failing."],
  error: null,
  usage: { inputTokens: 1200, outputTokens: 80 },
};

declare global {
  interface Window {
    __portalEmit: (
      match: string,
      data: unknown,
      type?: string,
      seq?: number,
    ) => void;
    __portalSessions: SessionSummary[];
    __portalLive: {
      status: OrchestratorStatus;
      items: Item[];
      threads: Thread[];
      intents: Intent[];
      approvals: Approval[];
    };
  }
}

export async function emit(
  page: Page,
  data: Partial<SessionMetaEvent> | PortalEvent,
  type = "meta",
  seq = 100,
) {
  await page.evaluate(
    ({ data, type, seq }) =>
      window.__portalEmit("/api/sessions/s1/stream", data, type, seq),
    { data, type, seq },
  );
}

/** Pushes one orchestrator event through the page's open `/api/portal/stream`. */
export const emitPortal = (page: Page, event: OrchestratorEvent) =>
  page.evaluate((event) => window.__portalEmit("/api/portal/stream", event, "message"), event);

export async function setupPortal(
  page: Page,
  options: {
    history?: StoredEvent[];
    hasMore?: boolean;
    olderDelay?: number;
    /** What `GET /api/projects/<id>/github` answers; defaults to `githubSummary`. */
    github?: GithubSummary;
    /**
     * Let `/api/settings` reach the test server (isolated by its per-run `portal_e2e` database) instead
     * of answering with the defaults, for tests of persistence itself.
     */
    realSettings?: boolean;
    /** Rows of `GET /api/projects/removed`; restoring one lists it as a project with one session. */
    removed?: RemovedProjectSummary[];
    /** Replaces the default three conversations, for tests of sidebar grouping, ordering, and capping. */
    sessions?: SessionSummary[];
    /** Replaces the default two projects. */
    projects?: ProjectSummary[];
    /**
     * Talk to Portal's state: what `/api/portal`, its messages, items, and stream answer with, and
     * what the phase 2 routes (threads, jobs, runs, intents, activity, memory, world, approvals)
     * answer, per the contracts. Everything defaults to empty but the main thread.
     */
    portal?: {
      status?: Partial<OrchestratorStatus>;
      messages?: OrchestratorMessage[];
      items?: Item[];
      threads?: Thread[];
      /** Side threads' messages by thread id. */
      threadMessages?: Record<string, OrchestratorMessage[]>;
      intents?: Intent[];
      approvals?: Approval[];
      jobs?: Job[];
      runs?: JobRun[];
      activity?: ActivityEntry[];
      entities?: MemoryEntity[];
      records?: MemoryRecord[];
      revisions?: MemoryRevision[];
      core?: CoreDocument;
      world?: WorldResponse;
      grants?: ApprovalGrant[];
      /** What `POST /api/portal/items/:id/actions/:index` answers for server-side actions. */
      actionResult?: { sessionId?: string; approvalId?: string };
    };
  } = {},
) {
  const currentSessions = structuredClone(options.sessions ?? sessions);
  const currentProjects: ProjectSummary[] = structuredClone(
    options.projects ?? [project, worktree],
  );
  const currentRemoved = structuredClone(options.removed ?? []);
  const live = {
    // Timed from now, not from module load, so "next check in 7 min" holds however long the run has been going.
    status: { ...portalStatus, nextTickAt: Date.now() + 7 * 60_000, ...options.portal?.status },
    items: structuredClone(options.portal?.items ?? [portalItem]),
    threads: structuredClone(options.portal?.threads ?? [mainThread]),
    intents: structuredClone(options.portal?.intents ?? []),
    approvals: structuredClone(options.portal?.approvals ?? []),
  };
  const orch = {
    threadMessages: structuredClone(options.portal?.threadMessages ?? {}),
    jobs: structuredClone(options.portal?.jobs ?? []),
    runs: structuredClone(options.portal?.runs ?? []),
    activity: structuredClone(options.portal?.activity ?? []),
    entities: structuredClone(options.portal?.entities ?? []),
    records: structuredClone(options.portal?.records ?? []),
    revisions: structuredClone(options.portal?.revisions ?? []),
    core: structuredClone(options.portal?.core ?? coreDocument),
    world: structuredClone(options.portal?.world ?? worldResponse),
    grants: structuredClone(options.portal?.grants ?? []),
  };
  const portalThread = structuredClone(options.portal?.messages ?? portalMessages);
  const history = options.history ?? events;
  const requests: { path: string; method: string; body: unknown }[] = [];
  let failSend = false;
  let sendDelay = 0;
  /** When set, `POST /api/portal/messages` answers 409 `{ error }` the way the runtime does while a check is running. */
  let failPortalSend: string | null = null;
  /** Sends to these threads wait until the test releases them: a turn that stays "running". */
  const sendHolds = new Map<string, Promise<void>>();
  await page.addInitScript(
    ({ sessions, live }) => {
      window.__portalSessions = sessions;
      window.__portalLive = live;
      const sources = new Set<PreviewEventSource>();
      class PreviewEventSource extends EventTarget {
        url: string;
        closed = false;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string) {
          super();
          this.url = url;
          sources.add(this);
          setTimeout(() => {
            if (this.closed) return;
            if (url === "/api/sessions/stream")
              this.send(
                { type: "snapshot", sessions: window.__portalSessions },
                "message",
              );
            else if (url === "/api/portal/stream") {
              this.send({ type: "status", status: window.__portalLive.status }, "message");
              this.send({ type: "items", items: window.__portalLive.items }, "message");
              this.send({ type: "threads", threads: window.__portalLive.threads }, "message");
              this.send({ type: "approvals", approvals: window.__portalLive.approvals }, "message");
              this.send({ type: "intents", intents: window.__portalLive.intents }, "message");
            } else
              this.send(
                window.__portalSessions.find((session) =>
                  url.includes(`/sessions/${session.id}/`),
                ),
                "meta",
              );
          }, 0);
        }
        close() {
          this.closed = true;
          sources.delete(this);
        }
        send(data: unknown, type: string, seq = 0) {
          const event = new MessageEvent(type, {
            data: JSON.stringify(data),
            lastEventId: String(seq),
          });
          if (type === "message") this.onmessage?.(event);
          this.dispatchEvent(event);
        }
      }
      Object.defineProperty(window, "EventSource", {
        value: PreviewEventSource,
      });
      window.__portalEmit = (match, data, type = "meta", seq = 0) => {
        for (const source of sources)
          if (source.url.includes(match)) source.send(data, type, seq);
      };
    },
    { sessions: currentSessions, live },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON();
    requests.push({ path, method, body });
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/settings") {
      if (options.realSettings) return route.fallback();
      // Parallel tests share the server's settings; the defaults keep them independent of each other.
      return json({
        settings:
          method === "PATCH"
            ? applySettingsPatch(defaultSettings, body)
            : defaultSettings,
      });
    }
    if (path === "/api/portal") return json({ status: live.status });
    if (path === "/api/portal/messages" && method === "GET")
      return json({ messages: portalThread });
    const threadRoute = path.match(/^\/api\/portal\/threads\/([^/]+)\/(messages|cancel)$/);
    if (threadRoute?.[2] === "cancel" && method === "POST") return route.fulfill({ status: 204 });
    if (threadRoute && method === "GET") {
      const id = decodeURIComponent(threadRoute[1]);
      if (id === "main") return json({ messages: portalThread });
      if (!live.threads.some((thread) => thread.id === id)) return json({ error: `Unknown thread "${id}".` }, 404);
      return json({ messages: orch.threadMessages[id] ?? [] });
    }
    if ((path === "/api/portal/messages" || threadRoute) && method === "POST") {
      if (failPortalSend) return json({ error: failPortalSend }, 409);
      const id = threadRoute ? decodeURIComponent(threadRoute[1]) : "main";
      const thread = id === "main" ? portalThread : (orch.threadMessages[id] ??= []);
      const hold = sendHolds.get(id);
      if (hold) await hold;
      // Like the runtime: keep the user message and the reply, and answer with the AI SDK UI message stream.
      const reply = `Portal reply to: ${body?.message?.parts?.[0]?.text ?? ""}`;
      thread.push(body.message, {
        id: `reply-${id}-${thread.length}`,
        role: "assistant",
        metadata: { at: now },
        parts: [{ type: "text", text: reply }],
      });
      const chunks = [
        { type: "start", messageId: `reply-${id}-${thread.length - 1}` },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: reply },
        { type: "text-end", id: "t" },
        { type: "finish" },
      ];
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-vercel-ai-ui-message-stream": "v1",
        },
        body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
      });
    }
    if (path === "/api/portal/cancel") return route.fulfill({ status: 204 });
    if (path === "/api/portal/tick") return json({ report: portalTickReport });
    if (path === "/api/portal/items") return json({ items: live.items });
    const orchestratorReply = handleOrchestrator(path, method, url.searchParams, body, live, orch);
    if (orchestratorReply)
      return orchestratorReply.status === 204
        ? route.fulfill({ status: 204 })
        : json(orchestratorReply.body, orchestratorReply.status);
    const itemMatch = path.match(/^\/api\/portal\/items\/([^/]+)(?:\/actions\/(\d+))?$/);
    if (itemMatch) {
      const item = live.items.find((row) => row.id === itemMatch[1]);
      if (!item) return json({ error: "Unknown item." }, 404);
      if (itemMatch[2] !== undefined) return json(options.portal?.actionResult ?? { sessionId: "s1" });
      Object.assign(item, body, { updatedAt: now });
      return json({ item });
    }
    if (path === "/api/agents")
      return json({
        agents: [
          { id: "claude", name: "Claude Code" },
          { id: "codex", name: "Codex" },
        ],
        defaultAgentId: "claude",
      });
    if (path === "/api/projects")
      return json({ projects: currentProjects });
    if (path === "/api/projects/removed")
      return json({ removed: currentRemoved });
    const removedMatch = path.match(/^\/api\/projects\/removed\/([^/]+)(\/restore)?$/);
    if (removedMatch) {
      const index = currentRemoved.findIndex((row) => row.id === removedMatch[1]);
      if (index === -1) return json({ error: "Unknown removed project." }, 404);
      const [row] = currentRemoved.splice(index, 1);
      if (removedMatch[2] && method === "POST") {
        const restored: ProjectSummary = {
          id: row.id,
          name: row.name,
          path: row.path,
          displayPath: row.displayPath,
          createdAt: now,
          exists: true,
          worktree: row.worktree,
          git: {
            ...(currentProjects[0]?.git ?? project.git!),
            branch: row.worktree?.branch ?? "main",
          },
        };
        currentProjects.push(restored);
        currentSessions.push({
          ...makeSession("s9", "Finish the old branch", "codex", restored),
          lastActiveAt: row.lastActiveAt ?? now,
        });
        return json({ project: restored });
      }
      if (method === "DELETE") return route.fulfill({ status: 204 });
      return json({ error: `Unexpected test request: ${method} ${path}` }, 400);
    }
    if (path === "/api/sessions" && method === "GET")
      return json({ sessions: currentSessions });
    if (path === "/api/sessions" && method === "POST") {
      const session = {
        ...makeSession(
          "created",
          "",
          body.agentId,
          currentProjects.find((p) => p.id === body.projectId) ??
            currentProjects[0] ??
            project,
        ),
        // A new session is the most recently active one.
        lastActiveAt: now,
      };
      currentSessions.push(session);
      await page.evaluate(
        (session) => window.__portalSessions.push(session),
        session,
      );
      return json(session, 201);
    }
    if (path.endsWith("/events")) {
      if (url.searchParams.has("before")) {
        if (options.olderDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, options.olderDelay),
          );
        const earlier = Array.from({ length: 4 }, (_, i) => [
          {
            type: "user" as const,
            text: `Earlier question ${i}`,
            seq: i * 3,
            ts: now,
          },
          {
            type: "update" as const,
            update: {
              sessionUpdate: "agent_message_chunk" as const,
              content: {
                type: "text" as const,
                text: "An earlier response with useful context. ".repeat(20),
              },
            },
            seq: i * 3 + 1,
            ts: now,
          },
          {
            type: "turn_end" as const,
            stopReason: "end_turn" as const,
            seq: i * 3 + 2,
            ts: now,
          },
        ]).flat();
        return json({
          events: earlier,
          hasMore: false,
          nextSeq: earlier.length,
        });
      }
      return json({
        events: history,
        hasMore: !!options.hasMore,
        nextSeq: (history.at(-1)?.seq ?? -1) + 1,
      });
    }
    if (path.endsWith("/prompt")) {
      if (sendDelay)
        await new Promise((resolve) => setTimeout(resolve, sendDelay));
      return json(
        failSend
          ? { error: "Unable to reach the agent. Your draft is saved." }
          : { ok: true },
        failSend ? 503 : 202,
      );
    }
    if (path.endsWith("/config")) {
      const session = currentSessions.find((session) =>
        path.includes(`/sessions/${session.id}/`),
      )!;
      session.state.configOptions = session.state.configOptions.map((option) =>
        option.id === body.configId
          ? { ...option, currentValue: body.value }
          : option,
      );
      // The stream's meta reports the browser-side copy; keep it current like the real server would.
      await page.evaluate(
        ({ id, state }) => {
          const mirrored = window.__portalSessions.find((s) => s.id === id);
          if (mirrored) mirrored.state = state;
        },
        { id: session.id, state: session.state },
      );
      return json({ state: session.state });
    }
    if (path.endsWith("/permission") || path.endsWith("/cancel"))
      return json({ ok: true });
    if (path.endsWith("/branches"))
      return json({
        defaultBranch: "main",
        branches: [
          {
            name: "feature/search",
            local: true,
            remote: true,
            committedAt: now,
            worktreePath: null,
          },
        ],
        pulls: [],
        pullsError: null,
        repoWorktreesDir: "~/.portal/worktrees/portal",
      });
    if (path.endsWith("/github"))
      return json({ summary: options.github ?? githubSummary });
    if (path === "/api/terminals" && method === "POST")
      return json(
        {
          id: "standalone-1",
          sessionId: null,
          createdAt: now,
          state: {
            id: null,
            status: "idle",
            cwd: "/Users/tester",
            displayCwd: "~",
            git: null,
            shell: "zsh",
            cols: 80,
            rows: 24,
            exitCode: null,
            cwdError: null,
          },
        },
        201,
      );
    if (path.endsWith("/terminals")) return json({ terminals: [] });
    if (path.startsWith("/api/sessions/") && method === "GET")
      return json(
        currentSessions.find((session) => path.endsWith(session.id)) ?? {},
      );
    return json({ error: `Unexpected test request: ${method} ${path}` }, 400);
  });
  return {
    requests,
    failSend: (value = true) => {
      failSend = value;
    },
    delaySend: (delay: number) => {
      sendDelay = delay;
    },
    failPortalSend: (error: string | null = "Portal is running a check. Try again in a moment.") => {
      failPortalSend = error;
    },
    /** Adds to the thread `GET /api/portal/messages` answers with, the way a tick does; pair with a `messages` stream event. */
    appendPortalMessage: (message: OrchestratorMessage, threadId = "main") => {
      if (threadId === "main") portalThread.push(structuredClone(message));
      else (orch.threadMessages[threadId] ??= []).push(structuredClone(message));
    },
    /** Holds chat sends to `threadId` until the returned function is called. */
    holdSends: (threadId = "main") => {
      let release = () => {};
      sendHolds.set(
        threadId,
        new Promise<void>((resolve) => {
          release = () => {
            sendHolds.delete(threadId);
            resolve();
          };
        }),
      );
      return release;
    },
    /** The mocked server's orchestrator data, for asserting what a request changed. */
    orchestrator: orch,
    /** What the stream opened with (status, items, threads, intents, approvals); the mocked routes read it too. */
    portalLive: live,
  };
}

type OrchestratorData = {
  threadMessages: Record<string, OrchestratorMessage[]>;
  jobs: Job[];
  runs: JobRun[];
  activity: ActivityEntry[];
  entities: MemoryEntity[];
  records: MemoryRecord[];
  revisions: MemoryRevision[];
  core: CoreDocument;
  world: WorldResponse;
  grants: ApprovalGrant[];
};

/**
 * The phase 2 routes as the contracts describe them (jobs, runs, intents, activity, memory,
 * world, approvals), answered from `data`; null for any other path. Writes change `data` the way
 * the server would, so a refetch shows the result.
 */
function handleOrchestrator(
  path: string,
  method: string,
  params: URLSearchParams,
  body: Record<string, unknown> | null,
  live: { threads: Thread[]; intents: Intent[]; approvals: Approval[] },
  data: OrchestratorData,
): { body: unknown; status?: number } | null {
  const ok = (value: unknown) => ({ body: value });
  const missing = (what: string) => ({ body: { error: `Unknown ${what}.` }, status: 404 });
  const limit = Number(params.get("limit") ?? 50);
  const before = params.get("before");
  if (path === "/api/portal/threads" && method === "GET") return ok({ threads: live.threads });
  if (path === "/api/portal/activity" && method === "GET") {
    const kind = params.get("kind");
    const entries = data.activity
      .filter((entry) => (!kind || entry.kind.startsWith(kind)) && (!before || entry.id < Number(before)))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return ok({ entries });
  }
  if (path === "/api/portal/jobs" && method === "GET") {
    const status = params.get("status");
    return ok({ jobs: data.jobs.filter((job) => (status ? job.status === status : job.status === "active")) });
  }
  const job = path.match(/^\/api\/portal\/jobs\/([^/]+)(\/run)?$/);
  if (job) {
    const row = data.jobs.find((entry) => entry.id === job[1]);
    if (!row) return missing("job");
    if (job[2] && method === "POST") {
      const run: JobRun = {
        id: `run-${row.id}-now`, jobId: row.id, kind: row.kind, threadId: row.threadId, parentRunId: null, status: "running",
        trigger: "manual", startedAt: Date.now(), finishedAt: null, model: null, usage: null, log: [], result: null, summary: null, error: null,
      };
      data.runs.unshift(run);
      return ok({ run });
    }
    if (method === "PATCH") {
      Object.assign(row, body, { updatedAt: Date.now() });
      if (row.status !== "active") row.nextRunAt = null;
      return ok({ job: row });
    }
  }
  if (path === "/api/portal/runs" && method === "GET") {
    const index = before ? data.runs.findIndex((run) => run.id === before) + 1 : 0;
    return ok({ runs: data.runs.slice(index, index + limit) });
  }
  const runCancel = path.match(/^\/api\/portal\/runs\/([^/]+)\/cancel$/);
  if (runCancel && method === "POST") return { body: null, status: 204 };
  if (path === "/api/portal/intents" && method === "GET") return ok({ intents: live.intents });
  const intentPatch = path.match(/^\/api\/portal\/intents\/([^/]+)$/);
  if (intentPatch && method === "PATCH") {
    const row = live.intents.find((entry) => entry.id === intentPatch[1]);
    if (!row) return missing("intent");
    return ok({ intent: { ...row, ...body, updatedAt: Date.now() } });
  }
  if (path === "/api/portal/world" && method === "GET") return ok(data.world);
  if (path === "/api/portal/world/refresh" && method === "POST") {
    data.world = { ...data.world, world: { ...data.world.world, at: Date.now() }, tokens: data.world.tokens + 10 };
    return ok(data.world);
  }
  if (path === "/api/portal/memory/core" && method === "GET") return ok(data.core);
  if (path === "/api/portal/memory/entities" && method === "GET") return ok({ entities: data.entities });
  const entity = path.match(/^\/api\/portal\/memory\/entities\/([^/]+)$/);
  if (entity && method === "GET") {
    const row = data.entities.find((entry) => entry.id === decodeURIComponent(entity[1]));
    if (!row) return missing("entity");
    return ok({ entity: row, records: data.records.filter((record) => record.entityId === row.id) });
  }
  if (path === "/api/portal/memory/records" && method === "GET") {
    const status = params.get("status");
    const entityId = params.get("entityId");
    return ok({
      records: data.records.filter((record) => (!status || record.status === status) && (!entityId || record.entityId === entityId)),
    });
  }
  if (path === "/api/portal/memory/records" && method === "POST") {
    const input = body as unknown as { entity: { type: MemoryEntity["type"]; key: string }; type: MemoryRecord["type"]; key: string; body: string; pinned?: boolean };
    let owner = data.entities.find((entry) => entry.type === input.entity.type && entry.key === input.entity.key);
    if (!owner) {
      owner = { id: `e-${input.entity.key}`, type: input.entity.type, key: input.entity.key, name: input.entity.key, summary: "", activeRecords: 0, createdAt: Date.now(), updatedAt: Date.now() };
      data.entities.push(owner);
    }
    const record: MemoryRecord = {
      id: `r-new-${data.records.length}`, entityId: owner.id, type: input.type, key: input.key, body: input.body, status: "active",
      scope: { projectIds: [], sessionIds: [], pulls: [], repos: [], people: [], taskTypes: [] }, authority: "user_stated",
      source: { kind: "ui" }, trust: 1, pinned: !!input.pinned, reviewBy: null, supersedes: null, supersededBy: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    data.records.push(record);
    owner.activeRecords++;
    return ok({ record });
  }
  const recordAction = path.match(/^\/api\/portal\/memory\/records\/([^/]+)(?:\/(approve|reject|forget))?$/);
  if (recordAction) {
    const row = data.records.find((entry) => entry.id === recordAction[1]);
    if (!row) return missing("record");
    const action = recordAction[2];
    if (action === "approve") Object.assign(row, { status: "active", authority: "user_confirmed" });
    else if (action === "reject") row.status = "rejected";
    else if (action === "forget") row.status = "archived";
    else if (method === "PATCH" && typeof body?.body === "string") {
      // A body edit supersedes: the old record goes to history, a new one takes its place.
      const next: MemoryRecord = { ...row, id: `${row.id}-v2`, body: body.body as string, supersedes: row.id, authority: "user_stated", source: { kind: "ui" }, updatedAt: Date.now() };
      Object.assign(row, { status: "superseded", supersededBy: next.id });
      data.records.push(next);
      return ok({ record: next });
    } else if (method === "PATCH") Object.assign(row, body);
    row.updatedAt = Date.now();
    return ok({ record: row });
  }
  if (path === "/api/portal/memory/revisions" && method === "GET") {
    const recordId = params.get("recordId");
    return ok({ revisions: data.revisions.filter((revision) => !recordId || revision.recordId === recordId) });
  }
  if (path === "/api/portal/approvals" && method === "GET") return ok({ approvals: live.approvals.filter((a) => a.status === "pending") });
  const decide = path.match(/^\/api\/portal\/approvals\/([^/]+)\/decide$/);
  if (decide && method === "POST") {
    const row = live.approvals.find((entry) => entry.id === decide[1]);
    if (!row) return missing("approval");
    const approve = !!body?.approve;
    Object.assign(row, {
      status: approve ? "approved" : "denied",
      decidedAt: Date.now(),
      decision: { approve, scope: (body?.scope as ApprovalScope | undefined) ?? "once" },
    });
    return ok({ approval: row });
  }
  if (path === "/api/portal/approvals/grants" && method === "GET") return ok({ grants: data.grants });
  const grant = path.match(/^\/api\/portal\/approvals\/grants\/([^/]+)$/);
  if (grant && method === "DELETE") {
    const row = data.grants.find((entry) => entry.id === grant[1]);
    if (!row) return missing("grant");
    row.revokedAt = Date.now();
    return { body: null, status: 204 };
  }
  return null;
}
