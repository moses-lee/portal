# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
Next.js app that runs Claude Code and Codex through local ACP adapters and streams sessions to the browser.

## Run

Requires Node.js 24 or newer and a macOS or Linux host.

```sh
pnpm install
pnpm dev          # binds 0.0.0.0:3000 so it is reachable over Tailscale
pnpm prod         # production build, then serve it on the same port
```

`pnpm prod` runs `next build` and then `pnpm start` (the custom server in production mode). It clears the variables `next dev` sets on its own process first, so it also works from a terminal opened inside Portal; stop the dev server before running it, since both use port 3000.

Open `http://localhost:3000` or `http://<tailscale-ip>:3000`. Sessions belong to **projects**: folders you add once and Portal remembers. On the start page, choose a project and agent, then send your first message or choose **Start an empty conversation**; the sidebar groups sessions under their projects, most recently active first, titled by their first message. The **New conversation** action in the header returns to the start page.

**Pin** a project from its `⋯` menu, or a session from its own `⋯` menu, to keep it at the top: pinned projects lead the sidebar and the start page's project dropdown (most recently pinned first), and pinned sessions lead their project's group (still most recently active first among themselves). Pins are a per-browser preference kept in localStorage, so each device keeps its own; pins for deleted sessions and removed projects are forgotten. A session row shows a pulsing dot while its agent is working and a steady, brighter one while the agent waits for someone to answer a permission prompt; a collapsed project shows the same dot when any of its sessions is in that state. The sidebar follows every session live, so a turn started or answered from another device shows up without a reload. Each session keeps its original agent and starting directory for its whole life. Every session has its own URL (`/sessions/<id>`), so refreshing, sharing the link on your network, or using the browser's back button lands on the same conversation.

Sessions and their transcripts are saved under `~/.portal/sessions` and survive restarts: after Portal starts again, every session is listed, its history opens straight from disk, and the agent is reconnected in the background (ACP `session/resume`, so the agent picks up its own transcript without replaying it). While that runs, a bar under the transcript says *Connecting…*; if the agent cannot be reached it says why and offers **Reconnect**, and sending a message retries automatically. A turn that was running when Portal stopped is closed with a note. Terminals are not restored. Opening a session loads only its latest turns; scroll up (or press **Load earlier messages**) to fetch more, a page at a time. Delete a session from its sidebar `⋯` menu; that removes its transcript from Portal, closes its terminals, and asks the agent to close its side.

The branch and working directory appear once below the composer. Click them for the full values and copy actions. Session rows use provider logos, two-line titles, and a separate actions menu. Search conversations, drag the sidebar divider to resize it, or hide it with the sidebar toggle; width and visibility are remembered in this browser. On mobile, navigation opens in a sheet with keyboard focus handling.

Sign in on the machine running Portal before creating a session:

- **Claude Code:** run `claude` and complete sign-in.
- **Codex:** run `codex login`. The ACP package includes a compatible Codex binary; `CODEX_PATH` can override it when needed.

Portal uses the agents' existing credentials. The compact model/mode control in the composer opens **Agent settings**, with model, mode, effort, and boolean options driven by whatever the agent announces over ACP. Agents without options show none. Typing `/` in the message box autocompletes the agent's slash commands and skills. Tool permission requests appear inline in the chat and any connected viewer can answer them; **Stop** cancels pending prompts along with the turn. Portal does not override agent sandbox defaults.

Drafts survive session switches and reloads within the same browser tab. Sending clears a draft only after the server accepts it; a failed request leaves it available to retry. Edits made while a send is in flight are preserved. Conversations follow streamed responses until you scroll away; **Jump to latest** resumes following. Tool calls, reasoning, and plans are grouped into expandable activity, with inline approvals, highlighted code, copy actions, and readable diffs.

