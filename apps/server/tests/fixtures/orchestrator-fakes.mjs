/**
 * Fakes for the orchestrator tests: an in-memory `OrchestratorDeps`, a settings store, a clock the
 * tests advance by hand, and a presence counter. Everything records what it was asked so tests
 * can assert on side effects (prompts sent, sessions created) without any Portal module loaded.
 */
import { defaultOrchestratorSettings } from "../../src/orchestrator/types.ts";

export const T0 = 1_700_000_000_000;

/** Let queued promise callbacks (tool loops, store writes, scheduler reschedules) settle. */
export async function flush(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function sessionMeta(overrides = {}) {
  return {
    id: "s1", agentId: "claude", agentName: "Claude Code", cwd: "/repo", projectId: "p1", createdAt: T0 - 60_000, lastActiveAt: T0 - 30_000,
    title: "Fix the login bug", busy: false, awaitingPermission: false, link: { status: "live" },
    state: { modes: null, configOptions: [], commands: [] }, ...overrides,
  };
}

export function project(overrides = {}) {
  return { id: "p1", name: "app", path: "/repo", createdAt: T0 - 100_000, ...overrides };
}

/** One PR as `searchAttentionPulls` returns it: open, authored, clean. */
export function attentionPull(overrides = {}) {
  const number = overrides.number ?? 7;
  const repo = overrides.repo ?? "acme/app";
  return {
    repo, number, url: `https://github.com/${repo}/pull/${number}`, title: "Add thing", author: "moses-lee", roles: ["author"],
    state: "open", draft: false, baseBranch: "main", headBranch: "feat", checks: "passing", reviewDecision: null, mergeable: "mergeable",
    updatedAt: T0, localProjectId: null, worktreeProjectId: null, ...overrides,
  };
}

const emptyState = () => ({ modes: null, configOptions: [], commands: [] });

/**
 * Deps over mutable `state`; every method that would touch the machine is a stub that records or
 * throws. `pulls` seeds the attention search; `terminals` seeds the terminal list; `github` and `fs`
 * override those groups; anything else overrides `git`. Set `state.promptFailure` to make `sessions.prompt` throw that message.
 */
export function fakeDeps({ sessions = [], projects = [], events = {}, pulls = [], terminals = [], github = {}, fs = {}, scripts = {}, ...git } = {}) {
  const state = { sessions, projects, events, pulls, terminals, prompts: [], created: [], removed: [], added: [], searches: [], scripts: [], promptFailure: null };
  const reject = (what) => async () => { throw new Error(`${what} is not available in this test.`); };
  const deps = {
    sessions: {
      list: async () => state.sessions,
      get: async (id) => state.sessions.find((session) => session.id === id) ?? null,
      create: async (cwd, agentId, projectId) => {
        const meta = sessionMeta({ id: `s${state.sessions.length + 1}`, cwd, agentId, projectId, title: null });
        state.sessions.push(meta);
        state.created.push(meta);
        return meta;
      },
      prompt: async (id, text) => {
        if (state.promptFailure) throw new Error(state.promptFailure);
        state.prompts.push({ id, text });
      },
      cancel: async () => {},
      respondPermission: async () => {},
      setConfigOption: async () => emptyState(),
      setMode: async () => emptyState(),
      readEvents: async (id) => ({ events: state.events[id] ?? [], hasMore: false, nextSeq: (state.events[id] ?? []).length }),
      attach: async () => {},
      remove: async (id) => {
        const before = state.sessions.length;
        state.sessions = state.sessions.filter((session) => session.id !== id);
        return state.sessions.length < before;
      },
    },
    agents: { list: async () => [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }], defaultId: async () => "claude" },
    projects: {
      list: async () => state.projects,
      get: async (id) => state.projects.find((entry) => entry.id === id),
      findByPath: async (realpath) => state.projects.find((entry) => entry.path === realpath),
      add: async ({ path, name, worktree }) => {
        const entry = project({ id: `p${state.projects.length + 1}`, name: name ?? path.split("/").at(-1), path, ...(worktree ? { worktree } : {}) });
        state.projects.push(entry);
        state.added.push(entry);
        return entry;
      },
      rename: async (id, name) => {
        const entry = state.projects.find((candidate) => candidate.id === id);
        entry.name = name;
        return entry;
      },
      remove: async (id, opts) => {
        state.removed.push({ id, ...opts });
        state.projects = state.projects.filter((entry) => entry.id !== id);
      },
      listRemoved: async () => [],
      getRemoved: async () => undefined,
      restore: reject("restore"),
      summarize: async (entry) => ({ ...entry, displayPath: entry.path, git: { root: entry.path, displayRoot: entry.path, branch: "main", detached: false }, exists: true }),
    },
    git: {
      info: async (dir) => ({ root: dir, displayRoot: dir, branch: "main", detached: false }),
      originUrl: async () => null,
      repoRootOf: async (dir) => dir,
      mainWorktreeOf: async (dir) => dir,
      ensureWorktree: reject("ensureWorktree"),
      removeWorktree: reject("removeWorktree"),
      listBranches: async () => ({ defaultBranch: "main", branches: [] }),
      listPulls: async () => ({ pulls: [], pullsError: null }),
      getPull: reject("getPull"),
      githubSummary: reject("githubSummary"),
      fetchRepo: async () => ({ fetchedAt: T0, fetchError: null }),
      pullFastForward: reject("pullFastForward"),
      worktreeState: async () => ({ exists: true, merged: false, dirty: false }),
      ...git,
    },
    github: {
      login: async () => "moses-lee",
      searchAttentionPulls: async (opts) => {
        state.searches.push(opts ?? {});
        return { pulls: state.pulls, error: null };
      },
      pullState: async () => null,
      cloneRepo: reject("cloneRepo"),
      ...github,
    },
    fs: {
      listDirectories: async (dir) => ({ path: dir, parent: null, entries: [] }),
      resolveDirectory: async (input) => input,
      readFile: reject("readFile"),
      exec: reject("exec"),
      ...fs,
    },
    terminals: { list: async () => state.terminals },
    scripts: {
      run: async (kind, opts) => {
        state.scripts.push({ kind, ...opts });
        return { ran: false };
      },
      ...scripts,
    },
  };
  return { deps, state };
}

