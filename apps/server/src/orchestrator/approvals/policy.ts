/**
 * Which calls need the user's approval, decided by code alone. Autonomy follows reversibility:
 * reading, creating worktrees, sessions, projects and items, and prompting a session stay ungated;
 * deleting, loosening a session's permissions, changing a checkout, and any shell command outside
 * the read-only allowlist ask first. For each gated call the policy writes the title and the exact
 * Markdown summary the approval dialog shows, and names the repository it acts on (what a `repo`
 * grant matches). Names, titles and paths in a summary come from agents and repositories, so they
 * are always put in code spans: text there can never pose as the dialog's own words.
 */
import path from "node:path";
import type { ApprovalRisk } from "@portal/contracts/approvals";
import { reduce } from "@portal/shared/transcript";
import { expandHome } from "../../lib/fs-paths.ts";
import { displayPath } from "../../lib/git-info.ts";
import { githubRepoUrl } from "../../lib/github-summary.ts";
import { defaultSettingsFile } from "../../lib/settings-store.ts";
import type { Project, SessionMeta } from "../../lib/types.ts";
import type { OrchestratorDeps } from "../deps.ts";
import { findById } from "../ids.ts";
import type { ItemAction } from "../types.ts";
import { classifyCommand } from "./shell.ts";

export type Assessment = {
  risk: ApprovalRisk;
  /** Short, plain text: "Remove worktree feat-x of portal". */
  title: string;
  /** Markdown: exactly what will happen. */
  summary: string;
  /** "owner/name" the call acts on, or null. */
  repo: string | null;
};

/** Tools that may need approval; every other tool always runs. */
export const GATED_TOOLS = ["delete_session", "remove_project", "answer_permission", "set_session_config", "pull_fast_forward", "run_command"] as const;
/** Card actions the server runs; each needs approval unless an `always` grant covers it (never for remove_worktree). */
export const GATED_ACTIONS = ["start_session", "send_prompt", "remove_worktree"] as const;

const gatedTools = new Set<string>(GATED_TOOLS);

export function isGatedTool(name: string): boolean {
  return gatedTools.has(name);
}

// ---------------------------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------------------------

const TITLE_CHARS = 120;

