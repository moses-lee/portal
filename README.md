# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
Next.js app that runs Claude Code and Codex through local ACP adapters and streams sessions to the browser.

## Run

Requires Node.js 24 or newer and a macOS or Linux host.

```sh
pnpm install
pnpm dev          # binds 0.0.0.0:3000 so it is reachable over Tailscale
```

Open `http://localhost:3000` or `http://<tailscale-ip>:3000`. Sessions belong to **projects**: folders you add once and Portal remembers. The start page lists your projects, offers the agent choices, and a **New session** button that starts a chat in the selected project's folder; the sidebar groups sessions under their projects, and **+ New** in the header returns to the start page. Each session keeps its original agent and starting directory for its whole life.

A context bar under the message box shows the repository, branch, and directory the box targets: the active session's directory, or the selected project's folder when no session is open. The sidebar lists each session with its current branch under its project.

Sign in on the machine running Portal before creating a session:

- **Claude Code:** run `claude` and complete sign-in.
- **Codex:** run `codex login`. The ACP package includes a compatible Codex binary; `CODEX_PATH` can override it when needed.

Portal uses the agents' existing credentials. Mode, model, and effort controls under the message box are driven by whatever config options the agent announces over ACP; agents without them show none. Typing `/` in the message box autocompletes the agent's slash commands and skills. Tool permission requests appear inline in the chat and any connected viewer can answer them; **Stop** cancels pending prompts along with the turn. Portal does not override agent sandbox defaults.

## Projects and terminals

**Add project** in the sidebar or on the start page opens a folder browser (or takes a typed path such as `~/repos/portal`). Projects are stored in `~/.portal/projects.json` (set `PORTAL_HOME` to move the directory); each project is exactly one folder, stored as its resolved real path, and the same folder cannot be added twice. Rename or remove a project from its `⋯` menu in the sidebar; removing a project does not touch its sessions, which move to a **Removed projects** group and keep working. If a project's folder disappears from disk, the project stays listed with a *missing* marker until you remove or re-add it, and starting a session or terminal in it fails with a clear error.

Click **Terminal** in the top-right corner of an open session to open that session's terminals below the chat and message box. Drag the divider to resize the panel; **Terminal** or **Hide** closes the panel while commands keep running. On touch screens, a small key row provides Esc, Tab, Ctrl+C, and command-history arrows.

- Terminals belong to a session. Opening the panel for the first time creates one tab; **+** adds more. Every tab is its own process started in the session's directory with the host's `$SHELL` as a login shell, with its usual configuration and environment.
- `cd` inside a terminal changes nothing about the session: the agent keeps working in the session's directory, and new sessions always start in their project's folder.
- Switching sessions or hiding the panel leaves the processes running; reconnecting restores each tab's screen and up to 2,000 scrollback lines. A tab ends when you close it with **×**, when its shell exits (the output stays and **Start new shell** restarts it in the same directory), or when Portal stops.
- All viewers of a tab (other browser tabs, other devices) see the same terminal. The most recently focused/resized view sets its dimensions. Closing a tab on one device closes it everywhere.
- The start page has no terminal.

Terminals use `node-pty`, `@xterm/xterm`, xterm's headless/serialization and fit addons, and `react-resizable-panels`. Socket.IO carries ordered input, output, resizing, and automatic reconnection over WebSockets; each tab connects with its terminal ID. A small custom Next.js server (`server.mjs`) serves both the app and the terminal transport on port 3000 (or `$PORT`). Use `pnpm dev` / `pnpm start`; invoking `next dev` / `next start` directly does not start the terminal transport. Restart the server after changing its runtime modules.

Hosts currently support macOS and Linux. Each tab's directory and branch are tracked by reading its root shell process (`lsof` on macOS, `/proc` on Linux) about once a second, but only while a viewer is attached; nested shells, tmux panes, and remote SSH directories are not followed. Branch tracking reads `.git/HEAD` directly (following worktree pointers) instead of spawning `git`, so it is cheap to poll: each open session's branch and directory status refresh about once a second over its event stream. Detached HEADs show the abbreviated commit.

