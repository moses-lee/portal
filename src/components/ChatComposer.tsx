"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import CommandPalette, {
  commandInsertText,
  findCommandToken,
  matchCommands,
} from "./CommandPalette";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";

const noCommands: AvailableCommand[] = [];

export default function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  sending = false,
  stopping = false,
  disabled = false,
  commands = noCommands,
  placeholder = "What would you like to work on?",
  label = "Message",
  settings,
  context,
  error,
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy?: boolean;
  sending?: boolean;
  stopping?: boolean;
  disabled?: boolean;
  commands?: AvailableCommand[];
  placeholder?: string;
  label?: string;
  settings?: ReactNode;
  context?: ReactNode;
  error?: string | null;
  describedBy?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [paletteClosed, setPaletteClosed] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const token = useMemo(
    () => (commands.length ? findCommandToken(value, caret) : null),
    [commands, value, caret],
  );
  const matches = useMemo(
    () => (token ? matchCommands(commands, token.query) : []),
    [commands, token],
  );
  const paletteOpen = !!token && matches.length > 0 && !paletteClosed;
  const selected = Math.min(paletteIndex, Math.max(0, matches.length - 1));
  const insertCommand = (command: AvailableCommand) => {
    if (!token) return;
    const text = commandInsertText(command, token.trigger) + " ";
    pendingCaret.current = token.start + text.length;
    onChange(value.slice(0, token.start) + text + value.slice(token.end));
    setCaret(pendingCaret.current);
    setPaletteIndex(0);
    setPaletteClosed(true);
  };
  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${textarea.current.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    const position = pendingCaret.current;
    if (position === null) return;
    pendingCaret.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(position, position);
  }, [value]);
  const send = () => {
    if (!disabled && !busy && !sending && value.trim()) onSend();
  };
  return (
    <div>
      <div className="relative">
        {paletteOpen && token && (
          <CommandPalette
            id="command-palette"
            matches={matches}
            trigger={token.trigger}
            selected={selected}
            onSelect={insertCommand}
            onHighlight={setPaletteIndex}
          />
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <InputGroup className="composer glass !ring-0">
            <InputGroupTextarea
              ref={textarea}
              value={value}
              disabled={disabled}
              aria-label={label}
              aria-describedby={describedBy}
              placeholder={placeholder}
              rows={2}
              role={commands.length ? "combobox" : undefined}
              aria-autocomplete={commands.length ? "list" : undefined}
              aria-expanded={commands.length ? paletteOpen : undefined}
              aria-controls={paletteOpen ? "command-palette" : undefined}
              aria-activedescendant={
                paletteOpen ? `command-palette-${selected}` : undefined
              }
              onChange={(event) => {
                onChange(event.target.value);
                setCaret(event.target.selectionStart);
                setPaletteClosed(false);
                setPaletteIndex(0);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onBlur={() => setPaletteClosed(true)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (paletteOpen) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setPaletteIndex(
                      (selected +
                        (event.key === "ArrowDown" ? 1 : matches.length - 1)) %
                        matches.length,
                    );
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    insertCommand(matches[selected]);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setPaletteClosed(true);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <InputGroupAddon align="block-end">
              <div className="min-w-0 flex-1">
                {settings ?? (
                  <span className="pl-2 text-[11px] font-normal text-muted-foreground">
                    Enter to send{" "}
                    <span className="hidden sm:inline">
                      · Shift + Enter for a new line
                    </span>
                  </span>
                )}
              </div>
              {busy && onStop ? (
                <Button
                  type="button"
                  aria-label={stopping ? "Stopping agent" : "Stop agent"}
                  title="Stop agent"
                  disabled={stopping}
                  onClick={onStop}
                  className="composer-send !p-0"
                >
                  {stopping ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Square className="size-3.5 fill-current" />
                  )}
                </Button>
              ) : (
                <Button
                  type="submit"
                  aria-label={sending ? "Sending message" : "Send message"}
                  title="Send message"
                  disabled={disabled || sending || !value.trim()}
                  className="composer-send !p-0"
                >
                  {sending ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
      {error && (
        <p
          role="alert"
          className="px-3 pt-2 text-xs leading-relaxed text-destructive"
        >
          {error}
        </p>
      )}
      {context}
    </div>
  );
}
