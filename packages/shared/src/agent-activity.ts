import type { SessionLink } from "@portal/contracts/types";

export type AgentActivity =
  "idle" | "working" | "waiting" | "connecting" | "error";

export function agentActivity({
  busy,
  awaitingPermission,
  link,
  failed = false,
}: {
  busy: boolean;
  awaitingPermission: boolean;
  link?: SessionLink | null;
  failed?: boolean;
}): AgentActivity {
  if (awaitingPermission) return "waiting";
  if (link?.status === "connecting") return "connecting";
  if (link?.status === "offline" || failed) return "error";
  return busy ? "working" : "idle";
}

export const activityLabels: Record<AgentActivity, string> = {
  idle: "Ready",
  working: "Working",
  waiting: "Needs your approval",
  connecting: "Connecting",
  error: "Needs attention",
};
