/**
 * The slice of Portal the orchestrator acts through, as one injectable object. Tools and the tick
 * only ever reach Portal via this surface, so tests run them against fakes and the live wiring
 * below is the only place that touches the real modules.
 *
 * `acp.ts`, `agents.ts`, `projects.ts`, and `settings-storage.ts` can only be loaded inside Next
 * (`server-only`, extension-less imports, disk reads at import time), while `runtime.ts` is also
 * imported by Node tests. The live deps therefore import those four lazily, on first use; the
 * pure helper modules are imported directly.
 */
import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import os from "node:os";
import { childEnv } from "../child-env.ts";
import { listDirectories, resolveDirectory } from "../fs-paths.ts";
import { type GitInfo, readGitInfo } from "../git-info.ts";
import { fetchRepo, pullFastForward, readGithubSummary } from "../github-summary.ts";
import { summarizeProject } from "../projects-store.ts";
import type { SettingsStore } from "../settings-store.ts";
import type {
  AgentInfo, BranchInfo, DirListing, EventPage, GithubSummary, Project, ProjectSummary, PullInfo, RemovedProject,
  SessionMeta, SessionState, WorktreeMeta,
} from "../types.ts";
import { defaultGh, ensureWorktree, getPull, listBranches, listPulls, mainWorktreeOf, removeWorktree, repoRootOf } from "../worktrees.ts";
import { cloneRepo, getGithubLogin, readOriginUrl, searchAttentionPulls } from "./github-attention.ts";
import type { PullAttention } from "./types.ts";
import { readWorktreeState, type WorktreeState } from "./worktree-state.ts";

