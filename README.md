# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
Next.js app that runs Claude Code and Codex through local ACP adapters and streams sessions to the browser.

## Run

Requires Node.js 24 or newer and a macOS or Linux host.

```sh
pnpm install
pnpm dev          # binds 0.0.0.0:3000 so it is reachable over Tailscale
```

Open `http://localhost:3000` or `http://<tailscale-ip>:3000`. Use **Shell** to change directories, select an agent, click **New session**, and chat. Each existing session keeps its original agent and starting directory.

Sign in on the machine running Portal before creating a session:

- **Claude Code:** run `claude` and complete sign-in.
- **Codex:** run `codex login`. The ACP package includes a compatible Codex binary; `CODEX_PATH` can override it when needed.

Portal uses the agents' existing credentials and default model/reasoning settings. Tool permission requests are automatically approved through ACP; Portal does not override agent sandbox defaults.

## Shell

Click **Shell** in the top-right corner to open a terminal below the chat and message box. Drag its divider to resize it; **Shell** or **Hide** closes the panel while commands keep running. On touch screens, a small key row provides Esc, Tab, Ctrl+C, and command-history arrows.

- One shell is shared across chats, browser tabs, and devices. It is available before starting a chat.
- The first shell starts in Portal's launch directory using the host's `$SHELL` as a login shell, with its usual configuration and environment.
- The sidebar shows the shell's current directory. `cd` changes where **new** chats start; existing chats retain their starting directory. The path is read-only in the sidebar.
- Hiding the panel or refreshing reconnects to the same process, restoring its screen and up to 2,000 scrollback lines. Typing `exit` retains the output and offers **Start new shell**, starting in the last directory.
- All viewers see the same terminal. The most recently focused/resized view sets its dimensions. Restarting Portal ends the shell.

The terminal uses `node-pty`, `@xterm/xterm`, xterm's headless/serialization and fit addons, and `react-resizable-panels`. Socket.IO carries ordered input, output, resizing, and automatic reconnection over WebSockets. A small custom Next.js server (`server.mjs`) serves both the app and shell on port 3000 (or `$PORT`). Use `pnpm dev` / `pnpm start`; invoking `next dev` / `next start` directly does not start the shell transport. Restart the server after changing its runtime modules.

Hosts currently support macOS and Linux. Directory tracking reads the root shell process (`lsof` on macOS, `/proc` on Linux), so nested shells, tmux panes, and remote SSH directories do not change Portal's local working directory. Directory changes appear within about a second, and new-session creation refreshes it on the server. If tracking fails, new chats are paused until it recovers.

As with the agent APIs, the shell is intended for this personal Portal instance over localhost or a trusted private network. It runs as the Portal host user; all connected devices share control. Shell endpoints reject cross-origin browser requests. `pnpm install` builds/prepares the native PTY dependency, including a workaround for its macOS prebuild executable permissions.

## Layout

- `src/lib/agents.ts` — server-side registry: agent names, launch configurations, and login instructions.
- `src/lib/acp-runtime.ts` — shared ACP runtime. One lazy subprocess per agent, isolated sessions, append-only event logs, and automatic permissions.
- `src/lib/acp.ts` — runtime singleton preserved across development hot reloads.
- `src/lib/types.ts` — shared event and session metadata types.
- `src/app/api/agents` — `GET` available agents and the default selection.
- `src/app/api/sessions` — `GET` list, `POST {cwd, agentId}` create. Omitting `agentId` defaults to Claude Code.
- `src/app/api/sessions/[id]/events` — Server-Sent Events: replays the log, then tails it.
- `src/app/api/sessions/[id]/prompt` — `POST {text}`; returns 202, progress arrives via SSE.
- `src/app/api/sessions/[id]/cancel` — `POST`; sends `session/cancel`.
- `src/components/Chat.tsx` — reduces the event stream into user / assistant / thought / tool / plan blocks.
- `src/lib/shell-runtime.ts` — shared PTY, bounded terminal state, directory tracking, and subscribers.
- `src/lib/shell-server.ts` — shell WebSocket commands, snapshots, and live subscribers.
- `src/app/api/shell` — read-only shared shell metadata.
- `src/components/ShellPanel.tsx` — terminal panel; `src/lib/shell-client.ts` owns xterm and browser I/O.

## Adding an agent

Install its ACP adapter and add an entry to `src/lib/agents.ts` with a unique ID, display name, executable, arguments, and login instructions. An optional `env` object extends the host environment. Launch commands stay on the server; the browser receives only IDs and names.

Adapters must speak ACP over stdio and support the current text-chat flow. The shared client advertises no optional filesystem or terminal capabilities. Compatible adapters need no changes to the chat UI or session routes.

## Checks

Using Node.js 24 or newer:

```sh
pnpm test         # fake ACP processes and real PTYs; no credentials or model calls
pnpm lint
pnpm build
```

## Known limits

- Sessions live in server memory; restarting the dev server loses them.
- If an agent process exits, its session history remains visible, but continuing requires a new session. Other agents' sessions keep running.
- Agent selection is fixed per session. Model selection, login screens, and custom-agent configuration UI are not included.
