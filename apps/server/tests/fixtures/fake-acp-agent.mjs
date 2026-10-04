import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

// A real stdio peer: exercises framing, dispatch, and subprocess lifecycle without
// starting a model or reading the developer's agent credentials.
const [agentId, logPath, configPath] = process.argv.slice(2);
const prompts = new Map();
/** Sessions whose "tool-then-talk" turn speaks up on the next set_mode. */
const talkers = new Set();
/** Sessions whose "ask-on-mode" turn asks for a permission, outside any turn, on the next set_mode. */
const askers = new Set();
const permissions = new Map();
const configs = new Map();
/** Child processes a "spawn" prompt started, by session; killed on cancel and when this process exits. */
const children = new Map();
const killGroup = (child) => {
  try { if (child) process.kill(-child.pid, "SIGKILL"); } catch {}
};
/**
 * Background tasks a "background" prompt left running, by task id: `{ sessionId, child, title }`.
 * Announced over AIR only to a client that advertised `asyncTasks`, as the real adapters do.
 */
const backgroundTasks = new Map();
process.on("exit", () => {
  for (const child of children.values()) killGroup(child);
  for (const task of backgroundTasks.values()) killGroup(task.child);
});
let sessionCount = 0;
let permissionCount = 0;
let taskCount = 0;
/** Whether the client advertised AIR `asyncTasks` at initialize (the adapters' `clientSupportsAirCapability`). */
let airTasks = false;

function supportsAirTasks(capabilities) {
  const air = capabilities?._meta?.jetbrains?.air;
  return Number.isInteger(air?.version) && air.version >= 1 && Array.isArray(air.capabilities) && air.capabilities.includes("asyncTasks");
}

/** End a background task: its process goes, and an AIR client hears the terminal state. */
function finishTask(taskId, state) {
  const task = backgroundTasks.get(taskId);
  if (!task) return false;
  backgroundTasks.delete(taskId);
  killGroup(task.child);
  if (airTasks) update(task.sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: taskId, state, ...(state === "completed" ? { summary: "exited 0" } : {}) });
  return true;
}

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

