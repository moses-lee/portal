"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, LoaderCircle, Square, X } from "lucide-react";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import CommandPalette, {
  commandInsertText,
  findCommandToken,
  matchCommands,
} from "./CommandPalette";
import IconButton from "./IconButton";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { atHistoryEdge, readPromptHistory } from "@/lib/prompt-history";
import { useMediaQuery } from "./useMediaQuery";

const noCommands: AvailableCommand[] = [];

export default function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  queues = false,
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
  historyKey,
  paletteId = "command-palette",
  editing,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy?: boolean;
  /**
   * The text is a queued prompt being edited in place (agent sessions): a line above the textarea
   * says which, with a button to cancel, and Enter or the arrow calls `onSend` to save it (even
   * while `busy`); what the send does is the parent's call.
   */
  editing?: { label: string; onCancel: () => void };
  /**
   * The conversation queues prompts sent while `busy` (agent sessions): the send button stays,
   * beside Stop, and Enter sends as usual. Without it, Stop replaces the send button while busy.
   */
  queues?: boolean;
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
  /** Recall this conversation's earlier prompts with Up/Down (see `@/lib/prompt-history`). */
  historyKey?: string;
  /** The command palette's element id; two composers on one page (a Portal thread and the tracked panel) need different ones. */
  paletteId?: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  // A touch keyboard's return key has no Shift to hold, so there it types a new line and only the button sends.
  const touch = useMediaQuery("(pointer: coarse)");
  const [caret, setCaret] = useState(0);
  const [paletteClosed, setPaletteClosed] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  /**
   * Where Up/Down browsing stands: the entry shown and the draft to restore past the newest one.
   * `shown` detects any other change to the text (typing, a send clearing it), which ends browsing.
   */
  const browsing = useRef<{ index: number; shown: string; draft: string } | null>(
    null,
  );
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
  const replaceText = (text: string) => {
    if (text === value) {
      textarea.current?.setSelectionRange(text.length, text.length);
      return;
    }
    pendingCaret.current = text.length;
    onChange(text);
    setCaret(text.length);
  };
  /** Show the previous (Up) or next (Down) prompt; false when there is nothing to move to. */
  const browseHistory = (direction: "up" | "down") => {
    if (!historyKey) return false;
    const entries = readPromptHistory(historyKey);
    let state = browsing.current;
    if (state && (state.shown !== value || state.index >= entries.length))
      state = browsing.current = null;
    if (direction === "up") {
      if (state?.index === 0 || !entries.length) return false;
      const index = state ? state.index - 1 : entries.length - 1;
      browsing.current = { index, shown: entries[index], draft: state?.draft ?? value };
      replaceText(entries[index]);
      return true;
    }
    if (!state) return false;
    if (state.index < entries.length - 1) {
      const index = state.index + 1;
      browsing.current = { ...state, index, shown: entries[index] };
      replaceText(entries[index]);
    } else {
      browsing.current = null;
      replaceText(state.draft);
    }
    return true;
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
  // With a queue, a send while the agent works queues the text; without one (a Portal thread) it
  // waits. Saving an edited queued prompt does not start a turn, so it goes through while busy too.
  const send = () => {
    if (!disabled && !sending && (queues || !!editing || !busy) && value.trim()) onSend();
  };
  const sendLabel = editing ? "Save queued prompt" : busy && queues ? "Queue message" : "Send message";
  // The edit line describes the textarea too, so assistive tech hears that Enter now saves a queued prompt.
  const editLineId = `${paletteId}-editing`;
  const describedByIds = [describedBy, editing ? editLineId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <div className="relative">
        {paletteOpen && token && (
          <CommandPalette
            id={paletteId}
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
            {editing && (
              <InputGroupAddon
                align="block-start"
                className="!justify-between gap-2 pb-0 text-[11px] font-normal text-muted-foreground"
              >
                <span id={editLineId} className="min-w-0 truncate pl-2">
                  {editing.label}. Enter saves it in place.
                </span>
                <IconButton
                  label="Cancel edit"
                  className="size-6 flex-none text-muted-foreground"
                  onClick={editing.onCancel}
                >
                  <X className="size-3.5" />
                </IconButton>
              </InputGroupAddon>
            )}
            <InputGroupTextarea
              ref={textarea}
              value={value}
              disabled={disabled}
              aria-label={label}
              aria-describedby={describedByIds}
              placeholder={placeholder}
              rows={2}
              enterKeyHint={touch ? "enter" : "send"}
              role={commands.length ? "combobox" : undefined}
              aria-autocomplete={commands.length ? "list" : undefined}
              aria-expanded={commands.length ? paletteOpen : undefined}
              aria-controls={paletteOpen ? paletteId : undefined}
              aria-activedescendant={
                paletteOpen ? `${paletteId}-${selected}` : undefined
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
                if (
                  (event.key === "ArrowUp" || event.key === "ArrowDown") &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  atHistoryEdge(
                    value,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                    event.key === "ArrowUp" ? "up" : "down",
                  ) &&
                  browseHistory(event.key === "ArrowUp" ? "up" : "down")
                ) {
                  event.preventDefault();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !touch) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <InputGroupAddon align="block-end">
              <div className="min-w-0 flex-1">
                {settings ??
                  (!touch && (
                    <span className="pl-2 text-[11px] font-normal text-muted-foreground">
                      {editing ? "Enter to save" : busy && queues ? "Enter to queue" : "Enter to send"}{" "}
                      <span className="hidden sm:inline">
                        · Shift + Enter for a new line
                      </span>
                    </span>
                  ))}
              </div>
              {busy && onStop && (
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
              )}
              {(!busy || !onStop || queues || editing) && (
                <Button
                  type="submit"
                  aria-label={sending ? "Sending message" : sendLabel}
                  title={sendLabel}
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
