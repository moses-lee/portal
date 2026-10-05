# Session lifecycle: tracked clutter, worktree retention, rename, background work

Date: 2026-10-04. Status: built on `fix-sessions` the same day (steps 1 to 9), reviewed, live-checked on a scratch instance; merge to main waits for Moses. See "As built" at the end for where the code departs from the plan.

## Why

Three pain points, all about managing sessions:

1. The tracked sessions panel gets cluttered. Finished sessions sit above running ones (the group order is hardcoded that way in `apps/web/src/lib/tracked-sessions.ts:27`), and nothing ever untracks a finished session. On the live instance 26 sessions are tracked, all by the orchestrator, none ever untracked.
2. Worktrees pile up on disk. Portal creates a worktree project per branch and never removes one on its own, except the review-cleanup job. 22 of 24 projects on the live instance are worktrees; 125 of 247 sessions belong to 56 projects already removed by hand.
3. A session reads as "finished" the moment its ACP prompt returns, even while Claude Code or Codex still runs background shells. The process probe only samples sessions with an open turn (`apps/server/src/lib/acp-runtime.ts:1149, 1167`), so the UI, the orchestrator, and the review watch all call it idle.

Plus one missing feature: sessions cannot be renamed, by the user or by the orchestrator.

## Policy on record

Three rules. Nothing else is deleted automatically.

| # | Rule | Mechanics |
|---|---|---|
| 1 | **A tracked session is untracked 48 hours after it goes idle.** | Every session carries `idle_since`. It is set when the session has no open turn, no pending approval, and no background work; it is cleared when any of those starts. The sweep untracks when `idle_since` is older than `tracked.untrackAfterHours` (default 48). Untracking hides nothing and deletes nothing. |
| 2 | **A worktree project is removed 72 hours after it goes idle, if its tree is clean and it is not pinned.** | A project is idle when every one of its sessions is idle; its clock is the newest `idle_since` among them (or `created_at` when it has no sessions). After `worktrees.removeAfterHours` (default 72) the sweep removes it through the existing removal path: the pre-delete script runs, `git worktree remove` without `--force`, `git branch -d` only if merged, and its sessions move to Removed with transcripts intact. Guards that make it wait: a dirty tree, a pinned project, a session with an open Portal terminal, a session that is not idle. A waiting project shows why in the sidebar. Only projects Portal created (`worktree` set) are ever swept; folders the user added are never touched. |
| 3 | **Removed is emptied by hand.** | Settings gets a *Data* section with *Delete removed sessions*, which permanently deletes every session whose project is gone. "Delete all sessions" may come later. |

Both durations are settings. The sweep runs every 5 minutes inside the server regardless of whether a browser is open or the orchestrator is enabled. The first sweep after the upgrade clears the current backlog; Moses accepted that.

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | Session expiry | None. Sessions in live projects stay forever. (A trash state and per-session timers were discussed and dropped: sessions are cheap rows; worktrees and the tracked list are the problem.) |
| 2 | Pins | Project pins move to the server (`projects.pinned_at`) because rule 2 depends on them. Each browser pushes its existing project pins once after the upgrade. Session pins stay in the browser; they only affect ordering. |
| 3 | Worktree guards | Clean tree is enough. Unpushed commits survive on the local branch because the branch is only deleted when merged; only the folder goes. |
| 4 | Activity | Means Portal's own events: prompts, agent output, turn end, permission answers, background task start/finish. Work done in the folder from a terminal outside Portal is invisible; the clean-tree guard protects it. A session with an open Portal terminal blocks removal. |
| 5 | Dirty tree | Not forced. The project waits, the sidebar row says "kept: uncommitted changes", the refusal is logged to Activity. No Needs-you item. |
| 6 | Tracked group order | Needs approval, stalled (hung/offline), working, background, connecting, finished. Finished sorts by turn end (`turn_ended_at`, revisiting decision 17 of the tracked spec). |
| 7 | Rename | A user rename via `PATCH /api/sessions/:id {title}` and an inline editor. The orchestrator gets `rename_session` (chat turns only, ungated since reversible) and a `title` input on `create_session`. No background renaming. Precedence by `title_source`: `user` > `portal` > `agent` > `prompt`; a lower source never overwrites a higher one. |
| 8 | Background visibility | Advertise JetBrains' AIR `asyncTasks` capability to both adapters, accept its update kinds past the SDK's strict parser, add a `background` liveness state. Keep probing the Claude CLI's children between turns as a cross-check. Subagent child sessions wait for the ACP subagents RFD to reach the adapters. |
| 9 | One state function | The three derivations (server `deriveLiveness`, shared `agentActivity`, web `trackedState`) collapse into one shared function; the sidebar dot and the tracked badge show the same thing. An offline link with no error is "finished", not "needs attention". |
| 10 | Needs-you strip | Moved out of the message scroller to a sticky header on the Chat view, since it currently sits above the oldest loaded message and is never seen. |
| 11 | Small fixes | The orchestrator's `delete_session` closes the session's terminals (the HTTP route does, the tool does not). Removed-project records that reach zero sessions are dropped, as `Chat.tsx:343` already claims. |
| 12 | Settings home | A new *Sessions* settings section holds `tracked.untrackAfterHours` and `worktrees.removeAfterHours`; a new *Data* section holds *Delete removed sessions*. General settings (`packages/shared/src/settings.ts`), not orchestrator settings. |

