# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
Next.js app that runs Claude Code and Codex through local ACP adapters and streams sessions to the browser.

## Run

Requires Node.js 24 or newer and a macOS or Linux host.

```sh
pnpm install
pnpm dev          # binds 0.0.0.0:3000 so it is reachable over Tailscale
```

Open `http://localhost:3000` or `http://<tailscale-ip>:3000`. Sessions belong to **projects**: folders you add once and Portal remembers. The start page lists your projects, offers the agent choices, and a **New session** button that starts a chat in the selected project's folder; the sidebar groups sessions under their projects, most recently active first, titled by their first message. **+ New** in the header returns to the start page. Each session keeps its original agent and starting directory for its whole life. Every session has its own URL (`/sessions/<id>`), so refreshing, sharing the link on your network, or using the browser's back button lands on the same conversation.

Sessions and their transcripts are saved under `~/.portal/sessions` and survive restarts: after Portal starts again, every session is listed, its history opens straight from disk, and the agent is reconnected in the background (ACP `session/resume`, so the agent picks up its own transcript without replaying it). While that runs, a bar under the transcript says *Connecting…*; if the agent cannot be reached it says why and offers **Reconnect**, and sending a message retries automatically. A turn that was running when Portal stopped is closed with a note. Terminals are not restored. Opening a session loads only its latest turns; scroll up (or press **Load earlier messages**) to fetch more, a page at a time. Delete a session from the **×** on its sidebar row; that removes its transcript from Portal, closes its terminals, and asks the agent to close its side.

A context bar under the message box shows the repository, branch, and directory the box targets: the active session's directory, or the selected project's folder when no session is open. The sidebar lists each session with its current branch under its project.

Sign in on the machine running Portal before creating a session:

- **Claude Code:** run `claude` and complete sign-in.
- **Codex:** run `codex login`. The ACP package includes a compatible Codex binary; `CODEX_PATH` can override it when needed.

Portal uses the agents' existing credentials. Mode, model, and effort controls under the message box are driven by whatever config options the agent announces over ACP; agents without them show none. Typing `/` in the message box autocompletes the agent's slash commands and skills. Tool permission requests appear inline in the chat and any connected viewer can answer them; **Stop** cancels pending prompts along with the turn. Portal does not override agent sandbox defaults.

## Projects and terminals

**Add project** in the sidebar or on the start page opens a folder browser (or takes a typed path such as `~/repos/portal`). Projects are stored in `~/.portal/projects.json` (set `PORTAL_HOME` to move the directory); each project is exactly one folder, stored as its resolved real path, and the same folder cannot be added twice. Rename or remove a project from its `⋯` menu in the sidebar; removing a project does not touch its sessions, which move to a **Removed projects** group and keep working. If a project's folder disappears from disk, the project stays listed with a *missing* marker until you remove or re-add it, and starting a session or terminal in it fails with a clear error.

### Worktrees

For a project inside a git repository, the start page adds a **Worktree** picker under the project select. **Original** (the default) starts the session in the project folder itself; otherwise pick an open pull request, a recent local or `origin` branch, or type a name to **Create branch** off `origin/<default branch>`. Starting the session then checks the branch out into its own git worktree at `~/.portal/worktrees/<repo>/<branch>` (under `PORTAL_HOME` if set; `/` and other unsafe characters in the branch name become `-`), records it as a project of its own named `<project> · <branch>`, and starts the session there. Projects whose folder is a subfolder of the repository get the same subfolder inside the worktree. A branch already checked out somewhere (the main checkout or any worktree) is reused instead of duplicated; branches that exist only on `origin` are fetched and set to track it. Creating a branch fetches the default branch first and fails if `origin` cannot be reached.

Pull requests come from the `gh` CLI (`gh pr list` / `gh pr view` in the repository); when `gh` is missing, signed out, or `origin` is not on GitHub, the picker still lists branches and shows the reason. PRs from forks are listed but cannot be checked out. Listing never runs `git fetch`.

Worktree projects appear indented under their parent in the sidebar and project select and behave like any other project. Removing one from its `⋯` menu offers to also delete the worktree folder (`git worktree remove`), and deletes the local branch too when it is fully merged into the default branch (`git branch -d`, never `-D`). Uncommitted changes make git refuse; **Remove anyway** forces it. A worktree folder that has already disappeared is pruned from git and the project is removed.

Click **Terminal** in the top-right corner of an open session to open that session's terminals below the chat and message box. Drag the divider to resize the panel; **Terminal** or **Hide** closes the panel while commands keep running. On touch screens, a small key row provides Esc, Tab, Ctrl+C, and command-history arrows.

