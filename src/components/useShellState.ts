"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import type { ShellEvent, ShellState } from "@/lib/shell-types";

export function useShellState() {
  const [state, setState] = useState<ShellState | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const socket = io({ path: "/api/shell/socket", transports: ["websocket"] });
    const onShell = (event: ShellEvent, acknowledge: () => void) => {
      if (event.type === "state") {
        setState(event.state);
        setConnected(true);
      }
      acknowledge();
    };
    const onDisconnect = () => setConnected(false);
    socket.on("shell", onShell);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onDisconnect);
    return () => {
      socket.off("shell", onShell);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onDisconnect);
      socket.disconnect();
    };
  }, []);
  return { state, connected };
}
