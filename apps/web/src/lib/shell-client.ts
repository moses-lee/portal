import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { io } from "socket.io-client";
import type { ShellCommand, ShellEvent, ShellState } from "./shell-types";

export type ShellViewState = {
  shell: ShellState | null;
  connected: boolean;
  /** The terminal was deleted (here or by another viewer); the client will not reconnect. */
  closed: boolean;
  error: string | null;
};

export type ShellClient = ReturnType<typeof mountShell>;

const CLOSED_MESSAGE = "This terminal was closed.";

export type MountShellOptions = {
  terminalId: string;
  /** Asked before the client takes keyboard focus on its own (first connect, restart, refresh). */
  canFocus?: () => boolean;
};

/** Owns one terminal's I/O and cleanup; output bypasses React's render cycle. */
export function mountShell(element: HTMLDivElement, { terminalId, canFocus = () => true }: MountShellOptions, onChange: (state: ShellViewState) => void) {
  const terminal = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: "Menlo, Monaco, Consolas, monospace",
    scrollback: 2000, allowProposedApi: true, screenReaderMode: true,
    theme: { background: "#09090b", foreground: "#e4e4e7", cursor: "#a5b4fc", selectionBackground: "#3f3f46" },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  terminal.textarea?.setAttribute("aria-label", "Terminal");

  // The server's headless xterm answers queries once for the shared PTY.
  // Viewers still handle all keyboard, paste and mouse encoding through xterm.
  for (const identifier of [
    { final: "c" }, { prefix: ">", final: "c" },
    { final: "n" }, { prefix: "?", final: "n" },
    { intermediates: "$", final: "p" }, { prefix: "?", intermediates: "$", final: "p" },
  ]) terminal.parser.registerCsiHandler(identifier, () => true);
  terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true);
  terminal.parser.registerCsiHandler({ final: "t" }, (params) => Number(params[0]) >= 14 && Number(params[0]) <= 21);
  for (const code of [4, 10, 11, 12]) terminal.parser.registerOscHandler(code, (data) => data.includes("?"));

  let view: ShellViewState = { shell: null, connected: false, closed: false, error: null };
  let disposed = false;
  let started = false;
  let startPending = false;
  let queue: ShellCommand[] = [];
  let sending = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let rendering = Promise.resolve();
  // `forceNew`: socket.io-client shares one Manager per URL otherwise, and every tab would reuse the first tab's auth.
  const socket = io({ path: "/api/shell/socket", addTrailingSlash: false, transports: ["websocket"], forceNew: true, auth: { terminalId, output: true } });

  function focus() {
    if (!disposed && canFocus()) terminal.focus();
  }

  function update(patch: Partial<ShellViewState>) {
    if (disposed) return;
    view = { ...view, ...patch };
    terminal.options.disableStdin = !view.connected || view.shell?.status !== "running";
    onChange(view);
  }

  async function request(command: ShellCommand) {
    if (!socket.connected) throw new Error("Terminal connection lost.");
    const result = await socket.timeout(10_000).emitWithAck("command", command) as { error?: string };
    if (result.error) throw new Error(result.error);
  }

  async function drain() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) await request(queue.shift()!);
    } catch (error) {
      // An input request may have reached the shell. Never retry keystrokes.
      queue = [];
      update({ error: `${error instanceof Error ? error.message : "Terminal connection lost."} Check the terminal before typing again.` });
    } finally {
      sending = false;
      if (disposed) socket.disconnect();
    }
  }

  function enqueue(command: ShellCommand) {
    const previous = queue.at(-1);
    if (command.action === "input" && previous?.action === "input" && command.id === previous.id
      && command.data.length + previous.data.length <= 16 * 1024) previous.data += command.data;
    else if (command.action === "resize" && previous?.action === "resize") queue[queue.length - 1] = command;
    else queue.push(command);
    void drain();
  }

  function input(data: string) {
    if (!view.connected || !view.shell?.id || view.shell.status !== "running" || disposed) return;
    if (data.length > 1024 * 1024) {
      update({ error: "Paste is too large. Paste less than 1 MB at a time." });
      return;
    }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 8192, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      enqueue({ action: "input", id: view.shell.id, data: data.slice(offset, end) });
      offset = end;
    }
  }
  terminal.onData(input);

  function resize() {
    if (!view.connected || view.shell?.status !== "running" || !view.shell.id || !document.hasFocus()) return;
    // A hidden tab has no size; the fit addon would propose NaN, which the server rejects.
    if (!element.isConnected || element.clientWidth === 0 || element.clientHeight === 0) return;
    const dimensions = fit.proposeDimensions();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
    const cols = Math.max(2, Math.min(500, dimensions.cols));
    const rows = Math.max(1, Math.min(200, dimensions.rows));
    if (cols !== view.shell.cols || rows !== view.shell.rows) enqueue({ action: "resize", id: view.shell.id, cols, rows });
  }

  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 100);
  }

  async function start() {
    if (startPending || !view.shell || !view.connected) return;
    startPending = true;
    update({ error: null });
    try {
      await request({ action: "start", id: view.shell.id });
      focus();
    } catch (error) {
      update({ error: error instanceof Error ? error.message : "Could not start the terminal." });
    } finally { startPending = false; }
  }

  /** The terminal no longer exists on the server: stop reconnecting and drop pending input. */
  function markClosed() {
    if (view.closed) return;
    queue = [];
    socket.io.reconnection(false);
    socket.disconnect();
    update({ closed: true, connected: false, error: CLOSED_MESSAGE });
  }

  socket.on("shell", (event: ShellEvent, acknowledge?: () => void) => {
    if (event.type === "closed") {
      acknowledge?.();
      markClosed();
      return;
    }
    rendering = rendering.then(async () => {
      if (disposed) return;
      if (event.type === "output") {
        if (event.id === view.shell?.id) await new Promise<void>((resolve) => terminal.write(event.data, resolve));
        return;
      }
      if (event.type === "snapshot") {
        queue = [];
        terminal.reset();
        terminal.resize(event.state.cols, event.state.rows);
        await new Promise<void>((resolve) => terminal.write(event.data, resolve));
        if (disposed) return;
      } else if (terminal.cols !== event.state.cols || terminal.rows !== event.state.rows) {
        terminal.resize(event.state.cols, event.state.rows);
      }
      update({ shell: event.state, connected: true, error: null });
      if (event.type === "snapshot") scheduleResize();
      if (!started) {
        started = true;
        focus();
        if (event.state.status === "idle") void start();
      }
    }).then(() => acknowledge?.()).catch(() => update({ error: "Could not restore the terminal. Hide and reopen Terminal to reconnect." }));
  });
  const disconnected = () => {
    queue = [];
    update({ connected: false });
  };
  socket.on("disconnect", disconnected);
  socket.on("connect_error", (error: Error & { data?: { code?: string } }) => {
    if (error.data?.code === "unknown_terminal") markClosed();
    else disconnected();
  });
  const observer = new ResizeObserver(scheduleResize);
  observer.observe(element);
  terminal.textarea?.addEventListener("focus", scheduleResize);
  window.addEventListener("focus", scheduleResize);

  return {
    start,
    input(data: string) { input(data); terminal.focus(); },
    /** A hidden tab became visible: repaint, refit, and take focus if allowed. */
    refresh() {
      if (disposed) return;
      terminal.refresh(0, terminal.rows - 1);
      scheduleResize();
      focus();
    },
    dispose() {
      disposed = true;
      socket.off("shell");
      if (!sending) socket.disconnect();
      observer.disconnect();
      clearTimeout(resizeTimer);
      window.removeEventListener("focus", scheduleResize);
      terminal.textarea?.removeEventListener("focus", scheduleResize);
      // Hiding the panel must still deliver keystrokes already accepted from xterm.
      queue = queue.filter((command) => command.action === "input");
      terminal.dispose();
    },
  };
}