log({ event: "spawn", env: { NODE_ENV: process.env.NODE_ENV ?? null, TURBOPACK: process.env.TURBOPACK ?? null, PORTAL_KEEP: process.env.PORTAL_KEEP ?? null } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ event: "message", message });
  const { id, method, params } = message;

  if (method === "initialize") {
    airTasks = supportsAirTasks(params.clientCapabilities);
    if (mode() === "hang") return;
    if (mode() === "error") {
      send({ id, error: { code: -32603, message: "Fixture initialization failed" } });
      return;
    }
    // "resume" / "load" modes advertise the matching way of reattaching persisted sessions.
    const agentCapabilities = mode() === "resume" || mode() === "resume-error" || mode() === "resume-missing" || mode() === "hang-close"
      ? { sessionCapabilities: { resume: {}, close: {} } }
      : mode() === "load" ? { loadSession: true } : {};
    respond(id, { protocolVersion: params.protocolVersion, agentCapabilities });
  } else if (method === "session/resume" || method === "session/load") {
    if (mode() === "resume-error") {
      send({ id, error: { code: -32603, message: "Fixture cannot resume that session" } });
      return;
    }
    if (mode() === "resume-missing") {
      // The ACP "resource not found" code: the agent has no transcript for this session.
      send({ id, error: { code: -32002, message: `Resource not found: ${params.sessionId}` } });
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
    if (askers.delete(params.sessionId)) {
      // A permission request with no prompt behind it, as a background task of a finished turn may send.
      const permissionId = `permission-${++permissionCount}`;
      permissions.set(permissionId, { id: null, sessionId: params.sessionId, hold: false });
      send({
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tool-bg", title: `${agentId} background tool` },
          options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
        },
      });
    }
    if (talkers.delete(params.sessionId)) {
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still here" } });
    }
    // The session's background tasks finish (the test's signal, like the talkers').
    for (const [taskId, task] of backgroundTasks) if (task.sessionId === params.sessionId) finishTask(taskId, "completed");
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
    if (text === "tool" || text === "spawn") {
      // A turn that stays open on a running tool until cancelled. "spawn" also runs a child process
      // the way an agent's shell tool would.
      prompts.set(params.sessionId, id);
      const title = text === "spawn" ? "sleep 30" : "bazel test //...";
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title, kind: "execute", status: "pending" });
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" });
      if (text === "spawn") {
        // Like Claude Code's per-session process: its command line names the session, and the tool runs below it.
        const child = spawn("sh", ["-c", `sleep 30; : ${params.sessionId}`], { stdio: "ignore", detached: true });
        log({ event: "child", childPid: child.pid });
        children.set(params.sessionId, child);
      }
      return;
    }
    if (text === "tool-then-talk") {
      // A tool that sits quiet until the test signals (with a set_mode), then the agent speaks up;
      // the turn stays open until cancelled.
      prompts.set(params.sessionId, id);
      talkers.add(params.sessionId);
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-4", title: "wait", kind: "execute", status: "pending" });
      return;
    }
    if (text === "finish-tool") {
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-2", title: "ls", kind: "execute", status: "pending" });
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "completed", content: [{ type: "content", content: { type: "text", text: "a b" } }] });
      respond(id, { stopReason: "end_turn" });
      return;
    }
    if (text === "stream") {
      // What a real turn looks like on the wire: text in small chunks, a tool that heartbeats while
      // it runs, a screenshot in the result (repeated in rawOutput, as Claude Code does), more text.
      for (const piece of ["Hel", "lo ", "there"]) update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
      for (const piece of ["think", "ing"]) update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: piece } });
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "call-3", title: "screenshot", kind: "other", status: "pending" });
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "in_progress" });
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "in_progress", _meta: { claudeCode: { toolResponse: { elapsedTimeSeconds: 30 } } } });
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "in_progress" });
      const png = Buffer.alloc(5000, 7).toString("base64");
      update(params.sessionId, {
        sessionUpdate: "tool_call_update", toolCallId: "call-3", status: "completed",
        content: [{ type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
        rawOutput: { image: png, note: "done" },
      });
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "bye" } });
      respond(id, { stopReason: "end_turn" });
      return;
    }
    if (text.startsWith("name:")) {
      // The agent names the conversation, as Claude Code does after the first turn.
      update(params.sessionId, { sessionUpdate: "session_info_update", title: text.slice("name:".length) });
      respond(id, { stopReason: "end_turn" });
      return;
    }
    if (text === "background" || text === "background-first") {
      // A shell backgrounded by the turn, as Claude Code's Bash with run_in_background does: the turn
      // ends at once, the shell keeps running below the session's process, and an AIR client hears
      // of it after the turn ended, with a progress report, until it finishes (on the next set_mode)
      // or is stopped (`_session/async_task/stop`). "background-first" announces the task while the
      // turn is still open, before the reply.
      const taskId = `task-${++taskCount}`;
      const toolCallId = `call-bg-${taskCount}`;
      const announce = () => update(params.sessionId, {
        sessionUpdate: "async_task_spawned", asyncTaskId: taskId, name: "sleep 30", taskType: "shell", description: "sleep 30",
        showInTranscript: false, canStop: true, toolCallId,
      });
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId, title: "sleep 30", kind: "execute", status: "pending" });
      const child = spawn("sh", ["-c", `sleep 30; : ${params.sessionId}`], { stdio: "ignore", detached: true });
      log({ event: "child", childPid: child.pid, taskId });
      backgroundTasks.set(taskId, { sessionId: params.sessionId, child });
      if (airTasks && text === "background-first") announce();
      update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: `Command running in background with ID: ${taskId}.` } }] });
      respond(id, { stopReason: "end_turn" });
      if (airTasks) {
        if (text === "background") announce();
        update(params.sessionId, { sessionUpdate: "async_task_progress", asyncTaskId: taskId, description: "still sleeping" });
        update(params.sessionId, { sessionUpdate: "async_task_state_update", asyncTaskId: taskId, state: "running" });
      }
      return;
    }
    if (text === "phantom-task") {
      // A task announced but no longer known to the agent (it ended meanwhile), so stopping it stops nothing.
      respond(id, { stopReason: "end_turn" });
      if (airTasks) update(params.sessionId, { sessionUpdate: "async_task_spawned", asyncTaskId: `phantom-${++taskCount}`, name: "gone", canStop: true });
      return;
    }
    if (text === "ask-on-mode") {
      askers.add(params.sessionId);
      respond(id, { stopReason: "end_turn" });
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
  } else if (method === "_session/async_task/stop") {
    const task = backgroundTasks.get(params.asyncTaskId);
    const stopped = !!task && task.sessionId === params.sessionId && finishTask(params.asyncTaskId, "stopped");
    respond(id, { stopped });
  } else if (method === "session/cancel") {
    const promptId = prompts.get(params.sessionId);
    killGroup(children.get(params.sessionId));
    children.delete(params.sessionId);
    if (promptId !== undefined) {
      prompts.delete(params.sessionId);
      respond(promptId, { stopReason: "cancelled" });
    }
    // A turn still waiting on a permission ends too, leaving the request unanswered on the client.
    for (const [permissionId, prompt] of permissions) {
      if (prompt.sessionId !== params.sessionId) continue;
      permissions.delete(permissionId);
      if (prompt.id !== null) respond(prompt.id, { stopReason: "cancelled" });
    }
  } else if (!method && permissions.has(id)) {
    const prompt = permissions.get(id);
    permissions.delete(id);
    if (prompt.id === null) return; // Asked outside a turn: no prompt to finish.
    if (prompt.hold) prompts.set(prompt.sessionId, prompt.id);
    else respond(prompt.id, { stopReason: "end_turn" });
  }
});
