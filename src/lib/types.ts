import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";

export type AgentInfo = { id: string; name: string };

export type SessionMeta = {
  id: string;
  agentId: string;
  agentName: string;
  cwd: string;
  createdAt: number;
  busy: boolean;
};

export type PortalEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "user"; text: string }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "permission"; title: string; optionId: string; optionName: string }
  | { type: "error"; message: string };
