import type { Page } from "@playwright/test";
import { applySettingsPatch, defaultSettings } from "../../src/lib/settings";
import type {
  GithubSummary,
  ProjectSummary,
  SessionSummary,
  StoredEvent,
  SessionMetaEvent,
  PortalEvent,
} from "../../src/lib/types";

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

declare global {
  interface Window {
    __portalEmit: (
      match: string,
      data: unknown,
      type?: string,
      seq?: number,
    ) => void;
    __portalSessions: SessionSummary[];
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

export async function setupPortal(
  page: Page,
  options: {
    history?: StoredEvent[];
    hasMore?: boolean;
    olderDelay?: number;
    /** What `GET /api/projects/<id>/github` answers; defaults to `githubSummary`. */
    github?: GithubSummary;
    /**
     * Let `/api/settings` reach the test server (isolated by its temp PORTAL_HOME) instead of
     * answering with the defaults, for tests of persistence itself.
     */
    realSettings?: boolean;
  } = {},
) {
  const currentSessions = structuredClone(sessions);
  const history = options.history ?? events;
  const requests: { path: string; method: string; body: unknown }[] = [];
  let failSend = false;
  let sendDelay = 0;
  await page.addInitScript(
    ({ sessions }) => {
      window.__portalSessions = sessions;
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
            else
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
    { sessions: currentSessions },
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
      // Parallel tests share the server's settings file; the defaults keep them independent of each other.
      return json({
        settings:
          method === "PATCH"
            ? applySettingsPatch(defaultSettings, body)
            : defaultSettings,
      });
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
      return json({ projects: [project, worktree] });
    if (path === "/api/sessions" && method === "GET")
      return json({ sessions: currentSessions });
    if (path === "/api/sessions" && method === "POST") {
      const session = {
        ...makeSession(
          "created",
          "",
          body.agentId,
          body.projectId === "p1" ? project : worktree,
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
  };
}