Decision 10 is superseded (2026-10-04): the Needs-you strip left the Chat view for its own *Needs your attention* page (`/attention`).

## Server

### Data

Migration `0013_session_lifecycle.sql`:

| table | column | type | notes |
|---|---|---|---|
| `sessions` | `idle_since` | bigint, nullable | ms epoch; null while the session is doing anything |
| `sessions` | `turn_ended_at` | bigint, nullable | ms epoch of the last `turn_end`; drives the finished sort |
| `sessions` | `title_source` | text, not null, default `'prompt'` | `prompt`, `agent`, `user`, `portal` |
| `projects` | `pinned_at` | bigint, nullable | ms epoch; set means pinned |
| `projects` | `kept_reason` | text, nullable | why the last sweep kept an otherwise due worktree; cleared when the guard clears |

Backfill in the same migration: `idle_since = last_active_at` and `turn_ended_at = last_active_at` for every session, so the first sweep has clocks to read. Sessions with `title` set keep `title_source = 'prompt'`; the agent's next `session_info_update` may still improve on it (agent outranks prompt).

### Idle tracking (`lib/acp-runtime.ts`)

One function, `settleIdle(session)`, runs after every change to `busy`, `pendingPermissions`, or the background task set:

- idle = `!busy && pendingPermissions.size === 0 && backgroundTasks.size === 0`
- entering idle: `idle_since = now`, persist, announce
- leaving idle: `idle_since = null`, persist, announce

`turn_ended_at` is written where `turn_end` is emitted (lines 918, 926, and the cancel/failure paths). `lastActiveAt` keeps its meaning (last user prompt) so existing ordering does not change.

After a server restart every session comes back offline with no turn. `idle_since` survives in the row, so clocks do not reset on restart. A `session/resume` that finds the agent still busy (Codex can) clears it again.

### Background tasks

`acp-runtime.ts:631` advertises:

```ts
clientCapabilities: {
  session: { configOptions: { boolean: {} } },
  _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } },
}
```

The SDK's `zSessionNotification` is a closed union and drops unknown `sessionUpdate` kinds, so Portal registers `session/update` with `conn.onNotification(method, permissiveParser, handler)` (`@agentclientprotocol/sdk` `acp.js:910`) and validates known kinds itself. New kinds handled: `async_task_spawned`, `async_task_progress`, `async_task_state_update`. Each task has an id, a type (`shell` today), a title, and a terminal state. `session.backgroundTasks: Map<id, { title, startedAt }>` is in memory and in `SessionState` so it survives list snapshots; spawn and finish are logged as `update` events so the transcript shows them.