export type ExecResult = {
  /** Exit code; null when the process was killed (timeout) or could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type PullState = "open" | "closed" | "merged";

/** What the attention search hands back; the fields beyond `pulls`/`error` are additive and may be absent from fakes. */
export type AttentionSearch = {
  pulls: PullAttention[];
  error: string | null;
  /** Something went wrong short of losing everything (a partial response, a failed later page). */
  warning?: string | null;
  /** True when the search had more matches than were fetched. */
  truncated?: boolean;
  total?: { authored: number; requested: number };
};

export type OrchestratorDeps = {
  sessions: {
    list(): Promise<SessionMeta[]>;
    get(id: string): Promise<SessionMeta | null>;
    create(cwd: string, agentId: string, projectId: string): Promise<SessionMeta>;
    prompt(id: string, text: string): Promise<void>;
    cancel(id: string): Promise<void>;
    respondPermission(id: string, requestId: string, optionId: string | null): Promise<void>;
    setConfigOption(id: string, configId: string, value: string | boolean): Promise<SessionState>;
    setMode(id: string, modeId: string): Promise<SessionState>;
    readEvents(id: string, opts?: { before?: number; limit?: number }): Promise<EventPage>;
    attach(id: string): Promise<void>;
    remove(id: string): Promise<boolean>;
  };
  agents: {
    list(): Promise<AgentInfo[]>;
    defaultId(): Promise<string>;
  };
  projects: {
    list(): Promise<Project[]>;
    get(id: string): Promise<Project | undefined>;
    findByPath(realpath: string): Promise<Project | undefined>;
    add(input: { path: string; name?: string; worktree?: WorktreeMeta }): Promise<Project>;
    rename(id: string, name: string): Promise<Project>;
    remove(id: string, opts: { keep: boolean }): Promise<void>;
    listRemoved(): Promise<RemovedProject[]>;
    getRemoved(id: string): Promise<RemovedProject | undefined>;
    restore(id: string, patch?: { worktree?: WorktreeMeta }): Promise<Project>;
    summarize(project: Project): Promise<ProjectSummary>;
  };
  git: {
    info(dir: string): Promise<GitInfo>;
    originUrl(dir: string): Promise<string | null>;
    repoRootOf(dir: string): Promise<string>;
    mainWorktreeOf(dir: string): Promise<string>;
    ensureWorktree(opts: { repoRoot: string; branch: string; create?: boolean }): Promise<{ path: string; created: boolean }>;
    removeWorktree(opts: { repoRoot: string; path: string; branch: string; force?: boolean }): Promise<{ branchDeleted: boolean }>;
    listBranches(repoRoot: string): Promise<{ defaultBranch: string | null; branches: BranchInfo[] }>;
    listPulls(repoRoot: string): Promise<{ pulls: PullInfo[] | null; pullsError: string | null }>;
    getPull(repoRoot: string, number: number): Promise<PullInfo>;
    githubSummary(dir: string, opts: { fetch: boolean }): Promise<GithubSummary>;
    fetchRepo(repoRoot: string): Promise<{ fetchedAt: number | null; fetchError: string | null }>;
    pullFastForward(dir: string): Promise<GithubSummary>;
    worktreeState(opts: { repoRoot: string; path: string; branch: string; defaultBranch: string | null }): Promise<WorktreeState>;
  };
  github: {
    login(): Promise<string>;
    /** `updatedSince` (epoch ms) drops PRs untouched since then at the search itself. */
    searchAttentionPulls(opts?: { updatedSince?: number }): Promise<AttentionSearch>;
    /** The current state of one PR by URL, or null when gh cannot answer. */
    pullState(url: string): Promise<PullState | null>;
    /** Clones `owner/name` under Portal's repos directory and returns the checkout path. */
    cloneRepo(repo: string): Promise<string>;
  };
  fs: {
    listDirectories(dir: string): Promise<DirListing>;
    resolveDirectory(input: string): Promise<string>;
    readFile(file: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }>;
    exec(command: string, opts: { cwd: string; timeoutMs: number; maxBytes: number }): Promise<ExecResult>;
  };
};

/** What the runtime needs from the settings store. */
export type OrchestratorSettingsStore = Pick<SettingsStore, "read" | "orchestrator" | "apiKey" | "subscribe">;

// ---------------------------------------------------------------------------------------------
// Process helpers, shared by the live deps and the tool tests
// ---------------------------------------------------------------------------------------------

/**
 * Collects a stream into at most `maxBytes`: the first half is kept as it arrives, the last half
 * rolls, and the amount dropped in between is noted in the text. Memory stays bounded however much
 * a command prints.
 */
class BoundedOutput {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private omitted = 0;
  private readonly half: number;

  constructor(maxBytes: number) {
    this.half = Math.max(1, Math.floor(maxBytes / 2));
  }

  push(chunk: Buffer) {
    if (this.headBytes < this.half) {
      const take = chunk.subarray(0, this.half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.half && this.tail.length > 0) {
      const first = this.tail[0];
      const excess = this.tailBytes - this.half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.omitted += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.omitted += excess;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    return this.omitted > 0 ? `${head}\n[... ${this.omitted} bytes omitted ...]\n${tail}` : head + tail;
  }
}

/**
 * Run `command` through the shell in `cwd` with the user's environment (not the dev server's).
 * The child leads its own process group so a timeout kills everything it started, not just the
 * shell. Never rejects: a timeout or a start failure is reported in the result.
 */
export function execCommand(command: string, { cwd, timeoutMs, maxBytes }: { cwd: string; timeoutMs: number; maxBytes: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stdout = new BoundedOutput(maxBytes);
    const stderr = new BoundedOutput(maxBytes);
    let timedOut = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, { shell: true, detached: true, cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      // Never started (bad cwd, no shell): the message is all there is to report.
      killGroup();
      finish({ code: null, stdout: stdout.text(), stderr: [stderr.text(), err.message].filter(Boolean).join("\n"), timedOut });
    });
    child.on("close", (code) => {
      finish({ code: timedOut ? null : code, stdout: stdout.text(), stderr: stderr.text(), timedOut });
    });
  });
}

/** The first `maxBytes` of a file as UTF-8, with whether more followed. */
export async function readFileCapped(file: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: size, truncated: size > bytesRead };
  } finally {
    await handle.close();
  }
}