The dark interface uses local [shadcn components](https://ui.shadcn.com/docs/components), including Message, Bubble, and Message Scroller. Glass surfaces use CSS blur and translucency. The CSS aurora is adapted from the [shadcn.io Aurora](https://www.shadcn.io/background/aurora) visual: violet at rest, blue/violet while working, amber for approval, and rose for errors. Status text accompanies every state. Animation pauses in hidden tabs and respects reduced-motion preferences; reduced-transparency preferences use solid surfaces. Local provider marks come from Wikimedia ([Claude](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg), [ChatGPT](https://commons.wikimedia.org/wiki/File:ChatGPT-Logo.svg)).

## Projects and terminals

**Add project** in the sidebar or on the start page opens a folder browser (or takes a typed path such as `~/repos/portal`). Projects are stored in `~/.portal/projects.json` (set `PORTAL_HOME` to move the directory); each project is exactly one folder, stored as its resolved real path, and the same folder cannot be added twice. Rename or remove a project from its `⋯` menu in the sidebar; removing a project does not touch its sessions, which move to a **Removed projects** group and keep working. If a project's folder disappears from disk, the project stays listed with a *missing* marker until you remove or re-add it, and starting a session or terminal in it fails with a clear error.

### Worktrees

For a project inside a git repository, the start page adds a **Worktree** picker under the project select. **Original** (the default) starts the session in the project folder itself; otherwise pick an open pull request, a recent local or `origin` branch, or type a name to **Create branch** off `origin/<default branch>`. Starting the session then checks the branch out into its own git worktree at `~/.portal/worktrees/<repo>/<branch>` (under `PORTAL_HOME` if set; `/` and other unsafe characters in the branch name become `-`), records it as a project of its own named after the branch, and starts the session there. Worktree projects created by older Portal versions, named `<project> · <branch>`, are renamed to the branch the next time Portal starts, unless the name was changed by hand. Projects whose folder is a subfolder of the repository get the same subfolder inside the worktree. A branch already checked out somewhere (the main checkout or any worktree) is reused instead of duplicated; branches that exist only on `origin` are fetched and set to track it. Creating a branch fetches the default branch first and fails if `origin` cannot be reached.

Pull requests come from the `gh` CLI (`gh pr list` / `gh pr view` in the repository); when `gh` is missing, signed out, or `origin` is not on GitHub, the picker still lists branches and shows the reason. PRs from forks are listed but cannot be checked out. Listing never runs `git fetch`.

Worktree projects are ordinary projects: they sit alongside every other project in the sidebar and project select, marked with a ⑂ badge naming the project they were created from (or "removed project" once that one is gone). The picker is available from a worktree project too, so a session can start in another branch of the same repository; the new worktree still belongs to the original project. The project menu’s **New conversation** action opens the start page with that project selected. Removing one from its `⋯` menu offers to also delete the worktree folder (`git worktree remove`), and deletes the local branch too when it is fully merged into the default branch (`git branch -d`, never `-D`). Uncommitted changes make git refuse; **Remove anyway** forces it. A worktree folder that has already disappeared is pruned from git and the project is removed.

### GitHub panel

Open the **GitHub inspector** from the branch icon in the header. It appears beside the conversation on wide screens and in a sheet on smaller screens. For a project inside a git repository, it shows the checked-out branch, how far it is ahead of and behind its `origin` upstream (or that it is not published), and the commits on the branch since it left its base: the pull request's base branch when the branch has a PR, else the default branch (`origin/HEAD`, falling back to `main` then `master`). The last row is the merge-base commit; **Load older** pages further back into the base's history (a branch with more than 200 commits of its own pages through those first), and on the default branch or a detached HEAD the log is simply HEAD's history. The branch's pull request (open, closed, or merged) comes from `gh pr view`, with its review decision, unresolved review threads, conversation comments, and CI checks from the PR's status rollup; when `gh` cannot answer the panel says why and everything else still shows. The panel also reports whether the branch would merge cleanly into its base: `git merge-tree --write-tree` (git 2.38 or newer) merges in memory against `origin/<base>` without touching the working tree and names the conflicting files, falling back to GitHub's own mergeability verdict on older git.

Portal runs `git fetch origin --prune` for the repository only while the panel is open, at most once every 20 seconds, and on demand from **Fetch**; the panel shows when the last fetch ran or why it failed. **Pull** runs `git pull --ff-only` in the project's checkout and never merges or rebases: a diverged branch or uncommitted changes to the files being updated make git refuse, and the panel shows git's message. gh answers are cached for a minute per branch; a fetch or pull refreshes them. Credentials embedded in a remote URL are stripped from any git message the panel shows.

Click **Show terminal** in the top-right corner of an open session to open that session's terminals below the chat and message box. Drag the divider to resize the panel; **Hide terminal** or **Hide** closes the panel while commands keep running. On touch screens, a small key row provides Esc, Tab, Ctrl+C, and command-history arrows.

- Terminals belong to a session, except on the standalone terminal page (below). Opening the panel for the first time creates one tab; **+** adds more. Every tab is its own process started in the session's directory with the host's `$SHELL` as a login shell, with its usual configuration and environment.
- `cd` inside a terminal changes nothing about the session: the agent keeps working in the session's directory, and new sessions always start in their project's folder (or in the chosen worktree's).
- Switching sessions or hiding the panel leaves the processes running; reconnecting restores each tab's screen and up to 2,000 scrollback lines. A tab ends when you close it with **×**, when its shell exits (the output stays and **Start new shell** restarts it in the same directory), or when Portal stops.
- All viewers of a tab (other browser tabs, other devices) see the same terminal. The most recently focused/resized view sets its dimensions. Closing a tab on one device closes it everywhere.
- The start page has no terminal.

### Standalone terminal

**Terminal** in the sidebar, under **New conversation**, opens a terminal page at `/terminal` that belongs to no session or project: the terminal panel fills the main column instead of a chat, with the same tab strip, mobile key row, and shared view across devices. Shells start in the host user's home directory with `$SHELL` as a login shell. These terminals are durable in the same way session terminals are: leaving the page (or closing the browser) leaves them running, and coming back reattaches every tab. A tab ends only when you close it with **×**, when its shell exits, or when Portal stops; deleting sessions never touches them. The page has no GitHub inspector and no aurora.

Terminals use `node-pty`, `@xterm/xterm`, xterm's headless/serialization and fit addons, and `react-resizable-panels`. Socket.IO carries ordered input, output, resizing, and automatic reconnection over WebSockets; each tab connects with its terminal ID. A small custom Next.js server (`server.mjs`) serves both the app and the terminal transport on port 3000 (or `$PORT`). Use `pnpm dev` / `pnpm start`; invoking `next dev` / `next start` directly does not start the terminal transport. Restart the server after changing its runtime modules.

Hosts currently support macOS and Linux. Each tab's directory and branch are tracked by reading its root shell process (`lsof` on macOS, `/proc` on Linux) about once a second, but only while a viewer is attached; nested shells, tmux panes, and remote SSH directories are not followed. Branch tracking reads `.git/HEAD` directly (following worktree pointers) instead of spawning `git`, so it is cheap to poll: each open session's branch and directory status refresh about once a second over its event stream. Detached HEADs show the abbreviated commit.

As with the agent APIs, terminals are intended for this personal Portal instance over localhost or a trusted private network. They run as the Portal host user; all connected devices share control. Every endpoint that changes something (projects, filesystem, terminals, and session creation, prompts, settings, permission answers, reconnects, and deletion) rejects cross-origin browser requests, and the folder browser lists directories only. `pnpm install` builds/prepares the native PTY dependency, including a workaround for its macOS prebuild executable permissions.

## Talk to Portal

**Talk to Portal** in the sidebar, above **New conversation**, opens a page at `/portal` with one conversation with Portal's own assistant. It belongs to no project or session: ask it to set up work ("review PRs 12 and 14 on the monorepo" fetches each PR, checks its branch out into a worktree, starts a session there with your stored review prompt, and tracks the result), ask what needs your attention, or ask about projects, sessions, branches, and pull requests. It answers briefly and delegates code work to sessions; it is an assistant, not a coding agent, though it can run shell commands and read files on the host.

The assistant runs on the [Vercel AI SDK](https://ai-sdk.dev) directly, not through ACP, so it is model agnostic. **Settings** has a *Talk to Portal* section for the provider (OpenAI or Anthropic), model (default `gpt-5-mini`), and an API key per provider. Keys are stored in `~/.portal/settings.json` (readable by the Portal user only), never sent to the browser, and never returned by the assistant's tools. Without a key for the chosen provider the page shows **Add API key**, which opens that settings section, and nothing runs.

It also checks on things periodically: every 10 minutes while a browser has Portal open, every hour otherwise (both configurable in the same settings section, and **Run now** in the page header runs a check immediately). A check first gathers state without the model: every session's activity, pull requests across all of GitHub that you authored or were asked to review (via `gh`, updated in the last 60 days, whether or not the repository is a Portal project), worktree branches that have merged, and project folders that went missing. It diffs that against the previous check; when nothing changed the model is not invoked. Otherwise the model receives the changes as one compact digest and turns them into **items**: cards in the thread under a *Needs you* or *Ideas* badge with buttons such as **Open PR**, **Open session**, or **Ask Portal**, plus resolve, snooze, and dismiss. Your own PRs get one item each naming what is wrong (changes requested, failing checks, conflicts); review requests are grouped into one item per repository. Items are keyed by a stable fingerprint so the same condition is updated rather than re-filed, and are resolved when the condition clears. A check that surfaces something posts a short note to the thread, labelled as a scheduled check; quiet checks post nothing.

Everything lives under `~/.portal/orchestrator/`: the thread, items, watches (tracked requests such as a set of reviews), the last snapshot, recent check reports, and `memory.md`, a plain-text file the assistant reads on every turn and appends to when you tell it to remember something. Edit it by hand to correct or delete what it believes.

## Layout

- `src/lib/agents.ts` — server-side registry: agent names, launch configurations, and login instructions.
- `src/lib/acp-runtime.ts` — shared ACP runtime. One lazy subprocess per agent, isolated sessions, append-only event logs written through to the session store, agent-announced session state (modes, config options, commands), pending permission prompts, reattaching persisted sessions (`session/resume`, falling back to `session/load` with the replay discarded), and `onSessionsChange` list subscriptions behind `/api/sessions/stream`.
- `src/lib/acp.ts` — runtime singleton preserved across development hot reloads.
- `src/lib/session-store.ts` — the `SessionStore` interface every persistence backend implements (session records plus an append-only, tail-readable event log with dense sequence numbers), and an in-memory implementation used by tests. `src/lib/file-session-store.ts` is the file backend: `~/.portal/sessions/index.json` (atomic rewrites) and `~/.portal/sessions/logs/<id>.jsonl`, read backwards in chunks so the latest page never scans the whole file; `src/lib/session-storage.ts` is its singleton. A cloud backend is another implementation of the same interface.
- `src/lib/session-pages.ts` — turn-aligned pagination over a store: every page starts at a user message so the browser can reduce it on its own.
- `src/lib/session-routes.ts` — the `/sessions/<id>` and `/terminal` URL scheme shared by the router and the sidebar.
- `src/lib/pins.ts` — pinned project and session maps (id → pinned time) and the pinned-first orderings; `src/lib/session-groups.ts` groups sessions under projects for the sidebar; `src/components/usePins.ts` keeps the maps in localStorage.
- `src/lib/types.ts` — shared event, project, and session metadata types.
- `src/lib/projects-store.ts` — persisted project list (`~/.portal/projects.json`, atomic rewrites), including `worktree: {parentId, branch}` metadata for worktree projects; `src/lib/projects.ts` is its singleton. `src/lib/fs-paths.ts` resolves and lists directories for it and for the folder browser.
- `src/lib/worktrees.ts` — branch and PR listing (`git for-each-ref`, `git worktree list`, `gh pr`), worktree creation under `~/.portal/worktrees`, and removal with merged-branch cleanup. `src/lib/branch-matching.ts` ranks picker rows; `src/components/WorktreeBadge.tsx` labels worktree projects with their original project.
- `src/lib/github-summary.ts` — the GitHub panel: branch, upstream, ahead/behind, the commit log relative to `origin/<base>` with paging, the branch's PR via `gh pr view` and a GraphQL count of unresolved threads and comments, the local conflict check (`git merge-tree --write-tree`), throttled and coalesced `git fetch`, and `git pull --ff-only`.
- `src/lib/git-info.ts` — repository root and branch lookup by reading `.git` directly; `src/lib/session-summary.ts` attaches it to sessions for the browser.
- `src/app/api/agents` — `GET` available agents and the default selection.
- `src/app/api/projects` — `GET` list, `POST {path, name?}` add (409 with the existing project on a duplicate folder); `src/app/api/projects/[id]` — `PATCH {name}`, `DELETE` (`?worktree=delete` also removes a worktree project's folder and merged branch; 409 `{error, dirty: true}` when git refuses, `&force=1` overrides).
- `src/app/api/projects/[id]/branches` — `GET` the repository's branches (local and `origin`, default branch excluded), which are checked out where, and open PRs via `gh` (or why `gh` could not answer). `src/app/api/projects/[id]/pulls/[number]` — `GET` one PR in any state.
- `src/app/api/projects/[id]/github` — `GET` the GitHub panel's snapshot `{summary}` for the project's checkout (`?fetch=1` runs `git fetch origin --prune` first, throttled); 409 when the folder is missing or not a git repository. `src/app/api/projects/[id]/github/log` — `GET ?before=<cursor>` one page of older commits `{commits, cursor}`, where `before` is the opaque `cursor` from the summary or a previous page (400 when missing or malformed). `src/app/api/projects/[id]/github/pull` — `POST` runs `git pull --ff-only` and returns the fresh `{summary}`, or 409 `{error}` with git's refusal.
- `src/app/api/projects/[id]/worktrees` — `POST {branch, create?}` finds or creates the worktree for a branch (`create` starts it from `origin/<default>`; a worktree project resolves to its main checkout) and returns `{project}`: 201 for a new worktree project, 200 when one already covers that folder.
- `src/app/api/fs/dirs` — `GET ?path=&hidden=1` lists subdirectories for the folder browser.
- `src/app/api/sessions` — `GET` list (most recently active first, with each session's `title`, `link` connection state, `busy`, and `awaitingPermission`), `POST {projectId, agentId}` create in that project's folder (pass a worktree project's ID to start in its worktree). Omitting `agentId` defaults to Claude Code. `src/app/api/sessions/[id]` — `GET` one session, `DELETE` removes it, its log, and its terminals.
- `src/app/api/sessions/stream` — Server-Sent Events feed of the list: a `snapshot` of every session's `busy`, `awaitingPermission`, `link`, `title`, and `lastActiveAt` on connect (authoritative for which sessions exist), then `created` (with the full list entry), `updated` (those fields), and `deleted` as they happen. The sidebar's activity dots and ordering follow it.
- `src/app/api/sessions/[id]/events` — `GET ?before=<seq>&limit=<n>` one page of the log, oldest first, ending before `before` (default: the newest events) and starting at a turn boundary; returns `{events, hasMore, nextSeq}`.
- `src/app/api/sessions/[id]/stream` — Server-Sent Events tail from `?since=<seq>` (or `Last-Event-ID`); a `reset` event means the gap is no longer in memory and the viewer should refetch a page, `deleted` means the session is gone. `meta` events carry busy state, the agent connection (`link`), title, the directory's current branch, whether the directory still exists, the owning project, and the agent's session state (modes, config options, commands); they are re-sent whenever any of these change. Opening the stream reattaches the agent to a persisted session.
- `src/app/api/sessions/[id]/attach` — `POST` retries that reattachment; the outcome arrives as `meta.link`.
- `src/app/api/sessions/[id]/prompt` — `POST {text}`; returns 202, progress arrives via SSE.
- `src/app/api/sessions/[id]/cancel` — `POST`; cancels open permission prompts, then sends `session/cancel`.
- `src/app/api/sessions/[id]/config` — `POST {configId, value}` or `{modeId}`; forwards `session/set_config_option` / `session/set_mode` and returns the new `{state}`.
- `src/app/api/sessions/[id]/permission` — `POST {requestId, optionId}`; answers a `permission_request` from the event stream (`optionId: null` cancels it).
- `src/app/api/sessions/[id]/terminals` — `GET` list, `POST` create a terminal for the session (409 when its working directory is missing); `src/app/api/terminals` — `GET` list, `POST` create a standalone terminal in the home directory; `src/app/api/terminals/[id]` — `DELETE` closes one of either kind.
- `src/components/Chat.tsx` — the app shell: reads the session (or the terminal page) from the URL, owns the session list and project selection, and renders `TerminalPage.tsx` or `SessionPane.tsx`, which loads the latest page, follows the live stream, fetches earlier pages on scroll while keeping the viewport still, and reduces events into user / assistant / thought / tool / plan blocks one turn at a time. `src/app/(portal)/layout.tsx` mounts the shell once for `/`, `/sessions/[id]`, and `/terminal`. `Sidebar.tsx`, `StartPage.tsx`, `AddProjectDialog.tsx`, and `DirectoryBrowser.tsx` handle projects.
- `src/components/Conversation.tsx` — shadcn message rendering, activity disclosure, Markdown, code copying, diffs, and scroll behavior. `ChatComposer.tsx` owns input interactions; `SessionControls.tsx` owns the settings dialog. `src/components/ui/` contains the local shadcn components.
- `src/lib/drafts.ts` — per-tab draft storage with an in-memory fallback, shared by the start page and active conversations.
- `src/lib/shell-runtime.ts` — one PTY with bounded terminal state, directory tracking, and subscribers; `src/lib/terminals-registry.ts` keeps one per terminal tab, owned by a session or standalone (`src/lib/terminals.ts` is the singleton).
- `src/lib/shell-server.ts` — terminal WebSocket commands, snapshots, live subscribers, and close notifications.
- `src/lib/orchestrator/` — Talk to Portal. `types.ts` is the contract (settings, items, watches, digest, tick reports, the store and runtime interfaces, and the `/api/portal/**` surface); `runtime.ts` runs chat turns and ticks on an AI SDK `ToolLoopAgent` and keeps the scheduler (`scheduler.ts`, intervals chosen by `src/lib/presence.ts`, the count of open Portal event streams); `digest.ts` is the deterministic pre-scan and diff; `tools/` wraps Portal's own modules as compact model tools (a smaller, non-destructive subset for ticks); `github-attention.ts` is the GraphQL search for PRs that concern the user; `store.ts` persists everything under `~/.portal/orchestrator/`. `src/instrumentation.ts` starts the scheduler with the server. `src/components/PortalPage.tsx` and its `Portal*` siblings render the thread, item cards, and the missing-key state; `src/app/api/portal/**` are the routes.
- `src/components/TerminalPanel.tsx` — tab strip over one terminal collection (a session's, or the standalone set behind `TerminalPage.tsx`); `TerminalView.tsx` and `src/lib/shell-client.ts` own xterm and browser I/O for one tab.

## Adding an agent

Install its ACP adapter and add an entry to `src/lib/agents.ts` with a unique ID, display name, executable, arguments, and login instructions. An optional `env` object extends the host environment. Launch commands stay on the server; the browser receives only IDs and names.

Adapters must speak ACP over stdio and support the current text-chat flow. The shared client advertises no optional filesystem or terminal capabilities. Compatible adapters need no changes to the chat UI or session routes.

## Checks

Using Node.js 24 or newer:

```sh
pnpm test         # fake ACP processes and real PTYs; no credentials or model calls
pnpm lint
pnpm build
pnpm exec playwright install chromium --only-shell  # once, for UI checks
pnpm test:ui     # isolated production server; synthetic API/SSE fixtures, no agent calls
```

To run UI checks against an existing server, set `PORTAL_UI_BASE_URL=http://localhost:3000`. `PLAYWRIGHT_CHROME=1` uses an installed Google Chrome instead of Playwright's browser. Screenshots and failure traces are written under `test-results/`.

## Known limits

- Projects and sessions persist under `~/.portal`; terminals live in server memory, so restarting the dev server loses them (sessions come back without their terminals).
- Portal keeps its own copy of each transcript under `~/.portal/sessions/logs`, including the raw tool inputs and outputs the agent reported (file contents, command output), so anything an agent read is stored there as well as in the agent's own transcript. Files are created readable by the Portal user only; deleting a session removes its log. Sessions started from the `claude` or `codex` CLI are not listed.
- Worktrees are created from the repository's `origin` remote only; repositories without `origin` can still check out local branches but cannot create new ones. Worktrees Portal did not create are reused when their branch is picked but are never deleted by Portal.
- Run one Portal instance per `PORTAL_HOME`; two servers writing the same projects and sessions files will overwrite each other.
- If an agent process exits, its sessions go offline and are reconnected with `session/resume` when next opened or messaged. Other agents' sessions keep running.
- Talk to Portal needs your own API key and bills per token; it cannot reuse the Claude Code or Codex logins. Pull request checks use the `gh` login on the host, and GitHub's search returns at most a few pages, so a very large backlog is reported as truncated.
- Agent selection is fixed per session. Mode, model, and effort choices are limited to what the agent exposes as ACP config options; login screens and custom-agent configuration UI are not included.
