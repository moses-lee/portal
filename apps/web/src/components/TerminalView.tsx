"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { mountShell, type ShellViewState } from "@/lib/shell-client";
import "@xterm/xterm/css/xterm.css";

export type TerminalViewHandle = {
  /** Start a new shell in this terminal (after `exit` or a failed start). */
  start: () => void;
  /** Send raw input (the mobile key row) and focus the terminal. */
  input: (data: string) => void;
};

export type TerminalViewProps = {
  terminalId: string;
  /** Only the active tab is visible; inactive tabs stay mounted so scrollback and selection survive. */
  active: boolean;
  onChange: (view: ShellViewState) => void;
  ref?: Ref<TerminalViewHandle>;
};

/**
 * Keyboard users move between tabs with the arrow keys, which lands focus on a tab button
 * with a visible focus ring. The shell must not take focus then, or the next arrow key
 * would go to the shell instead of the strip. Mouse clicks leave no ring, so they still
 * focus the shell.
 */
function keyboardFocusOnTab() {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && focused.getAttribute("role") === "tab" && focused.matches(":focus-visible");
}

/** One terminal tab: mounts a shell client for `terminalId` and keeps it for the tab's lifetime. */
export default function TerminalView({ terminalId, active, onChange, ref }: TerminalViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const client = useRef<ReturnType<typeof mountShell> | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const connection = mountShell(
      container.current!,
      { terminalId, canFocus: () => !keyboardFocusOnTab() },
      (view) => onChangeRef.current(view),
    );
    client.current = connection;
    return () => {
      client.current = null;
      connection.dispose();
    };
  }, [terminalId]);

  // A tab shown again after being hidden has stale cell measurements until it is refit.
  useEffect(() => {
    if (active) client.current?.refresh();
  }, [active]);

  useImperativeHandle(ref, () => ({
    start: () => void client.current?.start(),
    input: (data: string) => client.current?.input(data),
  }), []);

  return (
    <div
      role="tabpanel"
      id={`terminal-tabpanel-${terminalId}`}
      aria-labelledby={`terminal-tab-${terminalId}`}
      hidden={!active}
      className="h-full min-h-0 overflow-auto"
    >
      <div ref={container} className="h-full min-h-0" />
    </div>
  );
}