async function readPullState(url: string): Promise<PullState | null> {
  try {
    const { stdout } = await defaultGh(["pr", "view", url, "--json", "state"], { cwd: os.homedir() });
    const state = String((JSON.parse(stdout) as { state?: unknown }).state ?? "").toLowerCase();
    return state === "merged" || state === "closed" || state === "open" ? state : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Live wiring
// ---------------------------------------------------------------------------------------------

/** Memoize an async loader; a failed load is retried on the next call rather than cached. */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () => (loading ??= load().catch((err: unknown) => {
    loading = null;
    throw err;
  }));
}

export function liveDeps(): OrchestratorDeps {
  const acp = lazy(async () => {
    const loaded = await import("../acp.ts");
    await loaded.ready;
    return loaded;
  });
  const agents = lazy(() => import("../agents.ts"));
  const projects = lazy(async () => {
    const { projects } = await import("../projects.ts");
    await projects.ready;
    return projects;
  });
  return {
    sessions: {
      list: async () => (await acp()).listSessions(),
      get: async (id) => {
        const runtime = await acp();
        const session = runtime.getSession(id);
        return session ? runtime.toMeta(session) : null;
      },
      create: async (cwd, agentId, projectId) => {
        const runtime = await acp();
        return runtime.toMeta(await runtime.createSession(cwd, agentId, projectId));
      },
      prompt: async (id, text) => (await acp()).sendPrompt(id, text),
      cancel: async (id) => (await acp()).cancel(id),
      respondPermission: async (id, requestId, optionId) => {
        (await acp()).respondPermission(id, requestId, optionId);
      },
      setConfigOption: async (id, configId, value) => (await acp()).setConfigOption(id, configId, value),
      setMode: async (id, modeId) => (await acp()).setMode(id, modeId),
      readEvents: async (id, opts) => (await acp()).readEvents(id, opts),
      attach: async (id) => (await acp()).attach(id),
      remove: async (id) => (await acp()).deleteSession(id),
    },
    agents: {
      list: async () => (await agents()).listAgents(),
      defaultId: async () => (await agents()).defaultAgentId,
    },
    projects: {
      list: async () => (await projects()).list(),
      get: async (id) => (await projects()).get(id),
      findByPath: async (realpath) => (await projects()).findByPath(realpath),
      add: async (input) => (await projects()).add(input),
      rename: async (id, name) => (await projects()).rename(id, name),
      remove: async (id, opts) => (await projects()).remove(id, opts),
      listRemoved: async () => (await projects()).listRemoved(),
      getRemoved: async (id) => (await projects()).getRemoved(id),
      restore: async (id, patch) => (await projects()).restore(id, patch),
      summarize: summarizeProject,
    },
    git: {
      info: readGitInfo,
      originUrl: readOriginUrl,
      repoRootOf,
      mainWorktreeOf,
      ensureWorktree,
      removeWorktree,
      listBranches,
      listPulls: (repoRoot) => listPulls(repoRoot),
      getPull: (repoRoot, number) => getPull(repoRoot, number),
      githubSummary: (dir, opts) => readGithubSummary(dir, opts),
      fetchRepo: (repoRoot) => fetchRepo(repoRoot, { minIntervalMs: 0 }),
      pullFastForward: (dir) => pullFastForward(dir),
      worktreeState: readWorktreeState,
    },
    github: {
      login: () => getGithubLogin(),
      searchAttentionPulls: (opts) => searchAttentionPulls(opts),
      pullState: readPullState,
      cloneRepo: (repo) => cloneRepo({ repo }),
    },
    fs: {
      listDirectories: (dir) => listDirectories(dir),
      resolveDirectory: (input) => resolveDirectory(input),
      readFile: readFileCapped,
      exec: execCommand,
    },
  };
}

/** The process-wide settings store, loaded on first use (see the module comment). */
export function liveSettingsStore(): OrchestratorSettingsStore {
  const store = lazy(async () => (await import("../settings-storage.ts")).getSettingsStore());
  return {
    read: async () => (await store()).read(),
    orchestrator: async () => (await store()).orchestrator(),
    apiKey: async (provider) => (await store()).apiKey(provider),
    subscribe(listener) {
      let unsubscribe: (() => void) | null = null;
      let cancelled = false;
      store().then((settings) => {
        if (!cancelled) unsubscribe = settings.subscribe(listener);
      }).catch(() => {});
      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    },
  };
}