- Terminals belong to a session. Opening the panel for the first time creates one tab; **+** adds more. Every tab is its own process started in the session's directory with the host's `$SHELL` as a login shell, with its usual configuration and environment.
- `cd` inside a terminal changes nothing about the session: the agent keeps working in the session's directory, and new sessions always start in their project's folder (or in the chosen worktree's).
- Switching sessions or hiding the panel leaves the processes running; reconnecting restores each tab's screen and up to 2,000 scrollback lines. A tab ends when you close it with **×**, when its shell exits (the output stays and **Start new shell** restarts it in the same directory), or when Portal stops.
- All viewers of a tab (other browser tabs, other devices) see the same terminal. The most recently focused/resized view sets its dimensions. Closing a tab on one device closes it everywhere.
- The start page has no terminal.

Terminals use `node-pty`, `@xterm/xterm`, xterm's headless/serialization and fit addons, and `react-resizable-panels`. Socket.IO carries ordered input, output, resizing, and automatic reconnection over WebSockets; each tab connects with its terminal ID. A small custom Next.js server (`server.mjs`) serves both the app and the terminal transport on port 3000 (or `$PORT`). Use `pnpm dev` / `pnpm start`; invoking `next dev` / `next start` directly does not start the terminal transport. Restart the server after changing its runtime modules.

Hosts currently support macOS and Linux. Each tab's directory and branch are tracked by reading its root shell process (`lsof` on macOS, `/proc` on Linux) about once a second, but only while a viewer is attached; nested shells, tmux panes, and remote SSH directories are not followed. Branch tracking reads `.git/HEAD` directly (following worktree pointers) instead of spawning `git`, so it is cheap to poll: each open session's branch and directory status refresh about once a second over its event stream. Detached HEADs show the abbreviated commit.

As with the agent APIs, terminals are intended for this personal Portal instance over localhost or a trusted private network. They run as the Portal host user; all connected devices share control. Every endpoint that changes something (projects, filesystem, terminals, and session creation, prompts, settings, permission answers, reconnects, and deletion) rejects cross-origin browser requests, and the folder browser lists directories only. `pnpm install` builds/prepares the native PTY dependency, including a workaround for its macOS prebuild executable permissions.

## Layout

- `src/lib/agents.ts` — server-side registry: agent names, launch configurations, and login instructions.
- `src/lib/acp-runtime.ts` — shared ACP runtime. One lazy subprocess per agent, isolated sessions, append-only event logs written through to the session store, agent-announced session state (modes, config options, commands), pending permission prompts, and reattaching persisted sessions (`session/resume`, falling back to `session/load` with the replay discarded).
- `src/lib/acp.ts` — runtime singleton preserved across development hot reloads.
- `src/lib/session-store.ts` — the `SessionStore` interface every persistence backend implements (session records plus an append-only, tail-readable event log with dense sequence numbers), and an in-memory implementation used by tests. `src/lib/file-session-store.ts` is the file backend: `~/.portal/sessions/index.json` (atomic rewrites) and `~/.portal/sessions/logs/<id>.jsonl`, read backwards in chunks so the latest page never scans the whole file; `src/lib/session-storage.ts` is its singleton. A cloud backend is another implementation of the same interface.
- `src/lib/session-pages.ts` — turn-aligned pagination over a store: every page starts at a user message so the browser can reduce it on its own.
- `src/lib/session-routes.ts` — the `/sessions/<id>` URL scheme shared by the router and the sidebar.
- `src/lib/types.ts` — shared event, project, and session metadata types.
- `src/lib/projects-store.ts` — persisted project list (`~/.portal/projects.json`, atomic rewrites), including `worktree: {parentId, branch}` metadata for worktree projects; `src/lib/projects.ts` is its singleton. `src/lib/fs-paths.ts` resolves and lists directories for it and for the folder browser.
- `src/lib/worktrees.ts` — branch and PR listing (`git for-each-ref`, `git worktree list`, `gh pr`), worktree creation under `~/.portal/worktrees`, and removal with merged-branch cleanup. `src/lib/branch-matching.ts` ranks picker rows; `src/lib/project-tree.ts` orders worktree projects under their parents.
- `src/lib/git-info.ts` — repository root and branch lookup by reading `.git` directly; `src/lib/session-summary.ts` attaches it to sessions for the browser.
- `src/app/api/agents` — `GET` available agents and the default selection.
- `src/app/api/projects` — `GET` list, `POST {path, name?}` add (409 with the existing project on a duplicate folder); `src/app/api/projects/[id]` — `PATCH {name}`, `DELETE` (`?worktree=delete` also removes a worktree project's folder and merged branch; 409 `{error, dirty: true}` when git refuses, `&force=1` overrides).
- `src/app/api/projects/[id]/branches` — `GET` the repository's branches (local and `origin`, default branch excluded), which are checked out where, and open PRs via `gh` (or why `gh` could not answer). `src/app/api/projects/[id]/pulls/[number]` — `GET` one PR in any state.
- `src/app/api/projects/[id]/worktrees` — `POST {branch, create?}` finds or creates the worktree for a branch (`create` starts it from `origin/<default>`) and returns `{project}`: 201 for a new worktree project, 200 when one already covers that folder.
- `src/app/api/fs/dirs` — `GET ?path=&hidden=1` lists subdirectories for the folder browser.
- `src/app/api/sessions` — `GET` list (most recently active first, with each session's `title` and `link` connection state), `POST {projectId, agentId}` create in that project's folder (pass a worktree project's ID to start in its worktree). Omitting `agentId` defaults to Claude Code. `src/app/api/sessions/[id]` — `GET` one session, `DELETE` removes it, its log, and its terminals.
- `src/app/api/sessions/[id]/events` — `GET ?before=<seq>&limit=<n>` one page of the log, oldest first, ending before `before` (default: the newest events) and starting at a turn boundary; returns `{events, hasMore, nextSeq}`.
- `src/app/api/sessions/[id]/stream` — Server-Sent Events tail from `?since=<seq>` (or `Last-Event-ID`); a `reset` event means the gap is no longer in memory and the viewer should refetch a page, `deleted` means the session is gone. `meta` events carry busy state, the agent connection (`link`), title, the directory's current branch, whether the directory still exists, the owning project, and the agent's session state (modes, config options, commands); they are re-sent whenever any of these change. Opening the stream reattaches the agent to a persisted session.
- `src/app/api/sessions/[id]/attach` — `POST` retries that reattachment; the outcome arrives as `meta.link`.
- `src/app/api/sessions/[id]/prompt` — `POST {text}`; returns 202, progress arrives via SSE.
- `src/app/api/sessions/[id]/cancel` — `POST`; cancels open permission prompts, then sends `session/cancel`.
- `src/app/api/sessions/[id]/config` — `POST {configId, value}` or `{modeId}`; forwards `session/set_config_option` / `session/set_mode` and returns the new `{state}`.
- `src/app/api/sessions/[id]/permission` — `POST {requestId, optionId}`; answers a `permission_request` from the event stream (`optionId: null` cancels it).
- `src/app/api/sessions/[id]/terminals` — `GET` list, `POST` create a terminal for the session (409 when its working directory is missing); `src/app/api/terminals/[id]` — `DELETE` closes one.
- `src/components/Chat.tsx` — the app shell: reads the session from the URL, owns the session list and project selection, and renders `SessionPane.tsx`, which loads the latest page, follows the live stream, fetches earlier pages on scroll while keeping the viewport still, and reduces events into user / assistant / thought / tool / plan blocks one turn at a time. `src/app/(portal)/layout.tsx` mounts the shell once for `/` and `/sessions/[id]`. `Sidebar.tsx`, `StartPage.tsx`, `AddProjectDialog.tsx`, and `DirectoryBrowser.tsx` handle projects.
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

- Projects and sessions persist under `~/.portal`; terminals live in server memory, so restarting the dev server loses them (sessions come back without their terminals).
- Portal keeps its own copy of each transcript under `~/.portal/sessions/logs`, including the raw tool inputs and outputs the agent reported (file contents, command output), so anything an agent read is stored there as well as in the agent's own transcript. Files are created readable by the Portal user only; deleting a session removes its log. Sessions started from the `claude` or `codex` CLI are not listed.
- Worktrees are created from the repository's `origin` remote only; repositories without `origin` can still check out local branches but cannot create new ones. Worktrees Portal did not create are reused when their branch is picked but are never deleted by Portal.
- Run one Portal instance per `PORTAL_HOME`; two servers writing the same projects and sessions files will overwrite each other.
- If an agent process exits, its sessions go offline and are reconnected with `session/resume` when next opened or messaged. Other agents' sessions keep running.
- Agent selection is fixed per session. Mode, model, and effort choices are limited to what the agent exposes as ACP config options; login screens and custom-agent configuration UI are not included.
