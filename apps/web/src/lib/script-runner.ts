/**
 * Runs the user's scripts (see scripts.ts) where an action happens. `runScript` takes the script's
 * settings explicitly so tests and callers with their own store can use it; `runConfiguredScript`
 * reads them from Portal's settings store.
 */
import { childEnv } from "./child-env.ts";
import { execCommand } from "./exec-command.ts";
import type { ExecResult } from "./exec-command.ts";
import { isScriptEnabled, scriptDefinitions } from "./scripts.ts";
import type { ScriptKind, ScriptSettings } from "./scripts.ts";
import type { Project, WorktreeMeta } from "./types.ts";

export type ScriptRunOptions = {
  /** The folder the command runs in. */
  cwd: string;
  /** Extra variables for the command, on top of the user's environment; what the action is about. */
  env?: Record<string, string>;
  /** A ceiling on the configured timeout, for callers with a time budget of their own (the Talk to Portal turn). */
  maxTimeoutSeconds?: number;
};

/** Where the pre-deletion script runs (the project's folder) and what it is told about the worktree. */
export function preWorktreeDeleteRun(project: Project & { worktree: WorktreeMeta }, { worktreePath, repoRoot }: { worktreePath: string; repoRoot: string }): ScriptRunOptions {
  return {
    cwd: project.path,
    env: { PORTAL_WORKTREE_PATH: worktreePath, PORTAL_REPO_ROOT: repoRoot, PORTAL_BRANCH: project.worktree.branch },
  };
}

export type ScriptOutcome =
  /** The script is off (no command). */
  | { ran: false }
  | {
    ran: true;
    /** Exit code 0 and no timeout. */
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  };

/** The script ran and failed, and its settings say the action must not go ahead. Answered as a 409. */
export class ScriptError extends Error {
  status = 409;
  script: ScriptKind;
  outcome: Extract<ScriptOutcome, { ran: true }>;
  constructor(kind: ScriptKind, settings: ScriptSettings, outcome: Extract<ScriptOutcome, { ran: true }>) {
    super(describeFailure(kind, settings, outcome));
    this.name = "ScriptError";
    this.script = kind;
    this.outcome = outcome;
  }
}

/** How much of each stream is kept; plenty for a build tool's last lines, bounded for the browser. */
export const SCRIPT_OUTPUT_BYTES = 64 * 1024;
/** How much of the output a failure message quotes. */
const MESSAGE_OUTPUT_CHARS = 1200;

/** What went wrong, for the person who wrote the script: the reason, then the tail of what it printed. */
export function describeFailure(kind: ScriptKind, settings: ScriptSettings, outcome: Extract<ScriptOutcome, { ran: true }>): string {
  const label = scriptDefinitions[kind].label.toLowerCase();
  const reason = outcome.timedOut
    ? `did not finish within ${settings.timeoutSeconds} seconds`
    : outcome.code === null
      ? "could not be started"
      : `exited with code ${outcome.code}`;
  const output = (outcome.stderr.trim() || outcome.stdout.trim()).slice(-MESSAGE_OUTPUT_CHARS).trim();
  return `The "${label}" script ${reason}.${output ? `\n${output}` : ""}`;
}

export type ScriptExec = (command: string, opts: { cwd: string; timeoutMs: number; maxBytes: number; env?: Record<string, string>; shell?: string | true }) => Promise<ExecResult>;

/** The shell scripts run in: the user's login shell, like Portal's terminals, so their usual syntax works. */
export function scriptShell(env: NodeJS.ProcessEnv = childEnv()): string | true {
  return env.SHELL || true;
}

/**
 * Run the script for `kind` with `settings` in `opts.cwd`. Resolves with what happened; throws a
 * `ScriptError` only when the script failed and `abortOnFailure` is set. A failure the settings
 * let through is logged so it can still be found.
 */
export async function runScript(kind: ScriptKind, settings: ScriptSettings, opts: ScriptRunOptions, exec: ScriptExec = execCommand): Promise<ScriptOutcome> {
  if (!isScriptEnabled(settings)) return { ran: false };
  const timeoutSeconds = Math.min(settings.timeoutSeconds, opts.maxTimeoutSeconds ?? Infinity);
  const effective = timeoutSeconds === settings.timeoutSeconds ? settings : { ...settings, timeoutSeconds };
  const result = await exec(settings.command, {
    cwd: opts.cwd,
    timeoutMs: timeoutSeconds * 1000,
    maxBytes: SCRIPT_OUTPUT_BYTES,
    env: { PORTAL_SCRIPT: kind, ...opts.env },
    shell: scriptShell(),
  });
  const outcome: Extract<ScriptOutcome, { ran: true }> = {
    ran: true,
    ok: result.code === 0 && !result.timedOut,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
  if (outcome.ok) return outcome;
  if (settings.abortOnFailure) throw new ScriptError(kind, effective, outcome);
  console.warn(`Continuing after a script failure. ${describeFailure(kind, effective, outcome)}`);
  return outcome;
}

/** `runScript` with the settings currently stored for `kind`. */
export async function runConfiguredScript(kind: ScriptKind, opts: ScriptRunOptions): Promise<ScriptOutcome> {
  // Loaded on first use so importing this module (the orchestrator deps do, in tests too) does not
  // create the process-wide settings store as a side effect.
  const { getSettingsStore } = await import("./settings-storage.ts");
  const settings = (await getSettingsStore().read()).scripts[kind];
  return runScript(kind, settings, opts);
}
