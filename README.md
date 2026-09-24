# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
A Next.js front end and a Fastify server that runs Claude Code and Codex through local ACP adapters, keeps everything in Postgres, and streams sessions to the browser.

## Run

Requires Node.js 24 or newer, pnpm, a macOS or Linux host, and Docker for Postgres (on macOS, [Colima](https://github.com/abiosoft/colima): `brew install colima docker docker-compose && colima start`).

```sh
pnpm install
pnpm dev          # Postgres, then the server and the web app; the web app binds 0.0.0.0:3000 so it is reachable over Tailscale
pnpm prod         # production build, then serve it on the same port
```

`pnpm dev` and `pnpm start` first run `pnpm db:up` (`docker compose up -d --wait`, which starts the `portal-postgres` container and waits until it is healthy), then run the server and the web app side by side. `pnpm prod` runs `pnpm build` and then `pnpm start`. It clears the variables `next dev` sets on its own process first, so it also works from a terminal opened inside Portal; stop the dev servers before running it, since both use the same ports. `pnpm db:down` stops Postgres (the data stays in its volume).

Open `http://localhost:3000` or `http://<tailscale-ip>:3000`. The home (`/`) is Portal itself: the orchestrator's conversation (see *Talk to Portal*), with its views listed in the sidebar. Sessions belong to **projects**: folders you add once and Portal remembers, kept in the sidebar's **Projects** section (like **Removed**, it takes over the sidebar column, with a back arrow to Portal's entries; opening a session or the start page shows it by itself). On the start page (`/new`, reached from a project's **New conversation** button), choose a project and agent, then send your first message or choose **Start an empty conversation**; the Projects section groups sessions under their projects, most recently active first, titled by their first message. The **New conversation** action in a session's header returns to the start page.

**Pin** a project from its `⋯` menu, or a session from its own `⋯` menu, to keep it at the top: pinned projects lead the sidebar and the start page's project dropdown (most recently pinned first), and pinned sessions lead their project's group (still most recently active first among themselves). Pins are a per-browser preference kept in localStorage, so each device keeps its own; pins for deleted sessions and removed projects are forgotten. A session row shows a pulsing dot while its agent is working and a steady, brighter one while the agent waits for someone to answer a permission prompt; a collapsed project shows the same dot when any of its sessions is in that state. The sidebar follows every session live, so a turn started or answered from another device shows up without a reload. Each session keeps its original agent and starting directory for its whole life. Every session has its own URL (`/sessions/<id>`), so refreshing, sharing the link on your network, or using the browser's back button lands on the same conversation.

Sessions and their transcripts are saved in Postgres and survive restarts: after Portal starts again, every session is listed, its history opens straight from the database, and the agent is reconnected in the background (ACP `session/resume`, so the agent picks up its own transcript without replaying it). While that runs, a bar under the transcript says *Connecting…*; if the agent cannot be reached it says why and offers **Reconnect**, and sending a message retries automatically. A turn that was running when Portal stopped is closed with a note. Terminals are not restored. Opening a session loads only its latest turns; scroll up (or press **Load earlier messages**) to fetch more, a page at a time. Delete a session from its sidebar `⋯` menu; that removes its transcript from Portal, closes its terminals, and asks the agent to close its side.

The branch and working directory appear once below the composer. Click them for the full values and copy actions. Session rows use provider logos, two-line titles, and a separate actions menu. Search conversations, drag the sidebar divider to resize it, or hide it with the sidebar toggle; width and visibility are remembered in this browser. On mobile, navigation opens in a sheet with keyboard focus handling.

Sign in on the machine running Portal before creating a session:

- **Claude Code:** run `claude` and complete sign-in.
- **Codex:** run `codex login`. The ACP package includes a compatible Codex binary; `CODEX_PATH` can override it when needed.

Portal uses the agents' existing credentials. The compact model/mode control in the composer opens **Agent settings**, with model, mode, effort, and boolean options driven by whatever the agent announces over ACP. Agents without options show none. Typing `/` in the message box autocompletes the agent's slash commands and skills. Tool permission requests appear inline in the chat and any connected viewer can answer them; **Stop** cancels pending prompts along with the turn. Portal does not override agent sandbox defaults.

Drafts survive session switches and reloads within the same browser tab. Sending clears a draft only after the server accepts it; a failed request leaves it available to retry. Edits made while a send is in flight are preserved. Conversations follow streamed responses until you scroll away; **Jump to latest** resumes following. Tool calls, reasoning, and plans are grouped into expandable activity, with inline approvals, highlighted code, copy actions, and readable diffs.

The dark interface uses local [shadcn components](https://ui.shadcn.com/docs/components), including Message, Bubble, and Message Scroller. Glass surfaces use CSS blur and translucency. The CSS aurora is adapted from the [shadcn.io Aurora](https://www.shadcn.io/background/aurora) visual: violet at rest, blue/violet while working, amber for approval, and rose for errors. Status text accompanies every state. Animation pauses in hidden tabs and respects reduced-motion preferences; reduced-transparency preferences use solid surfaces. Local provider marks come from Wikimedia ([Claude](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg), [ChatGPT](https://commons.wikimedia.org/wiki/File:ChatGPT-Logo.svg)).

### Environment

Everything has a default, so `pnpm dev` needs no configuration.

| Variable | Default | Read by | Meaning |
| --- | --- | --- | --- |
| `PORT` | `3000` | web | Port the web app listens on (all interfaces). |
| `PORTAL_SERVER_PORT` | `3100` | server, web build | Port the server listens on, and the port the web app proxies to. |
| `PORTAL_SERVER_HOST` | `127.0.0.1` | server | Interface the server binds. Keep it on loopback: browsers reach it through the web app. |
| `PORTAL_SERVER_ORIGIN` | `http://127.0.0.1:$PORTAL_SERVER_PORT` | web build | Full origin of the server, when it is not on this host's loopback. |
| `DATABASE_URL` | `postgres://portal:portal@127.0.0.1:5433/portal` | server | Postgres connection string (the `docker-compose.yml` database). |
| `PORTAL_HOME` | `~/.portal` | server | Portal's private directory (see *Data* below). |

`PORTAL_SERVER_ORIGIN` and `PORTAL_SERVER_PORT` are read by `next.config.ts`, and Next.js bakes the proxy target into the build: `next start` serves whatever destination `next build` saw. So `pnpm build` (or `pnpm prod`) and `pnpm start` must run with the same values, and changing the server's port means rebuilding the web app. `pnpm dev` reads them on every start.

### How the browser reaches the server

The browser only ever talks to the web app. `apps/web/next.config.ts` rewrites every `/api/*` path to the server, which binds loopback only; that includes the terminal WebSocket (`/api/shell/socket`, Socket.IO), since the Next.js proxy forwards upgrades too. The server's event streams and the Talk to Portal chat reply send `Cache-Control: no-cache, no-transform` so Next's compression does not buffer them. The proxy gives up on a response that sends nothing for 30 seconds by default; `next.config.ts` raises that to an hour (`experimental.proxyTimeout`), since a manual tick or a script can stay silent for minutes, and the event streams ping every 15 seconds besides.

### Data

- **Postgres** holds everything Portal remembers: projects, sessions and their event logs, settings, API keys, and Talk to Portal's thread, items, watches, and memory. It runs in the `portal-postgres` container, with its data in the Docker volume `portal-postgres` (it survives `pnpm db:down` and container rebuilds; `docker volume rm portal-postgres` deletes it). Back it up with `docker exec portal-postgres pg_dump -U portal portal > portal.sql`.
- **`PORTAL_HOME`** (`~/.portal`) holds only files that do not belong in the database: `server.key`, the key that encrypts stored API keys (created on first use, readable by the Portal user only); `worktrees/`, the git worktrees Portal creates; and, after the import below, the old app's files, kept as a backup. **Back up `server.key`**: without it the stored API keys cannot be decrypted, and a database dump on its own never reveals them.

The first time the server starts against an empty database, it imports the old single-app Portal's files from `PORTAL_HOME` (`projects.json`, `sessions/`, `settings.json`, `orchestrator/`) before serving anything. It runs automatically when the database is empty; `pnpm --filter @portal/server import --dry-run` previews it. The files stay where they are as a backup, except `settings.json`: it held the API keys in plain text, so once they are encrypted into the database it is renamed to `settings.json.imported-<time>` (readable by the Portal user only). For anything else (a database already in use, another home directory), run `pnpm --filter @portal/server import` by hand with the server stopped; `--help` lists its options.

### Start at login (macOS)

`scripts/launchd/com.portal.plist` is a LaunchAgent template that runs `pnpm start` from the repository root when you log in, restarts it if it exits, and logs to `~/Library/Logs/portal/`. It does not build: run `pnpm build` first, and again after every update, with the same `PORT` / `PORTAL_SERVER_*` values the plist sets. Docker must come up at login as well (`brew services start colima`); until it answers, launchd retries every 30 seconds.

```sh
# install: edit the repository path, home directory and PATH in the template first if yours differ
mkdir -p ~/Library/Logs/portal
cp scripts/launchd/com.portal.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.portal.plist
launchctl kickstart -k gui/$(id -u)/com.portal     # restart it, e.g. after a rebuild

# uninstall
launchctl bootout gui/$(id -u)/com.portal
rm ~/Library/LaunchAgents/com.portal.plist
```

## Projects and terminals

**Add project** in the sidebar or on the start page opens a folder browser (or takes a typed path such as `~/repos/portal`). Each project is exactly one folder, stored as its resolved real path, and the same folder cannot be added twice. Rename or remove a project from its `⋯` menu in the sidebar; removing a project does not touch its sessions, which move to the **Removed** list at the bottom of the Projects section and keep working. If a project's folder disappears from disk, the project stays listed with a *missing* marker until you remove or re-add it, and starting a session or terminal in it fails with a clear error.

### Worktrees

For a project inside a git repository, the start page adds a **Worktree** picker under the project select. **Original** (the default) starts the session in the project folder itself; otherwise pick an open pull request, a recent local or `origin` branch, or type a name to **Create branch** off `origin/<default branch>`. Starting the session then checks the branch out into its own git worktree at `~/.portal/worktrees/<repo>/<branch>` (under `PORTAL_HOME` if set; `/` and other unsafe characters in the branch name become `-`), records it as a project of its own named after the branch, and starts the session there. Worktree projects created by older Portal versions, named `<project> · <branch>`, are renamed to the branch when they are imported, unless the name was changed by hand. Projects whose folder is a subfolder of the repository get the same subfolder inside the worktree. A branch already checked out somewhere (the main checkout or any worktree) is reused instead of duplicated; branches that exist only on `origin` are fetched and set to track it. Creating a branch fetches the default branch first and fails if `origin` cannot be reached.

Pull requests come from the `gh` CLI (`gh pr list` / `gh pr view` in the repository); when `gh` is missing, signed out, or `origin` is not on GitHub, the picker still lists branches and shows the reason. PRs from forks are listed but cannot be checked out. Listing never runs `git fetch`.

Worktree projects are ordinary projects: they sit alongside every other project in the sidebar and project select, marked with a ⑂ badge naming the project they were created from (or "removed project" once that one is gone). The picker is available from a worktree project too, so a session can start in another branch of the same repository; the new worktree still belongs to the original project. The project menu’s **New conversation** action opens the start page with that project selected. Removing one from its `⋯` menu offers to also delete the worktree folder (`git worktree remove`), and deletes the local branch too when it is fully merged into the default branch (`git branch -d`, never `-D`). Uncommitted changes make git refuse; **Remove anyway** forces it. A worktree folder that has already disappeared is pruned from git and the project is removed.

### Scripts

**Settings** (bottom of the sidebar) has a *Scripts* section: shell commands Portal runs on the host before certain actions. The first is **Before deleting a worktree**: when a worktree folder is about to be removed (from the project's `⋯` menu or by Talk to Portal), the command runs first in the project's folder (inside the worktree) with your `$SHELL` and environment, with `PORTAL_WORKTREE_PATH`, `PORTAL_REPO_ROOT`, and `PORTAL_BRANCH` set to what is about to go, so a build tool's caches can be cleaned while the folder still exists. Each script has a timeout (default 5 minutes) and a choice of what a failure means: **Stop and keep the worktree** shows the script's exit code and last lines of output in the remove confirmation, while **Carry on and delete anyway** logs the failure and deletes. **Remove anyway** after git refuses a dirty tree runs the script again. An empty command turns a script off; a folder that has already disappeared skips it. When Talk to Portal removes a worktree, the script gets at most four minutes so the tool call can finish. The settings dialog itself is organised into sections (Git actions, Talk to Portal, Scripts) in a left-hand list, or a dropdown on small screens, and reopens on the section last viewed in that browser.

### GitHub panel

Open the **GitHub inspector** from the branch icon in the header. It appears beside the conversation on wide screens and in a sheet on smaller screens. For a project inside a git repository, it shows the checked-out branch, how far it is ahead of and behind its `origin` upstream (or that it is not published), and the commits on the branch since it left its base: the pull request's base branch when the branch has a PR, else the default branch (`origin/HEAD`, falling back to `main` then `master`). The last row is the merge-base commit; **Load older** pages further back into the base's history (a branch with more than 200 commits of its own pages through those first), and on the default branch or a detached HEAD the log is simply HEAD's history. The branch's pull request (open, closed, or merged) comes from `gh pr view`, with its review decision, unresolved review threads, conversation comments, and CI checks from the PR's status rollup; when `gh` cannot answer the panel says why and everything else still shows. The panel also reports whether the branch would merge cleanly into its base: `git merge-tree --write-tree` (git 2.38 or newer) merges in memory against `origin/<base>` without touching the working tree and names the conflicting files, falling back to GitHub's own mergeability verdict on older git.

The inspector shows the base branch and added/deleted line totals with a changed-file count. **PR changes** are GitHub's published totals; **Branch changes** compare committed local changes with the merge base and exclude uncommitted edits. Missing comparison data is left unavailable. The PR title opens GitHub, and **Copy PR link** copies its URL without leaving Portal. Merge conflicts, review items, and checks each have a status row and a labeled action; unavailable actions stay visible but disabled. **Investigate** and **Summarize** prepare a new-conversation draft for you to send. General conversation comments remain informational and do not enable the review action on their own.

Portal runs `git fetch origin --prune` for the repository only while the panel is open, at most once every 20 seconds, and on demand from **Refresh**; the panel shows when the last fetch ran or why it failed. **Pull** runs `git pull --ff-only` in the project's checkout and never merges or rebases: a diverged branch or uncommitted changes to the files being updated make git refuse, and the panel shows git's message. gh answers are cached for a minute per branch; a fetch or pull refreshes them. Credentials embedded in a remote URL are stripped from any git message the panel shows.

Click **Show terminal** in the top-right corner of an open session to open that session's terminals below the chat and message box. Drag the divider to resize the panel; **Hide terminal** or **Hide** closes the panel while commands keep running. On touch screens, a small key row provides Esc, Tab, Ctrl+C, and command-history arrows.

- Terminals belong to a session, except on the standalone terminal page (below). Opening the panel for the first time creates one tab; **+** adds more. Every tab is its own process started in the session's directory with the host's `$SHELL` as a login shell, with its usual configuration and environment.
- `cd` inside a terminal changes nothing about the session: the agent keeps working in the session's directory, and new sessions always start in their project's folder (or in the chosen worktree's).
- Switching sessions or hiding the panel leaves the processes running; reconnecting restores each tab's screen and up to 2,000 scrollback lines. A tab ends when you close it with **×**, when its shell exits (the output stays and **Start new shell** restarts it in the same directory), or when the server stops.
- All viewers of a tab (other browser tabs, other devices) see the same terminal. The most recently focused/resized view sets its dimensions. Closing a tab on one device closes it everywhere.
- The start page has no terminal.

### Standalone terminal

**Terminal** in the sidebar, under Portal's views, opens a terminal page at `/terminal` that belongs to no session or project: the terminal panel fills the main column instead of a chat, with the same tab strip, mobile key row, and shared view across devices. Shells start in the host user's home directory with `$SHELL` as a login shell. These terminals are durable in the same way session terminals are: leaving the page (or closing the browser) leaves them running, and coming back reattaches every tab. A tab ends only when you close it with **×**, when its shell exits, or when the server stops; deleting sessions never touches them. The page has no GitHub inspector and no aurora.

Terminals use `node-pty`, `@xterm/xterm`, xterm's headless/serialization and fit addons, and `react-resizable-panels`. Socket.IO carries ordered input, output, resizing, and automatic reconnection over one WebSocket per tab, attached to the server at `/api/shell/socket` and reached through the web app's proxy like every other API path. The PTYs live in the server process, so restarting the web app (or rebuilding it) leaves every terminal running; restarting the server ends them.

Hosts currently support macOS and Linux. Each tab's directory and branch are tracked by reading its root shell process (`lsof` on macOS, `/proc` on Linux) about once a second, but only while a viewer is attached; nested shells, tmux panes, and remote SSH directories are not followed. Branch tracking reads `.git/HEAD` directly (following worktree pointers) instead of spawning `git`, so it is cheap to poll: each open session's branch and directory status refresh about once a second over its event stream. Detached HEADs show the abbreviated commit.

As with the agent APIs, terminals are intended for this personal Portal instance over localhost or a trusted private network. They run as the Portal host user; all connected devices share control. Every endpoint that changes something (projects, filesystem, terminals, and session creation, prompts, settings, permission answers, reconnects, and deletion) rejects cross-origin browser requests, and the folder browser lists directories only. `pnpm install` builds/prepares the native PTY dependency, including a workaround for its macOS prebuild executable permissions.

## Talk to Portal

Portal is the app's home: **Chat** in the sidebar (or the Portal mark above it) opens `/` with one conversation with Portal's own assistant, and **Goals** (`/goals`), **Activity** (`/activity`), **Memory** (`/memory`), and **System** (`/system`) are its other views, each its own page with its own title; the live status line and **Run now** sit on Chat. It belongs to no project or session: ask it to set up work ("review PRs 12 and 14 on the monorepo" fetches each PR, checks its branch out into a worktree, starts a session there with your stored review prompt, and tracks the result), ask what needs your attention, or ask about projects, sessions, branches, and pull requests. It answers briefly and delegates code work to sessions; it is an assistant, not a coding agent, though it can run shell commands and read files on the host.

The assistant runs on the [Vercel AI SDK](https://ai-sdk.dev) directly, not through ACP, so it is model agnostic. **Settings** has a *Talk to Portal* section for the provider (OpenAI or Anthropic), model (default `gpt-5-mini`), and an API key per provider. Keys are stored in Postgres encrypted with `server.key` (AES-256-GCM), never sent to the browser, and never returned by the assistant's tools. Without a key for the chosen provider the page shows **Add API key**, which opens that settings section, and nothing runs.

It also checks on things periodically: every 10 minutes while a browser has Portal open, every hour otherwise (both configurable in the same settings section, and **Run now** in the page header runs a check immediately). A check first gathers state without the model: every session's activity, pull requests across all of GitHub that you authored or were asked to review (via `gh`, updated in the last 14 days, whether or not the repository is a Portal project; the same window applies when you ask for the list, unless you ask for older ones too), worktree branches that have merged, and project folders that went missing. It diffs that against the previous check; when nothing changed the model is not invoked. Otherwise the model receives the changes as one compact digest and turns them into **items**: cards in the thread under a *Needs you* or *Ideas* badge with buttons such as **Open PR**, **Open session**, or **Ask Portal**, plus resolve, snooze, and dismiss. Your own PRs get one item each naming what is wrong (changes requested, failing checks, conflicts); review requests are grouped into one item per repository. Items are keyed by a stable fingerprint so the same condition is updated rather than re-filed, and are resolved when the condition clears. A check that surfaces something posts a short note to the thread, labelled as a scheduled check; quiet checks post nothing.

Everything it keeps lives in Postgres: the thread, items, watches (tracked requests such as a set of reviews), the last snapshot, recent check reports, and its memory, a plain-text note the assistant reads on every turn and appends to when you tell it to remember something. Ask it to forget something, or replace the note with `PUT /api/portal/memory` (`{"memory": "..."}`) to correct what it believes.

## Layout

pnpm workspace; run everything from the root.

- `apps/web` (`@portal/web`) — the Next.js 16 UI. It has no API routes of its own; `next.config.ts` proxies `/api/*` to the server. `src/components/Chat.tsx` is the app shell (session list, project selection, `SessionPane.tsx` or `TerminalPage.tsx`), mounted once by `src/app/(portal)/layout.tsx` for `/`, `/sessions/[id]`, and `/terminal`; `Conversation.tsx` renders messages, activity, Markdown, and diffs; `ChatComposer.tsx`, `SessionControls.tsx`, `Sidebar.tsx`, `StartPage.tsx`, `SettingsDialog.tsx`, `PortalPage.tsx`, and `TerminalPanel.tsx` / `TerminalView.tsx` are the other main surfaces; `src/components/ui/` holds the local shadcn components. `src/lib/` keeps browser-only helpers (drafts, pins, session groups and routes, the xterm client) and one-line re-exports of `@portal/contracts` and `@portal/shared`.
- `apps/server` (`@portal/server`) — Fastify 5 on Postgres (Drizzle and postgres.js), the owner of all state. `src/index.ts` boots it; `src/app.ts` builds the app, runs migrations and the one-time import, and creates one service per domain in `src/sessions`, `src/projects`, `src/settings`, `src/terminals`, and `src/orchestrator`, each with a `service.ts` and a `routes.ts`. `src/db/schema.ts` is the schema and `drizzle/` its migrations; `src/import/` is the legacy import; `src/lib/` holds the ACP runtime and agent registry, worktrees and GitHub summaries, git info, the script runner, and Talk to Portal's runtime, digest, and tools.
- `packages/contracts` (`@portal/contracts`) — wire types both sides use: sessions, projects, and events (`types`), terminals (`shell-types`), git info, and Talk to Portal (`orchestrator`).
- `packages/shared` (`@portal/shared`) — pure logic both sides run: settings and scripts defaults and merging, the transcript reducer, branch and PR ranking for the worktree picker, agent activity, and git info comparison. No Node imports, so the browser can load it.

The server's HTTP surface keeps the URLs the old app had: `/api/agents`, `/api/projects/**` (including `branches`, `pulls/:number`, `github`, `github/log`, `github/pull`, `worktrees`, and `removed`), `/api/fs/dirs`, `/api/sessions/**` (`stream`, `:id/events`, `:id/stream`, `attach`, `prompt`, `cancel`, `config`, `permission`, `terminals`), `/api/terminals/**`, `/api/settings`, `/api/portal/**`, and `/api/health`.

## Adding an agent

Install its ACP adapter in `apps/server` and add an entry to `apps/server/src/lib/agents.ts` with a unique ID, display name, executable, arguments, and login instructions. An optional `env` object extends the host environment. Launch commands stay on the server; the browser receives only IDs and names.

Adapters must speak ACP over stdio and support the current text-chat flow. The shared client advertises no optional filesystem or terminal capabilities. Compatible adapters need no changes to the chat UI or session routes.

## Checks

Using Node.js 24 or newer, with Postgres up (`pnpm db:up`):

```sh
pnpm test         # every package: fake ACP processes, real PTYs, a scratch database per server test file; no credentials or model calls
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @portal/web exec playwright install chromium --only-shell  # once, for UI checks
pnpm test:ui     # production build against a scratch database; synthetic fixtures, no agent calls
```

To run UI checks against an existing Portal, set `PORTAL_UI_BASE_URL=http://localhost:3000`. `PLAYWRIGHT_CHROME=1` uses an installed Google Chrome instead of Playwright's browser. Screenshots and failure traces are written under `apps/web/test-results/`.

## Known limits

- Terminals live in the server's memory, so restarting the server loses them (sessions come back without their terminals).
- Portal keeps its own copy of each transcript in Postgres, including the raw tool inputs and outputs the agent reported (file contents, command output), so anything an agent read is stored there as well as in the agent's own transcript. The database listens on `127.0.0.1:5433` only, with the development password from `docker-compose.yml`; deleting a session removes its log. Sessions started from the `claude` or `codex` CLI are not listed.
- Worktrees are created from the repository's `origin` remote only; repositories without `origin` can still check out local branches but cannot create new ones. Worktrees Portal did not create are reused when their branch is picked but are never deleted by Portal.
- One server per database: a second server started against the same database (say `pnpm dev` in a Portal worktree while the launchd Portal runs) exits at boot with "Another Portal server is already using the database", before it touches any session. Give it its own database with `DATABASE_URL` to run both.
- If an agent process exits, its sessions go offline and are reconnected with `session/resume` when next opened or messaged. Other agents' sessions keep running.
- Talk to Portal needs your own API key and bills per token; it cannot reuse the Claude Code or Codex logins. Pull request checks use the `gh` login on the host, and GitHub's search returns at most a few pages, so a very large backlog is reported as truncated.
- Agent selection is fixed per session. Mode, model, and effort choices are limited to what the agent exposes as ACP config options; login screens and custom-agent configuration UI are not included.
