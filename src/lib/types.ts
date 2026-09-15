import type {
  AvailableCommand,
  PermissionOption,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { GitInfo } from "./git-info";

export type AgentInfo = { id: string; name: string };

/**
 * Agent-side session state announced over ACP. Replaced wholesale whenever the agent
 * sends `current_mode_update`, `config_option_update`, or `available_commands_update`,
 * or answers `session/set_config_option` / `session/set_mode`.
 */
export type SessionState = {
  /** Session modes from `session/new`; null when the agent exposes none. */
  modes: SessionModeState | null;
  /** Config options (mode, model, thought level, …) from `session/new` and later updates. */
  configOptions: SessionConfigOption[];
  /** Slash commands and skills the agent currently accepts, as pushed by the agent. */
  commands: AvailableCommand[];
};

export type SessionMeta = {
  id: string;
  agentId: string;
  agentName: string;
  cwd: string;
  createdAt: number;
  busy: boolean;
  state: SessionState;
};

/** Session metadata as served to the browser, with the directory's current git state. */
export type SessionSummary = SessionMeta & {
  displayCwd: string;
  git: GitInfo;
};

/** Payload of the SSE `meta` event on `/api/sessions/[id]/events`. */
export type SessionMetaEvent = {
  busy: boolean;
  cwd: string;
  agentId: string;
  agentName: string;
  git: GitInfo;
  state: SessionState;
};

export type PortalEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "user"; text: string }
  | { type: "turn_start" }
  | { type: "turn_end"; stopReason: StopReason }
  /** The agent asked for permission; the request stays open until a `permission_response` with the same `requestId`. */
  | { type: "permission_request"; requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] }
  /** A viewer answered (`selected`), or the request was cancelled by Stop, agent failure, or the turn ending. */
  | { type: "permission_response"; requestId: string; outcome: "selected"; optionId: string; optionName: string }
  | { type: "permission_response"; requestId: string; outcome: "cancelled" }
  | { type: "error"; message: string };

/** Body of `POST /api/sessions/[id]/config`. */
export type SetConfigRequest =
  | { configId: string; value: string | boolean }
  | { modeId: string };

/** Body of `POST /api/sessions/[id]/permission`. `optionId: null` cancels the request. */
export type PermissionAnswerRequest = { requestId: string; optionId: string | null };
