import type { GitInfo } from "./git-info.ts";

export type ShellState = {
  id: string | null;
  status: "idle" | "running" | "exited";
  cwd: string;
  displayCwd: string;
  /** Repository and branch containing `cwd`, or null outside a git working tree. */
  git: GitInfo;
  shell: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  cwdError: string | null;
};

export type ShellEvent =
  | { type: "state"; state: ShellState }
  | { type: "snapshot"; state: ShellState; data: string }
  | { type: "output"; id: string; data: string }
  /** The terminal was deleted; the server disconnects viewers right after sending this. */
  | { type: "closed"; terminalId: string };

/** A terminal (one PTY) as served by the terminal REST routes; `sessionId` is null for standalone terminals. */
export type TerminalInfo = {
  id: string;
  sessionId: string | null;
  createdAt: number;
  state: ShellState;
};

export type ShellCommand =
  | { action: "start"; id: string | null }
  | { action: "input"; id: string; data: string }
  | { action: "resize"; id: string; cols: number; rows: number };