/** A settings store whose key and intervals tests can change, notifying subscribers like the real one. */
export function fakeSettings({ key = "sk-test", ...overrides } = {}) {
  const listeners = new Set();
  const orchestrator = { ...defaultOrchestratorSettings, ...overrides };
  const prompts = { checks: "Look at CI.", conflicts: "Look at conflicts.", review: "Review this PR." };
  const read = async () => ({ version: 1, gitActions: { prompts }, orchestrator: { ...orchestrator, apiKeys: { openai: !!key, anthropic: false } } });
  return {
    read,
    orchestrator: async () => (await read()).orchestrator,
    // The key serves whichever providers the two model roles use.
    apiKey: async (provider) => (provider === orchestrator.provider || provider === orchestrator.bookkeeping.provider ? key : null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async change({ apiKey, ...patch } = {}) {
      if (apiKey !== undefined) key = apiKey || null;
      Object.assign(orchestrator, patch);
      const settings = await read();
      for (const listener of listeners) listener(settings);
    },
  };
}

/** Timers the test drives: `advance(ms)` runs every timer due by then, in order, letting async work settle after each. */
export function fakeTimers(start = T0) {
  let now = start;
  const pending = [];
  return {
    pending,
    now: () => now,
    setTimeout(fn, ms) {
      const handle = { fn, at: now + ms };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    /** Move the clock without running timers. */
    tick(ms) {
      now += ms;
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;
        pending.shift();
        now = next.at;
        next.fn();
        await flush();
      }
      now = target;
    },
  };
}

export function fakePresence(initial = 0) {
  let count = initial;
  const listeners = new Set();
  return {
    count: () => count,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      count = next;
      for (const listener of listeners) listener(count);
    },
  };
}
