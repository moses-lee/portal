import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// A real stdio peer: exercises framing, dispatch, and subprocess lifecycle without
// starting a model or reading the developer's agent credentials.
const [agentId, logPath, configPath] = process.argv.slice(2);
const prompts = new Map();
const permissions = new Map();
let sessionCount = 0;
let permissionCount = 0;

function log(entry) {
  appendFileSync(logPath, `${JSON.stringify({ agentId, pid: process.pid, ...entry })}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
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
    respond(id, { protocolVersion: params.protocolVersion, agentCapabilities: {} });
  } else if (method === "session/new") {
    if (mode() === "auth-required") {
      send({ id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    // Every process starts at the same upstream ID, including after a restart.
    respond(id, { sessionId: `session-${++sessionCount}` });
  } else if (method === "session/prompt") {
    const text = params.prompt[0].text;
    if (text === "exit") process.exit(17);
    if (text === "disconnect") {
      // Keep stdin open so only transport cleanup can stop this process.
      process.stdout.end();
      return;
    }
    send({
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${agentId}:${text}` },
        },
      },
    });
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
