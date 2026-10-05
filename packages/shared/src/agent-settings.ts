/**
 * An agent's session settings (ACP config options and legacy modes) as Portal moves them around:
 * diffing a session towards wanted values one request at a time, and the last settings the user
 * picked per agent, which the start page and the orchestrator's new sessions start from. Pure, so
 * the server and the web app share it and the node test runner can load it.
 */
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { SessionListState, SetConfigRequest } from "@portal/contracts/types";

const categoryRank: Record<string, number> = {
  mode: 0,
  model: 1,
  thought_level: 2,
  model_config: 3,
};

function rank(option: SessionConfigOption) {
  return categoryRank[option.category ?? ""] ?? 4;
}

/** Config options ordered mode, model, thought level, model config, then the rest as given. */
export function orderConfigOptions(options: SessionConfigOption[]) {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
    .map(({ option }) => option);
}

export function isGrouped(
  options: SessionConfigSelectOption[] | SessionConfigSelectGroup[],
): options is SessionConfigSelectGroup[] {
  return options.length > 0 && "group" in options[0];
}

function selectValues(option: Extract<SessionConfigOption, { type: "select" }>): string[] {
  const choices = isGrouped(option.options) ? option.options.flatMap((group) => group.options) : option.options;
  return choices.map((choice) => choice.value);
}

/** True when `state` carries anything a settings control could show. */
export function hasSettings(state: SessionListState): boolean {
  return state.configOptions.length > 0 || !!state.modes?.availableModes.length;
}

/**
 * The single next request that moves `actual` towards `desired`, or null when they agree. Options
 * are compared in display order (mode, model, thought level, …) so a model switch, which can change
 * the choices of later options, is applied before them; the caller re-diffs against the agent's
 * answer. Values `actual` no longer offers are skipped rather than rejected by the agent.
 */
export function nextConfigChange(desired: SessionListState, actual: SessionListState): SetConfigRequest | null {
  for (const want of orderConfigOptions(desired.configOptions)) {
    const have = actual.configOptions.find((option) => option.id === want.id);
    if (!have || have.type !== want.type || have.currentValue === want.currentValue) continue;
    if (want.type === "select" && have.type === "select") {
      if (selectValues(have).includes(want.currentValue)) return { configId: want.id, value: want.currentValue };
    } else if (want.type === "boolean") {
      return { configId: want.id, value: want.currentValue };
    }
  }
  const modeAsOption = actual.configOptions.some((option) => option.category === "mode");
  const modeId = desired.modes?.currentModeId;
  if (
    !modeAsOption && modeId && actual.modes && actual.modes.currentModeId !== modeId
    && actual.modes.availableModes.some((mode) => mode.id === modeId)
  ) {
    return { modeId };
  }
  return null;
}

/** Apply a change locally before the agent confirms it. */
export function applyConfigChange<S extends SessionListState>(
  state: S,
  request: SetConfigRequest,
): S {
  if ("modeId" in request) {
    return state.modes
      ? { ...state, modes: { ...state.modes, currentModeId: request.modeId } }
      : state;
  }
  return {
    ...state,
    configOptions: state.configOptions.map((option) => {
      if (option.id !== request.configId) return option;
      if (option.type === "select" && typeof request.value === "string")
        return { ...option, currentValue: request.value };
      if (option.type === "boolean" && typeof request.value === "boolean")
        return { ...option, currentValue: request.value };
      return option;
    }),
  };
}

/** The most requests one start applies; each fixes one option, so this is far more than any agent has. */
export const MAX_CONFIG_STEPS = 16;

/** Just the settings of a session's state: no slash commands, which `SessionState` also carries. */
export function settingsOf(state: SessionListState): SessionListState {
  return { modes: state.modes ?? null, configOptions: state.configOptions };
}

/**
 * `base` (its option lists, and its values where `desired` says nothing usable) with `desired`'s
 * values wherever `base` offers them, computed locally with the same diff a session start uses.
 * `except` names one setting to leave as `base` has it: the mode (as a config option or legacy
 * mode, which mirror each other) or one config option.
 */
