import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { byRecentActivity } from "./session-groups.ts";
import type { SessionMeta, SessionState, SetConfigRequest } from "./types.ts";

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
export function hasSettings(state: SessionState): boolean {
  return state.configOptions.length > 0 || !!state.modes?.availableModes.length;
}

/**
 * The settings of the most recently active session with `agentId`, or null when no such session
 * exposes any. The start page seeds its controls from this: it is the agent's current option list
 * and the values the user last chose.
 */
export function latestStateForAgent(sessions: SessionMeta[], agentId: string): SessionState | null {
  return [...sessions]
    .sort(byRecentActivity)
    .find((session) => session.agentId === agentId && hasSettings(session.state))?.state ?? null;
}

/**
 * The single next request that moves `actual` towards `desired`, or null when they agree. Options
 * are compared in display order (mode, model, thought level, …) so a model switch, which can change
 * the choices of later options, is applied before them; the caller re-diffs against the agent's
 * answer. Values `actual` no longer offers are skipped rather than rejected by the agent.
 */
export function nextConfigChange(desired: SessionState, actual: SessionState): SetConfigRequest | null {
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
export function applyConfigChange(
  state: SessionState,
  request: SetConfigRequest,
): SessionState {
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
