import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { SessionState, SetConfigRequest } from "./types.ts";

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
