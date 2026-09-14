import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import xterm from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { readShellCwd } from "./shell-cwd.ts";
import type { ShellEvent, ShellState } from "./shell-types.ts";

const SCROLLBACK = 2000;

export function createShellRuntime({
  cwd = process.cwd(),
  shell = process.env.SHELL || "/bin/sh",
  args = ["-l"],
  env = process.env,
  pollIntervalMs = 750,
} = {}) {
  const listeners = new Set<(event: ShellEvent) => void>();
  let proc: pty.IPty | null = null;
  let terminal: InstanceType<typeof xterm.Terminal> | null = null;
  let serializer: InstanceType<typeof serialize.SerializeAddon> | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let checkingCwd: Promise<void> | null = null;
  let disposed = false;
  let state: ShellState = {
    id: null, status: "idle", cwd, displayCwd: displayPath(cwd),
    shell: path.basename(shell), cols: 80, rows: 24, exitCode: null, cwdError: null,
  };

  function displayPath(directory: string) {
    const home = os.homedir();
    return directory === home ? "~" : directory.startsWith(home + path.sep)
      ? "~" + directory.slice(home.length) : directory;
  }

  function emit(event: ShellEvent) {
    for (const listener of listeners) listener(event);
  }

  function publish() { emit({ type: "state", state: { ...state } }); }

  function refreshCwd(): Promise<void> {
    if (!proc) return Promise.resolve();
    if (checkingCwd) return checkingCwd;
    const current = proc;
    checkingCwd = readShellCwd(current.pid).then((directory) => {
      if (proc !== current) return;
      if (directory !== state.cwd || state.cwdError) {
        state = { ...state, cwd: directory, displayCwd: displayPath(directory), cwdError: null };
        publish();
      }
    }).catch(() => {
      if (proc !== current || state.cwdError) return;
      state = { ...state, cwdError: "Could not read the shell directory. New sessions are paused until it is available." };
      publish();
    }).finally(() => { checkingCwd = null; });
    return checkingCwd;
  }

  function start(expectedId: string | null) {
    if (disposed) throw new Error("Shell runtime is stopped.");
    // Multiple tabs opening/restarting at once must never replace a live shell.
    if (state.status === "running" || expectedId !== state.id) return getState();
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("The shared shell currently supports macOS and Linux hosts.");
    }
    const current = pty.spawn(shell, args, {
      name: "xterm-256color", cols: state.cols, rows: state.rows, cwd: state.cwd,
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    terminal?.dispose();
    const screen = new xterm.Terminal({
      cols: state.cols, rows: state.rows, scrollback: SCROLLBACK, allowProposedApi: true,
    });
    serializer = new serialize.SerializeAddon();
    screen.loadAddon(serializer);
    terminal = screen;
    proc = current;
    const id = randomUUID();
    state = { ...state, id, status: "running", exitCode: null, cwdError: null };
    let pendingBytes = 0;
    // One emulator answers terminal queries, even with zero or several viewers.
    screen.onData((data) => { if (proc === current) current.write(data); });
    current.onData((data) => {
      pendingBytes += data.length;
      if (pendingBytes > 128 * 1024) current.pause();
      screen.write(data, () => {
        if (terminal !== screen || disposed) return;
        emit({ type: "output", id, data });
        pendingBytes -= data.length;
        if (pendingBytes < 32 * 1024 && proc === current) current.resume();
      });
    });
    current.onExit(({ exitCode }) => {
      if (proc !== current) return;
      proc = null;
      clearInterval(poll);
      // Drain final output before marking the shell exited or allowing a restart.
      screen.write("", () => {
        if (terminal !== screen || disposed) return;
        state = { ...state, status: "exited", exitCode };
        publish();
      });
    });
    poll = setInterval(() => { void refreshCwd(); }, pollIntervalMs);
    poll.unref();
    emit({ type: "snapshot", state: getState(), data: "" });
    void refreshCwd();
    return getState();
  }

  function activeProcess(id: string) {
    if (!proc || state.id !== id || state.status !== "running") {
      throw new Error("This shell is no longer running. Reconnect or start a new shell.");
    }
    return proc;
  }

  function write(id: string, data: string) {
    activeProcess(id).write(data);
  }

  function resize(id: string, cols: number, rows: number) {
    const current = activeProcess(id);
    if (cols === state.cols && rows === state.rows) return;
    // Queue behind pending writes so every viewer observes the same ordering.
    terminal!.write("", () => {
      if (proc !== current) return;
      terminal!.resize(cols, rows);
      current.resize(cols, rows);
      state = { ...state, cols, rows };
      publish();
    });
  }

  function getState(): ShellState { return { ...state }; }

  async function workingDirectory() {
    await refreshCwd();
    if (state.cwdError) throw new Error(state.cwdError);
    return state.cwd;
  }

  function subscribe(listener: (event: ShellEvent) => void, output = false) {
    // Parsing/output publication share the event loop: snapshot then tail has no gap.
    listener(output
      ? { type: "snapshot", state: getState(), data: serializer?.serialize() ?? "" }
      : { type: "state", state: getState() });
    const filtered = (event: ShellEvent) => {
      if (output || event.type === "state") listener(event);
      else if (event.type === "snapshot") listener({ type: "state", state: event.state });
    };
    listeners.add(filtered);
    return () => { listeners.delete(filtered); };
  }

  function dispose() {
    disposed = true;
    clearInterval(poll);
    const current = proc;
    proc = null;
    current?.kill();
    terminal?.dispose();
    terminal = null;
    listeners.clear();
  }

  return { start, write, resize, getState, workingDirectory, subscribe, dispose };
}