/** One line of untrusted text, shortened. */
function oneLine(text: string, max = TITLE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Untrusted text as an inline code span, on one line; the fence outgrows any backticks inside. */
export function code(text: string, max = TITLE_CHARS): string {
  const flat = oneLine(text, max);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") || flat === "" ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** Untrusted text as a fenced block, verbatim; the fence outgrows any backtick run inside. */
export function block(text: string, lang = ""): string {
  const longest = Math.max(0, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

// ---------------------------------------------------------------------------------------------
// Lookups (a failure means "unknown": the summary says less, the gate never opens because of it)
// ---------------------------------------------------------------------------------------------

async function repoOfDir(deps: OrchestratorDeps, dir: string): Promise<string | null> {
  const origin = await deps.git.originUrl(dir).catch(() => null);
  const url = origin ? githubRepoUrl(origin) : null;
  return url ? url.slice("https://github.com/".length) : null;
}

// By id or unique prefix, as the tools resolve them: a prefix must not slip past the gate as "unknown".
async function projectOf(deps: OrchestratorDeps, id: string | undefined | null): Promise<Project | null> {
  if (!id) return null;
  return (await deps.projects.get(id).catch(() => undefined)) ?? findById(await deps.projects.list().catch(() => []), id) ?? null;
}

async function sessionOf(deps: OrchestratorDeps, id: string): Promise<SessionMeta | null> {
  return (await deps.sessions.get(id).catch(() => null)) ?? findById(await deps.sessions.list().catch(() => []), id) ?? null;
}

const sessionName = (meta: SessionMeta | null, id: string) => (meta?.title ? `${code(meta.title)} (${code(id)})` : code(id));
const projectName = (project: Project) => `${code(project.name)} (${code(displayPath(project.path))})`;

// ---------------------------------------------------------------------------------------------
// Session permission modes: loosening needs approval, tightening does not
// ---------------------------------------------------------------------------------------------

/**
 * How much a mode lets an agent do without asking, for the modes and approval policies Claude Code
 * and Codex announce. Switching to a mode not listed here always asks.
 */
const MODE_RANK: Record<string, number> = {
  plan: 0, "read-only": 0, readonly: 0, dontask: 0,
  default: 1, ask: 1, untrusted: 1, "on-request": 1,
  acceptedits: 2, auto: 2, "workspace-write": 2, "on-failure": 2,
  bypasspermissions: 3, "full-access": 3, "danger-full-access": 3, never: 3, yolo: 3,
};

const modeRank = (mode: string | null | undefined) => (mode == null ? undefined : MODE_RANK[mode.toLowerCase()]);

/** Config options that govern permissions rather than, say, the model. */
const PERMISSION_OPTION = /mode(?!l)|permission|approval|sandbox/i;

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

type Input = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

async function assessDeleteSession(deps: OrchestratorDeps, input: Input): Promise<Assessment | null> {
  const id = str(input.sessionId);
  if (!id) return null;
  const meta = await sessionOf(deps, id);
  const project = await projectOf(deps, meta?.projectId);
  return {
    risk: "destructive",
    title: `Delete session ${oneLine(meta?.title ?? id, 80)}`,
    summary: [
      `Delete the session ${sessionName(meta, id)} and its whole transcript. **This cannot be undone.**`,
      ...(meta ? ["", `- Agent: ${code(meta.agentId)}`, ...(project ? [`- Project: ${projectName(project)}`] : [])] : []),
    ].join("\n"),
    repo: project ? await repoOfDir(deps, project.path) : null,
  };
}

async function assessRemoveProject(deps: OrchestratorDeps, input: Input): Promise<Assessment | null> {
  const project = await projectOf(deps, str(input.id));
  if (!project) return null;
  const repo = await repoOfDir(deps, project.path);
  const sessions = (await deps.sessions.list().catch(() => [])).filter((session) => session.projectId === project.id).length;
  const kept = sessions > 0
    ? `Its ${sessions} session(s) keep running, and the project stays restorable while they exist.`
    : "It has no sessions, so it cannot be restored from Portal afterwards.";
  if (input.deleteWorktree === true && project.worktree) {
    const parent = await projectOf(deps, project.worktree.parentId);
    return {
      risk: "destructive",
      title: `Remove worktree ${oneLine(project.worktree.branch, 60)}${parent ? ` of ${oneLine(parent.name, 40)}` : ""}`,
      summary: [
        `Remove the worktree project ${projectName(project)} from Portal **and delete its folder** with \`git worktree remove\`.`,
        "",
        `- Branch: ${code(project.worktree.branch)}${parent ? ` (from ${code(parent.name)})` : ""}`,
        "- Your pre-deletion script, if one is set, runs first.",
        ...(input.force === true ? ["- **force**: uncommitted changes in the worktree are discarded."] : []),
        `- ${kept}`,
      ].join("\n"),
      repo,
    };
  }
  return {
    risk: "write",
    title: `Remove project ${oneLine(project.name, 80)} from Portal`,
    summary: [
      `Remove the project ${projectName(project)} from Portal. The folder stays on disk.`,
      "",
      `- ${kept}`,
      ...(input.deleteWorktree === true ? ["- It is not a worktree, so nothing is deleted from disk."] : []),
    ].join("\n"),
    repo,
  };
}

async function assessAnswerPermission(deps: OrchestratorDeps, input: Input): Promise<Assessment | null> {
  const id = str(input.sessionId);
  const requestId = str(input.requestId);
  const optionId = input.optionId;
  // Cancelling (null) grants nothing.
  if (!id || !requestId || typeof optionId !== "string") return null;
  const meta = await sessionOf(deps, id);
  const events = await deps.sessions.readEvents(meta?.id ?? id, { limit: 300 }).then((page) => page.events, () => null);
  const request = events
    ? reduce(events).find((entry) => entry.kind === "permission" && entry.requestId === requestId)
    : undefined;
  const option = request && request.kind === "permission" ? request.options.find((candidate) => candidate.optionId === optionId) : undefined;
  if (option && option.kind.startsWith("reject")) return null;
  const project = await projectOf(deps, meta?.projectId);
  const what = request && request.kind === "permission" ? request.toolCall.title ?? "a tool call" : "a request Portal could not read";
  const lasting = option?.kind === "allow_always" ? " This allows it for the rest of the session, not just once." : "";
  return {
    risk: "write",
    title: `Allow ${oneLine(what, 70)} in ${oneLine(meta?.title ?? id, 40)}`,
    summary: [
      `Answer the permission request in session ${sessionName(meta, id)} with ${option ? code(option.name) : code(optionId)}.${lasting}`,
      "",
      `- Request: ${code(what, 400)}`,
      ...(option ? [] : ["- Portal could not find this option on the request, so it cannot tell what it allows."]),
    ].join("\n"),
    repo: project ? await repoOfDir(deps, project.path) : null,
  };
}

async function assessSessionConfig(deps: OrchestratorDeps, input: Input): Promise<Assessment | null> {
  const id = str(input.sessionId);
  if (!id) return null;
  const meta = await sessionOf(deps, id);
  if (!meta) return null;
  let from: string | null;
  let to: string;
  let label: string;
  const modeId = str(input.modeId);
  const configId = str(input.configId);
  if (modeId) {
    from = meta.state.modes?.currentModeId ?? null;
    to = modeId;
    label = "mode";
  } else if (configId && (typeof input.value === "string" || typeof input.value === "boolean")) {
    const option = meta.state.configOptions.find((candidate) => candidate.id === configId);
    if (!PERMISSION_OPTION.test(configId) && !(option && PERMISSION_OPTION.test(option.name))) return null;
    from = option ? String(option.currentValue) : null;
    to = String(input.value);
    label = option?.name ?? configId;
  } else {
    return null;
  }
  const next = modeRank(to);
  const current = modeRank(from) ?? 0;
  // Tightening (or staying) never asks; from an unknown mode only the strictest ones are safe.
  if (next !== undefined && next <= current) return null;
  const project = await projectOf(deps, meta.projectId);
  return {
    risk: "write",
    title: `Switch ${oneLine(meta.title ?? id, 60)} to ${oneLine(to, 40)}`,
    summary: [
      `Change the ${code(label)} of session ${sessionName(meta, id)} from ${from ? code(from) : "an unknown value"} to ${code(to)}.`,
      "",
      "The agent will be allowed to do more without asking you.",
    ].join("\n"),
    repo: project ? await repoOfDir(deps, project.path) : null,
  };
}

async function assessPull(deps: OrchestratorDeps, input: Input): Promise<Assessment | null> {
  const project = await projectOf(deps, str(input.projectId));
  if (!project) return null;
  const branch = await deps.git.info(project.path).then((info) => info?.branch ?? null, () => null);
  return {
    risk: "write",
    title: `Pull ${branch ? oneLine(branch, 60) : "the current branch"} in ${oneLine(project.name, 60)}`,
    summary: [
      `Run \`git pull --ff-only\` in ${projectName(project)}${branch ? ` on branch ${code(branch)}` : ""}.`,
      "",
      "This moves the checkout to the remote's commits; it fails rather than merging when the branch diverged or the tree has changes.",
    ].join("\n"),
    repo: await repoOfDir(deps, project.path),
  };
}

/** A command that names one of Portal's secret files (or its home folder) always asks, even when it only reads. */
function touchesPortalSecrets(command: string): boolean {
  const home = path.dirname(defaultSettingsFile());
  const lower = command.toLowerCase();
  return ["settings.json", "server.key", home, displayPath(home)].some((needle) => lower.includes(needle.toLowerCase()));
}

async function assessCommand(deps: OrchestratorDeps, input: Input): Promise<Assessment | null> {
  const command = str(input.command);
  const cwd = str(input.cwd);
  if (!command || !cwd) return null;
  const verdict = touchesPortalSecrets(command)
    ? { readOnly: false as const, reason: "it names Portal's settings, key, or home folder", risk: "write" as const }
    : classifyCommand(command);
  if (verdict.readOnly) return null;
  const dir = await deps.fs.resolveDirectory(cwd).catch(() => expandHome(cwd.trim()));
  return {
    risk: verdict.risk,
    title: `Run ${oneLine(command, 70)}`,
    summary: [
      `Run this shell command in ${code(displayPath(dir))}:`,
      "",
      block(command, "sh"),
      "",
      `Portal asks because ${verdict.reason}.`,
    ].join("\n"),
    repo: await repoOfDir(deps, dir),
  };
}

const assessors: Record<(typeof GATED_TOOLS)[number], (deps: OrchestratorDeps, input: Input) => Promise<Assessment | null>> = {
  delete_session: assessDeleteSession,
  remove_project: assessRemoveProject,
  answer_permission: assessAnswerPermission,
  set_session_config: assessSessionConfig,
  pull_fast_forward: assessPull,
  run_command: assessCommand,
};

/** Whether this call needs approval, and what the dialog says; null lets it run now. */
export async function assessToolCall(deps: OrchestratorDeps, tool: string, input: unknown): Promise<Assessment | null> {
  if (!isGatedTool(tool)) return null;
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {};
  return assessors[tool as (typeof GATED_TOOLS)[number]](deps, record);
}

// ---------------------------------------------------------------------------------------------
// Card actions (server-side item buttons whose text the agent wrote)
// ---------------------------------------------------------------------------------------------

/** What approving a server-side card action shows; the prompt in full, since the agent wrote it. */
export async function assessCardAction(deps: OrchestratorDeps, action: ItemAction): Promise<Assessment | null> {
  switch (action.type) {
    case "start_session": {
      const project = await projectOf(deps, action.projectId);
      const agent = action.agentId ?? await deps.agents.defaultId().catch(() => "the default agent");
      return {
        risk: "write",
        title: `Start a session in ${oneLine(project?.name ?? action.projectId, 60)}`,
        summary: [
          `Start a new ${code(agent)} session in ${project ? projectName(project) : code(action.projectId)} and send it this prompt:`,
          "",
          block(action.prompt),
        ].join("\n"),
        repo: project ? await repoOfDir(deps, project.path) : null,
      };
    }
    case "send_prompt": {
      const meta = await sessionOf(deps, action.sessionId);
      const project = await projectOf(deps, meta?.projectId);
      return {
        risk: "write",
        title: `Send a prompt to ${oneLine(meta?.title ?? action.sessionId, 60)}`,
        summary: [`Send this prompt to session ${sessionName(meta, action.sessionId)}:`, "", block(action.prompt)].join("\n"),
        repo: project ? await repoOfDir(deps, project.path) : null,
      };
    }
    case "remove_worktree": {
      const assessment = await assessRemoveProject(deps, { id: action.projectId, deleteWorktree: true });
      return assessment ?? {
        risk: "destructive",
        title: "Remove a worktree",
        summary: `Remove the worktree project ${code(action.projectId)} and delete its folder. Portal does not know this project any more, so the action will most likely fail.`,
        repo: null,
      };
    }
    default:
      return null;
  }
}
