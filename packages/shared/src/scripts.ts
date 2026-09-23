/**
 * User scripts: shell commands Portal runs before certain actions. Each hook point is a
 * `ScriptKind`; adding one means a new entry in `scriptKinds`, its definition in `scriptDefinitions`,
 * and a `runScript` call where the action happens. The settings dialog, the store, and the runner
 * all iterate `scriptKinds`, so nothing else needs to change.
 */

/** The points where a user script can run. */
export type ScriptKind = "preWorktreeDelete";

export const scriptKinds: readonly ScriptKind[] = ["preWorktreeDelete"];

export type ScriptDefinition = {
  /** Short name shown as the field's heading. */
  label: string;
  /** When it runs and where; shown under the heading. */
  description: string;
  /** What the command box shows while empty; an example, never applied. */
  placeholder: string;
  /** What the abort-on-failure toggle means for this action, in each position. */
  onFailure: { abort: string; carryOn: string };
};

export const scriptDefinitions: Record<ScriptKind, ScriptDefinition> = {
  preWorktreeDelete: {
    label: "Before deleting a worktree",
    description:
      "Runs in the project's folder right before Portal removes its worktree, with your login shell and environment. "
      + "PORTAL_WORKTREE_PATH, PORTAL_REPO_ROOT, and PORTAL_BRANCH name what is about to be deleted.",
    placeholder: "e.g. make clean",
    onFailure: { abort: "Stop and keep the worktree", carryOn: "Carry on and delete anyway" },
  },
};

/** One script's settings. A blank command means the script is off. */
export type ScriptSettings = {
  command: string;
  /** Stop the action when the script exits non-zero or times out; otherwise log and carry on. */
  abortOnFailure: boolean;
  /** How long the script may run, in seconds. */
  timeoutSeconds: number;
};

export type ScriptsSettings = Record<ScriptKind, ScriptSettings>;

/** Partial overrides for one script, as sent in PATCH and stored on disk. */
export type ScriptSettingsPatch = Partial<ScriptSettings>;
export type ScriptsPatch = Partial<Record<ScriptKind, ScriptSettingsPatch>>;

export const scriptLimits = {
  /** Longest command, after trimming. */
  commandLength: 4000,
  /** Longest timeout: an hour. */
  timeoutSeconds: 3600,
} as const;

export const scriptFields = ["command", "abortOnFailure", "timeoutSeconds"] as const satisfies readonly (keyof ScriptSettings)[];

export const defaultScriptSettings: ScriptSettings = {
  command: "",
  abortOnFailure: true,
  timeoutSeconds: 300,
};

export const defaultScripts: ScriptsSettings = Object.fromEntries(
  scriptKinds.map((kind) => [kind, { ...defaultScriptSettings }]),
) as ScriptsSettings;

export function isScriptKind(value: unknown): value is ScriptKind {
  return typeof value === "string" && (scriptKinds as readonly string[]).includes(value);
}

/** True when the script has a command to run. */
export function isScriptEnabled(settings: ScriptSettings): boolean {
  return settings.command.trim().length > 0;
}

/**
 * `base` with `given` laid on top, field by field: a well-typed value replaces the base one and
 * anything else leaves it. The command is the one field where blank is meaningful (off), so a
 * string of any content is taken, trimmed.
 */
export function mergeScript(base: ScriptSettings, given: ScriptSettingsPatch | undefined): ScriptSettings {
  const next = { ...base };
  if (!given) return next;
  if (typeof given.command === "string") next.command = given.command.trim();
  if (typeof given.abortOnFailure === "boolean") next.abortOnFailure = given.abortOnFailure;
  if (Number.isInteger(given.timeoutSeconds) && (given.timeoutSeconds as number) >= 1 && (given.timeoutSeconds as number) <= scriptLimits.timeoutSeconds) {
    next.timeoutSeconds = given.timeoutSeconds as number;
  }
  return next;
}

/** Every script with `given` applied on top of `base`; scripts the patch does not mention are copied as they are. */
export function mergeScripts(base: ScriptsSettings, given: ScriptsPatch | undefined): ScriptsSettings {
  return Object.fromEntries(
    scriptKinds.map((kind) => [kind, mergeScript(base[kind], given?.[kind])]),
  ) as ScriptsSettings;
}

/** Only the fields of `scripts` that differ from the defaults, per script; undefined when nothing does. */
export function scriptsOverrides(scripts: ScriptsSettings): ScriptsPatch | undefined {
  const result: ScriptsPatch = {};
  for (const kind of scriptKinds) {
    const patch: ScriptSettingsPatch = {};
    const given = scripts[kind];
    for (const field of scriptFields) {
      if (given[field] !== defaultScriptSettings[field]) (patch as Record<string, unknown>)[field] = given[field];
    }
    if (Object.keys(patch).length > 0) result[kind] = patch;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
