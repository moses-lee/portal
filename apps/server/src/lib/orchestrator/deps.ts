/**
 * The slice of Portal the orchestrator acts through, as one injectable object. Tools and the tick
 * only ever reach Portal via this surface, so tests run them against fakes and the live wiring
 * below (over the server's sessions, projects, and settings services) is the only place that
 * touches the real ones.
 */
import { open } from "node:fs/promises";
import os from "node:os";
import { execCommand } from "../exec-command.ts";
import type { ExecResult } from "../exec-command.ts";
import { listDirectories, resolveDirectory } from "../fs-paths.ts";
import { type GitInfo, readGitInfo } from "../git-info.ts";
import { fetchRepo, pullFastForward, readGithubSummary } from "../github-summary.ts";
import { runConfiguredScript } from "../script-runner.ts";
import type { ScriptOutcome, ScriptRunOptions } from "../script-runner.ts";
import type { ScriptKind } from "@portal/shared/scripts";
import { toMeta } from "../acp-runtime.ts";
import { defaultAgentId, listAgents } from "../agents.ts";
import type { AppContext } from "../../context.ts";
import { summarizeProject } from "../../projects/store.ts";
import type {
  AgentInfo, BranchInfo, DirListing, EventPage, GithubSummary, Project, ProjectSummary, PullInfo, RemovedProject,
  SessionMeta, SessionState, WorktreeMeta,
} from "../types.ts";
import { defaultGh, ensureWorktree, getPull, listBranches, listPulls, mainWorktreeOf, removeWorktree, repoRootOf } from "../worktrees.ts";
import { cloneRepo, getGithubLogin, readOriginUrl, searchAttentionPulls } from "./github-attention.ts";
import type { PullAttention } from "./types.ts";
import { readWorktreeState, type WorktreeState } from "./worktree-state.ts";

// Kept here for the tests and tools that already import them from this module.
export { execCommand };
export type { ExecResult };

/** The longest a user script may run inside a Talk to Portal tool call, whatever its own timeout says. */
export const ORCHESTRATOR_SCRIPT_TIMEOUT_SECONDS = 240;

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
  scripts: {
    /** Run the user's script for `kind` as configured in settings; see script-runner.ts. Throws when it fails and the script says to abort. */
    run(kind: ScriptKind, opts: ScriptRunOptions): Promise<ScriptOutcome>;
  };
};

/** What the runtime needs from the settings store. */
export type OrchestratorSettingsStore = Pick<AppContext["settings"], "read" | "orchestrator" | "apiKey" | "subscribe">;

// ---------------------------------------------------------------------------------------------
// Process helpers, shared by the live deps and the tool tests
// ---------------------------------------------------------------------------------------------

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

/** The server services the live deps act through. Read at call time, so the order services are built in does not matter. */
export type OrchestratorServices = Pick<AppContext, "sessions" | "projects" | "settings">;

export function liveDeps(ctx: OrchestratorServices): OrchestratorDeps {
  /** The ACP runtime once it has loaded its sessions, as the old module-level `ready` promise gave it. */
  const acp = async () => {
    await ctx.sessions.ready;
    return ctx.sessions;
  };
  const projects = async () => {
    await ctx.projects.ready;
    return ctx.projects;
  };
  return {
    sessions: {
      list: async () => (await acp()).listSessions(),
      get: async (id) => {
        const session = (await acp()).getSession(id);
        return session ? toMeta(session) : null;
      },
      create: async (cwd, agentId, projectId) => toMeta(await (await acp()).createSession(cwd, agentId, projectId)),
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
      list: async () => listAgents(),
      defaultId: async () => defaultAgentId,
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
    scripts: {
      // A tool call has five minutes (agent.ts CALL_TIMEOUT_MS); a script must leave time for git after it.
      run: (kind, opts) => runConfiguredScript(kind, { ...opts, maxTimeoutSeconds: ORCHESTRATOR_SCRIPT_TIMEOUT_SECONDS }, ctx.settings),
    },
  };
}

/** The settings service as the runtime sees it, looked up on every call. */
export function liveSettingsStore(ctx: Pick<AppContext, "settings">): OrchestratorSettingsStore {
  return {
    read: () => ctx.settings.read(),
    orchestrator: () => ctx.settings.orchestrator(),
    apiKey: (provider) => ctx.settings.apiKey(provider),
    subscribe: (listener) => ctx.settings.subscribe(listener),
  };
}