Liveness (`lib/liveness.ts`): `LivenessState` gains `background`. `deriveLiveness` returns it when no turn is open and `backgroundTasks.size > 0`; summary `"N background tasks running"` and the task titles in `livenessDetail`. The probe timer samples sessions that are busy **or** have background tasks, with `turnStartedAt` replaced by the earliest task start, so the Claude CLI's child processes are listed between turns as a cross-check. `isStall` is unchanged. Stopping a task: `POST /api/sessions/:id/tasks/:taskId/stop` calls the adapter's `_session/async_task/stop`.

What this does not cover, on record: Claude background subagents already hold the ACP prompt open (the adapter defers `session/prompt` until the subagent finishes), so they show as busy today. Codex collab subagents and the ACP-native `subagent_update` wait for the adapters to ship the merged RFD.

### Unified state (`packages/shared/src/session-state.ts`)

```ts
export type SessionState =
  | "approval" | "hung" | "offline" | "connecting" | "working" | "background" | "finished";
export function sessionState(s: { busy; awaitingPermission; link; liveness }): SessionState;
```

Order of precedence: approval, hung, offline (liveness `dead`, or an offline link **with** an error), connecting, working, background, finished. `agentActivity` and `trackedState` become thin wrappers or are deleted; the sidebar dot uses the same function, so a hung session finally shows as hung there.

### Sweep (`lib/lifecycle-sweep.ts`)

Owned by the sessions service, not the jobs worker, so it runs without the orchestrator. `setInterval` every 5 minutes, unref'd, first run 60 seconds after boot, guarded against overlap, with a `runLifecycleSweep()` export for tests and a manual trigger.

Pass 1, tracked (rule 1): for each `tracked_sessions` row whose session has `idle_since <= now - untrackAfterHours`, call `tracked.untrack(id, "portal", "idle for 48h")`. Logged to Activity as today.

Pass 2, worktrees (rule 2): for each project with `worktree` set and `pinned_at` null:

1. sessions = all sessions with that `project_id`
2. skip if any session has `idle_since` null (not idle) or an open terminal (`terminals.registry` by session id)
3. `clock = max(sessions.map(idle_since)) ?? project.created_at`; skip if `clock > now - removeAfterHours`
4. `worktreeState(project)`; if dirty, set `kept_reason = "uncommitted changes"`, announce the project, log once (not every 5 minutes: only when the reason changes), continue
5. remove via the same `deleteWorktreeFolder` + `removeProject` path the HTTP route uses (`projects/routes.ts:352`), with the pre-delete script, no force, `deleteBranch: "merged"`. Sessions stay and become Removed. Clear `kept_reason`. Log `worktree.removed_idle` to Activity.
6. if git refuses anyway (race), set `kept_reason` to git's message and carry on

Sessions of a removed project are inert as today (they can still be opened; nothing new there). Rule 3's button deletes them for good.

The existing `jobs/review-cleanup.ts` keeps its behaviour; rule 2 is the general case that also catches review worktrees it left behind.

### Rename

- `PATCH /api/sessions/:id` body `{ title: string }` (1 to 120 chars, trimmed). Origin-checked like every mutation. Sets `title`, `title_source = "user"`, persists, fires `linkListeners` and `announce` so both the per-session `meta` and the list `updated` patch carry the new title. `SessionListPatch` already has `title`.
- `session_info_update` (`acp-runtime.ts:555`) applies only when `rank(title_source) <= rank("agent")`, i.e. not over `user` or `portal`.
- Runtime API gains `setTitle(id, title, source)`.

### Pins

- `PATCH /api/projects/:id` accepts `{ pinned: boolean }` alongside `name`. `Project` gains `pinnedAt: number | null`.
- Project ordering on the web uses the server field. The browser's `portal.pins.projects` entry is pushed once (`PATCH` per pinned id) the first time the app loads with a server that reports `pinnedAt`, then the local key is deleted. Session pins are untouched.

### Settings

```ts
sessions: {
  tracked: { untrackAfterHours: number };   // default 48, 1..720
  worktrees: { removeAfterHours: number };  // default 72, 1..720
}
```

