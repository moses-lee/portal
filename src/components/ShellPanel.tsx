"use client";

import { useEffect, useRef, useState } from "react";
import { mountShell, type ShellViewState } from "@/lib/shell-client";
import "@xterm/xterm/css/xterm.css";

export default function ShellPanel({ onHide }: { onHide: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const client = useRef<ReturnType<typeof mountShell> | null>(null);
  const [view, setView] = useState<ShellViewState>({ shell: null, connected: false, error: null });
  useEffect(() => {
    const connection = mountShell(container.current!, setView);
    client.current = connection;
    return () => { client.current = null; connection.dispose(); };
  }, []);

  return (
    <section aria-label="Shell" className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 text-xs text-zinc-400">
        <span className="font-medium text-zinc-200">Shell</span>
        <span className="truncate font-mono" title={view.shell?.cwd}>{view.shell?.displayCwd}</span>
        <span role="status" className="ml-auto shrink-0">
          {!view.connected ? "Connecting…" : view.shell?.status === "exited" ? `Exited (${view.shell.exitCode})` : view.shell?.shell}
        </span>
        {view.connected && view.shell?.status !== "running" && (
          <button onClick={() => void client.current?.start()} className="shrink-0 rounded bg-indigo-600 px-2 py-1 text-white hover:bg-indigo-500">
            Start new shell
          </button>
        )}
        <button aria-label="Hide shell" onClick={onHide} className="rounded px-2 py-1 text-zinc-300 hover:bg-zinc-800">Hide</button>
      </div>
      {view.error && <p role="alert" className="px-3 pb-2 text-xs text-red-300">{view.error}</p>}
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-2">
        <div ref={container} className="h-full min-h-0" />
      </div>
      <div className="flex shrink-0 gap-2 border-t border-zinc-800 px-3 py-1 md:hidden">
        {[["Esc", "\u001b"], ["Tab", "\t"], ["Ctrl+C", "\u0003"], ["↑", "\u001b[A"], ["↓", "\u001b[B"]].map(([label, data]) => (
          <button key={label} disabled={!view.connected || view.shell?.status !== "running"} onClick={() => client.current?.input(data)} className="rounded bg-zinc-900 px-3 py-2 text-xs disabled:opacity-40">{label}</button>
        ))}
      </div>
    </section>
  );
}
