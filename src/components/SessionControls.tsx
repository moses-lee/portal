"use client";

import type { SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { SessionState, SetConfigRequest } from "@/lib/types";

const categoryRank: Record<string, number> = { mode: 0, model: 1, thought_level: 2, model_config: 3 };

function rank(option: SessionConfigOption) {
  return categoryRank[option.category ?? ""] ?? 4;
}

/** Config options ordered mode, model, thought level, model config, then the rest as given. */
export function orderConfigOptions(options: SessionConfigOption[]) {
  return options.map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
    .map(({ option }) => option);
}

function isGrouped(options: SessionConfigSelectOption[] | SessionConfigSelectGroup[]): options is SessionConfigSelectGroup[] {
  return options.length > 0 && "group" in options[0];
}

/** Apply a change locally before the agent confirms it. */
export function applyConfigChange(state: SessionState, request: SetConfigRequest): SessionState {
  if ("modeId" in request) {
    return state.modes ? { ...state, modes: { ...state.modes, currentModeId: request.modeId } } : state;
  }
  return {
    ...state,
    configOptions: state.configOptions.map((option) => {
      if (option.id !== request.configId) return option;
      if (option.type === "select" && typeof request.value === "string") return { ...option, currentValue: request.value };
      if (option.type === "boolean" && typeof request.value === "boolean") return { ...option, currentValue: request.value };
      return option;
    }),
  };
}

const selectClass = "max-w-48 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-200 outline-none focus:border-indigo-500 disabled:opacity-50";

function ConfigControl({ option, disabled, onChange }: {
  option: SessionConfigOption;
  disabled: boolean;
  onChange: (request: SetConfigRequest) => void;
}) {
  const id = `config-${option.id}`;
  if (option.type === "boolean") {
    return (
      <label htmlFor={id} title={option.description ?? undefined} className="inline-flex items-center gap-1">
        <input
          id={id}
          type="checkbox"
          checked={option.currentValue}
          disabled={disabled}
          onChange={(e) => onChange({ configId: option.id, value: e.target.checked })}
          className="accent-indigo-500 disabled:opacity-50"
        />
        <span>{option.name}</span>
      </label>
    );
  }
  return (
    <label htmlFor={id} title={option.description ?? undefined} className="inline-flex items-center gap-1">
      <span>{option.name}</span>
      <select
        id={id}
        value={option.currentValue}
        disabled={disabled}
        onChange={(e) => onChange({ configId: option.id, value: e.target.value })}
        className={selectClass}
      >
        {isGrouped(option.options)
          ? option.options.map((group) => (
              <optgroup key={group.group} label={group.name}>
                {group.options.map((o) => <option key={o.value} value={o.value} title={o.description ?? undefined}>{o.name}</option>)}
              </optgroup>
            ))
          : option.options.map((o) => <option key={o.value} value={o.value} title={o.description ?? undefined}>{o.name}</option>)}
      </select>
    </label>
  );
}

/**
 * The agent's current settings (mode, model, effort, …) as editable controls. Because the controls
 * show the live values, this row doubles as the session's status line.
 */
export default function SessionControls({ state, disabled, error, onChange }: {
  state: SessionState;
  disabled: boolean;
  error?: string | null;
  onChange: (request: SetConfigRequest) => void;
}) {
  const options = orderConfigOptions(state.configOptions);
  const modes = state.modes;
  const showModes = !!modes && modes.availableModes.length > 0 && !options.some((o) => o.category === "mode");
  if (options.length === 0 && !showModes) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-[11px] text-zinc-500">
      {showModes && (
        <label htmlFor="config-session-mode" className="inline-flex items-center gap-1">
          <span>Mode</span>
          <select
            id="config-session-mode"
            value={modes.currentModeId}
            disabled={disabled}
            onChange={(e) => onChange({ modeId: e.target.value })}
            className={selectClass}
          >
            {modes.availableModes.map((m) => <option key={m.id} value={m.id} title={m.description ?? undefined}>{m.name}</option>)}
          </select>
        </label>
      )}
      {options.map((option) => <ConfigControl key={option.id} option={option} disabled={disabled} onChange={onChange} />)}
      {error && <span role="alert" className="basis-full text-red-300">{error}</span>}
    </div>
  );
}