Merged and clamped in `packages/shared/src/settings.ts` like `orchestrator.stalls`. `DELETE /api/sessions/removed` deletes every session whose `project_id` has no `projects` row and drops the `removed_projects` records; returns the count. It goes through the runtime's `deleteSession` so terminals close and the `deleted` list events fire.

### Orchestrator

- `rename_session { sessionId, title }`: sets `title_source = "portal"`, logs `session.renamed` to Activity, returns the row. In the `sessions` tool group, chat turns only. Not in `GATED_TOOLS` (reversible; "Autonomy follows reversibility").
- `create_session` gains optional `title`; when given, the session is created with `title_source = "portal"` so the first prompt does not overwrite it.
- Prompt (`orchestrator/prompt.ts`): "Name sessions you start for what they are for (title on create_session); rename a session when its title no longer says what it does (rename_session). Never rename a session the user named."
- World (`world/render.ts`): the `background` state renders as `"turn ended, N background tasks running"` and is listed under "Sessions needing you or working". The idle suffix stays "turn ended, waiting on a reply". `digest.ts` emits `session_finished` only on the transition to idle with no background tasks, so the review watch and intent checks stop firing early.
- `list_active_sessions` includes `background`.
- `delete_session` closes terminals (decision 11).

## Web

### Tracked panel

- `trackedGroupOrder = ["approval", "stalled", "working", "background", "connecting", "finished"]`, badge tone for `background` (violet, like working, with a task count).
- Within `finished`, sort by `turnEndedAt` desc, falling back to `lastActiveAt`. Other groups keep `lastActiveAt` desc.
- Row subtitle for a finished tracked session: "untracks in 1d 3h" from `idleSince + untrackAfterHours`, so the policy is visible before it acts.
- `trackedAttentionCount` counts approval and stalled only, not finished.

### Sidebar

- Worktree project rows show "removes in 2d" (from the project clock) when due within 7 days, or "kept: uncommitted changes" when `keptReason` is set. Pinned projects show neither.
- Status dot from `sessionState`; `hung` and `background` get their own tones.
- Session `⋯` menu gains **Rename** using `RenameField` from `ProjectActions.tsx` with an `ariaLabel` prop. `SessionHeader` title becomes editable the same way.
- Project `⋯` menu's Pin writes to the server; the one-time pin migration runs in `useProjects`.

### Settings dialog

- *Sessions* section: two number inputs with hour units and the defaults as placeholders.
- *Data* section: *Delete removed sessions* with the count from `GET /api/projects/removed`, an inline confirm, and the result.

### Needs-you

`PortalNeedsYou` moves out of `MessageScrollerContent` to a sticky slot above it in `PortalThread.tsx`, collapsed by default when it holds more than 5 items.

## Implementation order

1. Contract types, migration 0013 with backfill, `title_source`, `idle_since`, `turn_ended_at`, `pinned_at`, `kept_reason`; store and runtime plumbing; `settleIdle`. Tests for the stores and for idle transitions.
2. Unified `sessionState` in `packages/shared`; replace `agentActivity` and `trackedState` call sites; sidebar dot and tracked badge agree. Tests.
3. Settings section types, defaults, merging; routes. Tests.
4. Sweep: pass 1 and pass 2, Activity entries, `kept_reason`, manual trigger. Tests with fake clocks and a fake worktree state.
5. Rename: route, runtime `setTitle`, precedence in `session_info_update`, orchestrator tool and `create_session.title`, prompt line. Tests.
6. Pins on the server, project PATCH, browser migration. `DELETE /api/sessions/removed`. `delete_session` terminals fix. Removed-project zero-session cleanup.
7. Background tasks: AIR capability, permissive notification parser, task map, `background` liveness, probe between turns, stop route, world and digest wording. Tests with a fake adapter emitting the AIR kinds.
8. Web: tracked order and sort, countdown subtitles, sidebar countdown and kept reason, Rename UI, Settings sections, Needs-you sticky.
9. Live check on a scratch instance against a cloned DB (see the e2e recipe): a Claude session running `sleep 300 &` through background Bash shows `background` and flips to finished when it ends; a Codex session doing the same; rename from the sidebar and from the orchestrator; a worktree with a dirty tree is kept and shows why; one with a clean tree is removed and the pre-delete script runs; the tracked list untracks on schedule with the setting lowered to 1 hour.

