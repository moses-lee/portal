/** The GitHub panel's one-click actions on a pull request; each sends a prompt to the agent. */
export type GitActionKind = "checks" | "conflicts" | "review";
export type GitActionPrompts = Record<GitActionKind, string>;

export type Settings = { version: 1; gitActions: { prompts: GitActionPrompts } };

/** Partial overrides, as stored on disk and as sent in PATCH. */
export type SettingsPatch = { gitActions?: { prompts?: Partial<Record<GitActionKind, string>> } };

export const gitActionKinds: readonly GitActionKind[] = ["checks", "conflicts", "review"];

export const defaultSettings: Settings = {
  version: 1,
  gitActions: {
    prompts: {
      checks: "Investigate the failing actions on this PR. Debug why they are failing. Do not fix it yet.",
      conflicts: "This branch has merge conflicts with base. Investigate why. Do not fix it yet.",
      review: "Pull the comments and review items on this PR. Summarize what they are and if they are legitimate.",
    },
  },
};

/** Defaults with `overrides` applied; empty or whitespace-only prompt strings mean "use the default". */
export function mergeSettings(overrides: SettingsPatch | null | undefined): Settings {
  const prompts = { ...defaultSettings.gitActions.prompts };
  const given = overrides?.gitActions?.prompts;
  if (given) {
    for (const kind of gitActionKinds) {
      const value = given[kind];
      if (typeof value === "string" && value.trim()) prompts[kind] = value;
    }
  }
  return { version: 1, gitActions: { prompts } };
}

/** Only the fields of `settings` that differ from the defaults: what gets written to disk. Returns {} when nothing differs. */
export function settingsOverrides(settings: Settings): SettingsPatch {
  const prompts: Partial<Record<GitActionKind, string>> = {};
  let any = false;
  for (const kind of gitActionKinds) {
    const value = settings.gitActions.prompts[kind];
    if (value !== defaultSettings.gitActions.prompts[kind]) {
      prompts[kind] = value;
      any = true;
    }
  }
  return any ? { gitActions: { prompts } } : {};
}

/** `settings` with `patch` laid on top; a blank prompt in the patch resets that prompt to its default. */
export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  return mergeSettings({ gitActions: { prompts: { ...settings.gitActions.prompts, ...patch.gitActions?.prompts } } });
}