export function overlaySettings(desired: SessionListState, base: SessionListState, except?: SetConfigRequest): SessionListState {
  let want = settingsOf(desired);
  if (except) {
    const excepted = "modeId" in except ? undefined : desired.configOptions.find((option) => option.id === except.configId);
    const isMode = "modeId" in except || excepted?.category === "mode";
    want = {
      modes: isMode ? null : want.modes,
      configOptions: want.configOptions.filter((option) =>
        isMode ? option.category !== "mode" && option !== excepted : option !== excepted),
    };
  }
  let state = settingsOf(base);
  for (let step = 0; step < want.configOptions.length + 1; step++) {
    const request = nextConfigChange(want, state);
    if (!request) break;
    state = applyConfigChange(state, request);
  }
  // A mode config option and the legacy modes mirror each other (the runtime keeps them in step too).
  const modeOption = state.configOptions.find((option) => option.category === "mode" && option.type === "select");
  const modeId = modeOption?.currentValue;
  if (state.modes && typeof modeId === "string" && state.modes.currentModeId !== modeId
    && state.modes.availableModes.some((mode) => mode.id === modeId)) {
    state = { ...state, modes: { ...state.modes, currentModeId: modeId } };
  }
  return state;
}

/**
 * Where the user's last settings for an agent go after they changed one setting in a session:
 * the session's new state, with the other settings as the user last left them (an agent may have
 * moved those on its own, which is not the user's choice). Without a record yet, the session's.
 */
export function recordUserChange(stored: SessionListState | null, result: SessionListState, request: SetConfigRequest): SessionListState {
  return stored ? overlaySettings(stored, result, request) : settingsOf(result);
}

/** The agent the user last started a session with (or picked on the start page), and each agent's last settings. */
export type LastUsedAgents = {
  agentId: string | null;
  /** By agent id: the settings as the user last left them, with the option lists they were chosen from. */
  settings: Record<string, SessionListState>;
};

/** Body of `PATCH /api/last-used`: a new agent pick, and/or whole settings records that replace those agents'. */
export type LastUsedPatch = {
  agentId?: string;
  settings?: Record<string, SessionListState>;
};

export const emptyLastUsed: LastUsedAgents = { agentId: null, settings: {} };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The most options or choices one record keeps; agents expose a handful, model lists a few dozen. */
const MAX_ITEMS = 500;

function isChoice(value: unknown): boolean {
  return isRecord(value) && typeof value.value === "string" && typeof value.name === "string";
}

function isChoices(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return false;
  if (value.length > 0 && isRecord(value[0]) && "group" in value[0]) {
    return value.every((group) => isRecord(group) && typeof group.group === "string"
      && Array.isArray(group.options) && group.options.length <= MAX_ITEMS && group.options.every(isChoice));
  }
  return value.every(isChoice);
}

function isConfigOption(value: unknown): value is SessionConfigOption {
  if (!isRecord(value) || !isText(value.id) || typeof value.name !== "string") return false;
  if (value.type === "select") return typeof value.currentValue === "string" && isChoices(value.options);
  if (value.type === "boolean") return typeof value.currentValue === "boolean";
  return false;
}

/**
 * A settings record as stored or sent, or null when it is not one. Options of a kind Portal cannot
 * apply (neither select nor boolean) are dropped rather than failing the record.
 */
export function parseSettingsRecord(value: unknown): SessionListState | null {
  if (!isRecord(value) || !Array.isArray(value.configOptions) || value.configOptions.length > MAX_ITEMS) return null;
  let modes: SessionListState["modes"] = null;
  if (value.modes !== null && value.modes !== undefined) {
    const raw = value.modes;
    if (!isRecord(raw) || typeof raw.currentModeId !== "string" || !Array.isArray(raw.availableModes)
      || raw.availableModes.length > MAX_ITEMS
      || !raw.availableModes.every((mode) => isRecord(mode) && isText(mode.id) && typeof mode.name === "string")) {
      return null;
    }
    modes = raw as unknown as NonNullable<SessionListState["modes"]>;
  }
  return { modes, configOptions: value.configOptions.filter(isConfigOption) };
}

/** The stored record, leniently: anything malformed reads as missing rather than failing the read. */
export function parseLastUsed(value: unknown): LastUsedAgents {
  if (!isRecord(value)) return { agentId: null, settings: {} };
  const settings: Record<string, SessionListState> = {};
  if (isRecord(value.settings)) {
    for (const [agentId, record] of Object.entries(value.settings)) {
      const parsed = parseSettingsRecord(record);
      if (parsed) settings[agentId] = parsed;
    }
  }
  return { agentId: isText(value.agentId) ? value.agentId : null, settings };
}
