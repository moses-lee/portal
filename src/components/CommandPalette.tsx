"use client";

import type { AvailableCommand } from "@agentclientprotocol/sdk";

export type CommandTrigger = "/" | "$";

/** The `/name` or `$name` token under the caret, if the caret sits inside one. */
export type CommandToken = { start: number; end: number; trigger: CommandTrigger; query: string };

export const MAX_MATCHES = 10;

function isTrigger(ch: string): ch is CommandTrigger {
  return ch === "/" || ch === "$";
}

/**
 * Locate the whitespace-delimited token containing the caret when it starts with `/` or `$`.
 * The caret must be after the trigger character, so typing the trigger alone opens the palette
 * and moving the caret in front of it closes it.
 */
export function findCommandToken(text: string, caret: number): CommandToken | null {
  if (caret < 1 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const trigger = text[start];
  if (!isTrigger(trigger) || caret <= start) return null;
  return { start, end, trigger, query: text.slice(start + 1, end) };
}

function bareName(command: AvailableCommand) {
  return isTrigger(command.name[0] ?? "") ? command.name.slice(1) : command.name;
}

/** Commands whose name starts with the query first, then those merely containing it. */
export function matchCommands(commands: AvailableCommand[], query: string, limit = MAX_MATCHES) {
  const q = query.toLowerCase();
  const prefix: AvailableCommand[] = [];
  const partial: AvailableCommand[] = [];
  for (const command of commands) {
    const name = bareName(command).toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) partial.push(command);
  }
  return [...prefix, ...partial].slice(0, limit);
}

/** Text to put in the message box for a command: names that carry their own sigil are used verbatim. */
export function commandInsertText(command: AvailableCommand, trigger: CommandTrigger) {
  return isTrigger(command.name[0] ?? "") ? command.name : trigger + command.name;
}

export default function CommandPalette({ id, matches, trigger, selected, onSelect, onHighlight }: {
  id: string;
  matches: AvailableCommand[];
  trigger: CommandTrigger;
  selected: number;
  onSelect: (command: AvailableCommand) => void;
  onHighlight: (index: number) => void;
}) {
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Commands"
      className="absolute bottom-full left-3 right-3 z-30 mb-1 max-h-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
    >
      {matches.map((command, i) => (
        <li
          key={command.name}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === selected}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHighlight(i)}
          onClick={() => onSelect(command)}
          className={`flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-1.5 ${i === selected ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"}`}
        >
          <span className="font-mono text-zinc-100">{commandInsertText(command, trigger)}</span>
          {command.input?.hint && <span className="font-mono text-zinc-500">{command.input.hint}</span>}
          {command.description && <span className="min-w-0 basis-full truncate text-zinc-500 sm:basis-auto sm:flex-1">{command.description}</span>}
        </li>
      ))}
    </ul>
  );
}
