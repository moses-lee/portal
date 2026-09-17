import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// A real stdio peer: exercises framing, dispatch, and subprocess lifecycle without
// starting a model or reading the developer's agent credentials.
const [agentId, logPath, configPath] = process.argv.slice(2);
const prompts = new Map();
const permissions = new Map();
const configs = new Map();
let sessionCount = 0;
let permissionCount = 0;

const COMMANDS = [
  { name: "help", description: "Show help" },
  { name: "review", description: "Review code", input: { hint: "what to review" } },
];

function initialConfigOptions() {
  return [
    {
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }],
    },
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: "fast",
      options: [{ value: "fast", name: "Fast" }, { value: "smart", name: "Smart" }],
    },
    { id: "fast", name: "Fast mode", category: "model_config", type: "boolean", currentValue: false },
  ];
}

function log(entry) {
  appendFileSync(logPath, `${JSON.stringify({ agentId, pid: process.pid, ...entry })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function update(sessionId, update) {
  send({ method: "session/update", params: { sessionId, update } });
}

function mode() {
  return JSON.parse(readFileSync(configPath, "utf8"))[agentId];
}

log({ event: "spawn" });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ event: "message", message });
  const { id, method, params } = message;

  if (method === "initialize") {
    if (mode() === "hang") return;
    if (mode() === "error") {
      send({ id, error: { code: -32603, message: "Fixture initialization failed" } });
      return;
    }
    // "resume" / "load" modes advertise the matching way of reattaching persisted sessions.
    const agentCapabilities = mode() === "resume" || mode() === "resume-error" || mode() === "hang-close"
      ? { sessionCapabilities: { resume: {}, close: {} } }
      : mode() === "load" ? { loadSession: true } : {};
    respond(id, { protocolVersion: params.protocolVersion, agentCapabilities });
  } else if (method === "session/resume" || method === "session/load") {
    if (mode() === "resume-error") {
      send({ id, error: { code: -32603, message: "Fixture cannot resume that session" } });
      return;
    }
    const sessionId = params.sessionId;
    if (!configs.has(sessionId)) configs.set(sessionId, initialConfigOptions());
    if (method === "session/load") {
      // History replay: the client already holds these events and must not log them again.
      update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed prompt" } });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed answer" } });
    }
    respond(id, {
      modes: { currentModeId: "plan", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
      configOptions: configs.get(sessionId),
    });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
  } else if (method === "session/close") {
    if (mode() === "hang-close") return; // A stalled agent never answers.
    configs.delete(params.sessionId);
    respond(id, {});
  } else if (method === "session/new") {
    if (mode() === "auth-required") {
      send({ id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    // Every process starts at the same upstream ID, including after a restart.
    const sessionId = `session-${++sessionCount}`;
    configs.set(sessionId, initialConfigOptions());
    respond(id, {
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }],
      },
      configOptions: configs.get(sessionId),
    });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
  } else if (method === "session/set_config_option") {
    const option = configs.get(params.sessionId).find((option) => option.id === params.configId);
    option.currentValue = params.value;
    respond(id, { configOptions: configs.get(params.sessionId) });
    if (params.configId === "mode") {
      update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.value });
    }
  } else if (method === "session/set_mode") {
    respond(id, {});
    update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
  } else if (method === "session/prompt") {
    const text = params.prompt[0].text;
    if (text === "exit") process.exit(17);
    if (text === "disconnect") {
      // Keep stdin open so only transport cleanup can stop this process.
      process.stdout.end();
      return;
    }
    if (text === "commands") {
      update(params.sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [...COMMANDS, { name: "commit", description: "Commit changes" }],
      });
      respond(id, { stopReason: "end_turn" });
      return;
    }
    update(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${agentId}:${text}` },
    });
    // The turn stays open until the client answers; nothing here auto-approves.
    const permissionId = `permission-${++permissionCount}`;
    permissions.set(permissionId, { id, sessionId: params.sessionId, hold: text === "hold" });
    send({
      id: permissionId,
      method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "tool-1", title: `${agentId} tool` },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
        ],
      },
    });
  } else if (method === "session/cancel") {
    const promptId = prompts.get(params.sessionId);
    if (promptId !== undefined) {
      prompts.delete(params.sessionId);
      respond(promptId, { stopReason: "cancelled" });
    }
  } else if (!method && permissions.has(id)) {
    const prompt = permissions.get(id);
    permissions.delete(id);
    if (prompt.hold) prompts.set(prompt.sessionId, prompt.id);
    else respond(prompt.id, { stopReason: "end_turn" });
  }
});
