"use client";

import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import ResponsiveDialog from "./ResponsiveDialog";
import { isGrouped, orderConfigOptions } from "@/lib/session-config";
import type { SessionState, SetConfigRequest } from "@/lib/types";

function ConfigControl({
  option,
  disabled,
  onChange,
}: {
  option: SessionConfigOption;
  disabled: boolean;
  onChange: (request: SetConfigRequest) => void;
}) {
  const id = `config-${option.id}`;
  return (
    <div className="space-y-2.5 border-b border-white/5 pb-5 last:border-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium">
          {option.name}
        </label>
        {option.type === "boolean" && (
          <Switch
            id={id}
            checked={option.currentValue}
            disabled={disabled}
            onCheckedChange={(value) =>
              onChange({ configId: option.id, value })
            }
          />
        )}
      </div>
      {option.description && (
        <p
          id={`${id}-description`}
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {option.description}
        </p>
      )}
      {option.type === "select" && (
        <Select
          value={option.currentValue}
          disabled={disabled}
          onValueChange={(value) => onChange({ configId: option.id, value })}
        >
          <SelectTrigger
            id={id}
            aria-describedby={
              option.description ? `${id}-description` : undefined
            }
            className="!h-10 w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {isGrouped(option.options)
              ? option.options.map((group) => (
                  <SelectGroup key={group.group}>
                    <SelectLabel>{group.name}</SelectLabel>
                    {group.options.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))
              : option.options.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.name}
                  </SelectItem>
                ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export default function SessionControls({
  state,
  disabled,
  error,
  onChange,
}: {
  state: SessionState;
  disabled: boolean;
  error?: string | null;
  onChange: (request: SetConfigRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = orderConfigOptions(state.configOptions);
  const modes = state.modes;
  const showModes =
    !!modes?.availableModes.length &&
    !options.some((option) => option.category === "mode");
  const summaries = options
    .filter((option) =>
      ["model", "mode", "thought_level"].includes(option.category ?? ""),
    )
    .flatMap((option) => {
      if (option.type !== "select") return [];
      const choices = isGrouped(option.options)
        ? option.options.flatMap((group) => group.options)
        : option.options;
      return (
        choices.find((choice) => choice.value === option.currentValue)?.name ??
        option.currentValue
      );
    });
  if (options.length === 0 && !showModes) return null;
  const summary = summaries.join(" · ") || "Agent settings";
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={setOpen}
      title="Agent settings"
      description="Settings for this conversation. Changes apply to your next message."
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Agent settings"
          title={summary}
          className="h-8 max-w-[min(280px,65vw)] gap-2 rounded-full px-2 text-xs text-muted-foreground"
        >
          <SlidersHorizontal className="size-3.5" />
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3" />
          {error && <span className="size-1.5 rounded-full bg-destructive" />}
        </Button>
      }
    >
      <div className="space-y-5">
        {disabled && (
          <p
            role="status"
            className="rounded-xl bg-white/5 p-3 text-xs text-muted-foreground"
          >
            Settings are available when the current operation finishes.
          </p>
        )}
        {showModes && modes && (
          <div className="space-y-2.5">
            <label
              htmlFor="config-session-mode"
              className="text-sm font-medium"
            >
              Mode
            </label>
            <Select
              value={modes.currentModeId}
              disabled={disabled}
              onValueChange={(modeId) => onChange({ modeId })}
            >
              <SelectTrigger id="config-session-mode" className="!h-10 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modes.availableModes.map((mode) => (
                  <SelectItem key={mode.id} value={mode.id}>
                    {mode.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {options.map((option) => (
          <ConfigControl
            key={option.id}
            option={option}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => setOpen(false)}
        >
          Done
        </Button>
      </div>
    </ResponsiveDialog>
  );
}