As with the agent APIs, terminals are intended for this personal Portal instance over localhost or a trusted private network. They run as the Portal host user; all connected devices share control. Project, filesystem, and terminal endpoints reject cross-origin browser requests, and the folder browser lists directories only. `pnpm install` builds/prepares the native PTY dependency, including a workaround for its macOS prebuild executable permissions.

## Layout

- `src/lib/agents.ts` — server-side registry: agent names, launch configurations, and login instructions.
- `src/lib/acp-runtime.ts` — shared ACP runtime. One lazy subprocess per agent, isolated sessions, append-only event logs, agent-announced session state (modes, config options, commands), and pending permission prompts.
- `src/lib/acp.ts` — runtime singleton preserved across development hot reloads.
- `src/lib/types.ts` — shared event, project, and session metadata types.
- `src/lib/projects-store.ts` — persisted project list (`~/.portal/projects.json`, atomic rewrites); `src/lib/projects.ts` is its singleton. `src/lib/fs-paths.ts` resolves and lists directories for it and for the folder browser.
- `src/lib/git-info.ts` — repository root and branch lookup by reading `.git` directly; `src/lib/session-summary.ts` attaches it to sessions for the browser.
- `src/app/api/agents` — `GET` available agents and the default selection.
- `src/app/api/projects` — `GET` list, `POST {path, name?}` add (409 with the existing project on a duplicate folder); `src/app/api/projects/[id]` — `PATCH {name}`, `DELETE`.
- `src/app/api/fs/dirs` — `GET ?path=&hidden=1` lists subdirectories for the folder browser.
- `src/app/api/sessions` — `GET` list, `POST {projectId, agentId}` create in that project's folder. Omitting `agentId` defaults to Claude Code.
- `src/app/api/sessions/[id]/events` — Server-Sent Events: replays the log, then tails it. `meta` events carry busy state, the directory's current branch, whether the directory still exists, the owning project, and the agent's session state (modes, config options, commands); they are re-sent whenever any of these change.
- `src/app/api/sessions/[id]/prompt` — `POST {text}`; returns 202, progress arrives via SSE.
- `src/app/api/sessions/[id]/cancel` — `POST`; cancels open permission prompts, then sends `session/cancel`.
- `src/app/api/sessions/[id]/config` — `POST {configId, value}` or `{modeId}`; forwards `session/set_config_option` / `session/set_mode` and returns the new `{state}`.
- `src/app/api/sessions/[id]/permission` — `POST {requestId, optionId}`; answers a `permission_request` from the event stream (`optionId: null` cancels it).
- `src/app/api/sessions/[id]/terminals` — `GET` list, `POST` create a terminal for the session; `src/app/api/terminals/[id]` — `DELETE` closes one.
- `src/components/Chat.tsx` — reduces the event stream into user / assistant / thought / tool / plan blocks; `Sidebar.tsx`, `StartPage.tsx`, `AddProjectDialog.tsx`, and `DirectoryBrowser.tsx` handle projects.
- `src/lib/shell-runtime.ts` — one PTY with bounded terminal state, directory tracking, and subscribers; `src/lib/terminals-registry.ts` keeps one per terminal tab (`src/lib/terminals.ts` is the singleton).
- `src/lib/shell-server.ts` — terminal WebSocket commands, snapshots, live subscribers, and close notifications.
- `src/components/TerminalPanel.tsx` — per-session tab strip; `TerminalView.tsx` and `src/lib/shell-client.ts` own xterm and browser I/O for one tab.

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

- Projects persist in `~/.portal/projects.json`; sessions and terminals live in server memory, so restarting the dev server loses them.
- Run one Portal instance per `PORTAL_HOME`; two servers writing the same projects file will overwrite each other.
- If an agent process exits, its session history remains visible, but continuing requires a new session. Other agents' sessions keep running.
- Agent selection is fixed per session. Mode, model, and effort choices are limited to what the agent exposes as ACP config options; login screens and custom-agent configuration UI are not included.
