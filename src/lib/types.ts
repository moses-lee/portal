import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { GitInfo } from "./git-info";

export type AgentInfo = { id: string; name: string };

export type SessionMeta = {
  id: string;
  agentId: string;
  agentName: string;
  cwd: string;
  createdAt: number;
  busy: boolean;
};

/** Session metadata as served to the browser, with the directory's current git state. */
export type SessionSummary = SessionMeta & {
  displayCwd: string;
  git: GitInfo;
};

export type PortalEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "user"; text: string }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason: StopReason }
  | { type: "permission"; title: string; optionId: string; optionName: string }
  | { type: "error"; message: string };