Commit per step as it lands green; merge to main waits for Moses. The live instance needs a restart for migration 0013 and the new tools.

## Out of scope

- Session expiry, trash, per-session timers, "delete all sessions".
- Subagent child sessions over ACP (`subagent_update`, AIR `nativeSubagentSessions`) until the adapters ship them against an SDK that accepts the capability.
- Routing agent shells through ACP `terminal/*` (neither adapter uses client terminals).
- Watching folder activity outside Portal.
- Proactive background renaming by the orchestrator.
- Session pins on the server.

## As built (2026-10-04)

Everything above landed. Where the code departs from the plan:

- **SDK parser.** `onNotification` with a custom parser is not enough: SDK 1.5.0's client installs a session-update router in its constructor that rejects unknown `sessionUpdate` kinds before any handler runs. `lib/air-tasks.ts` renames `async_task_*` messages to a Portal-local method (`_portal/air_session_update`) on the way in; standard kinds still go through the SDK's schema.
- **Background tasks** live on `SessionMeta`, the list `updated` patch and `SessionLiveness` as `{ id, title, taskType, startedAt, canStop }[]`, not on `SessionState`. Every announced task type blocks idle, not only `shell` (Claude also announces monitors, MCP tasks and workflows); revisit if a long monitor keeps a worktree alive. The stop route answers `{ stopped }` and 409 when the agent had nothing to stop. `deleteSession` asks the agent to stop its tasks first.
- **Sweep safety.** Projects and sessions are re-read right before each removal and again after the pre-delete script; projects sharing one worktree folder (a root and a subfolder project) are judged and removed as a group; a failed keep that is not a dirty tree is not retried until the project's clock moves; an unreadable `git status` keeps the project; the sweep aborts between projects on shutdown. A project held only by an open terminal shows "kept: open terminal". A worktree project whose folder is already gone is removed from the list (git prunes the registration; the branch is left alone unless merged).
- **Restores restart the clock.** `projects.revived_at` (added to migration 0013) floors the project clock, so a worktree restored from Removed is not swept again five minutes later.
- **Untrack clock** is `max(idle_since, tracked_at)`, so tracking an old finished session gives the full window from that moment. Idle untracks log as `system`.
- **Boot.** A turn cut off by a restart is dated from its last stored event, not the boot time; migration 0013 does not backfill rows with an open turn. Nothing on `session/resume` says whether the agent is still busy; the clock reopens when a background task is announced.
- **Rename** answers the full session JSON (the same as GET). `setTitle` rejects when the write fails. A user rename holds against the agent's next `session_info_update` (verified with Codex live).
- **Pins.** Re-pinning keeps the original `pinnedAt`. There is no project event stream, so pin and `keptReason` changes reach other browsers on their next project refetch.
- **Web.** The Needs-you strip renders nothing at zero items. The session header reads liveness and task titles from the list entry (the per-session `meta` event carries neither). The lifecycle hour inputs are text fields with numeric input mode so a browser-unparsable value cannot silently save the default.
- **Settings fix on the side.** Stored `orchestrator.stalls.hungAfterMinutes` and `orchestrator.reviews.answerReadOnly` were dropped on every Postgres read before this branch; the parser now keeps them.

Live check (scratch server on a cloned database with every real path rewritten): Claude and Codex sessions both reported `background` with their shell task while the turn was over and flipped to finished when it ended; the user rename held against Codex's own title; the orchestrator renamed a Portal-titled session and refused a user-titled one; with both clocks at 1 hour the sweep untracked 26 sessions, removed the clean worktree (pre-delete script ran, merged branch deleted), kept the dirty one with "uncommitted changes" logged once, and left the one with a running background task alone; a second sweep changed nothing; the purge deleted 191 removed sessions and dropped their records.

