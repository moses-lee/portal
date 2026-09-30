# Tracked sessions and the right sidebar

Date: 2026-09-29. Status: spec agreed with Moses, nothing built yet. Branch `feat/tracked-sessions`.

## Why

Moses now uses Portal almost entirely through the orchestrator. The projects/sessions views are rarely opened directly. Two pain points remain:

1. No overview of which agent sessions are in flight or waiting on a reply.
2. Chatting with a session directly means finding it through the projects view and leaving the orchestrator page.

This spec adds an explicit "tracked sessions" set, shared by Moses and the orchestrator, and a right sidebar on the Portal views that lists tracked sessions and opens any of them in a dual view next to the orchestrator thread.

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | Membership | Explicit tracking only. Both Moses and the orchestrator can track and untrack. No recency window, no "orchestrator touched it" inference. |
| 2 | Waiting on a reply | Not stored. A tracked session that is idle and live is by definition waiting on us; a reply flips it to working. No read state, no reply timestamps. |
| 3 | Row content | Title, project, agent logo, state badge, age. Grouped: needs approval, finished, working, connecting, offline/error/hung. |
| 4 | Session view | Not inline. Selecting a row expands the sidebar into a wide dual view (session next to the orchestrator thread) with a back button. Full-screen takeover on mobile. |
| 5 | Panel behaviour | One panel: the list, or the selected session (option a). Expanded width resizable and persisted, default half the shell, orchestrator thread never narrower than ~480 px. List width fixed. |
| 6 | Where it appears | Every Portal view (chat, goals, activity, memory, system). Mobile gets a sheet for the list and a full view for the session. |
| 7 | Needs-you | The session-kind items (`session_finished`, `session_stopped`, `session_waiting`, `session_hung`, `session_offline`) are retired: no longer created, filtered from the strip, and the existing open ones resolved once at boot. |
| 8 | Links | Item actions and thread mentions that open a session open the panel instead of navigating to `/sessions/:id`. |
| 9 | Row actions | Expand, open full page, stop turn, untrack, "ask Portal about this". No hide, no delete from the row. |
| 10 | Orchestrator tools | `track_session`, `untrack_session`, `list_tracked_sessions`. Sessions the orchestrator creates are tracked automatically. The agent may untrack on its own judgment; every track/untrack is logged to the activity view. |
| 11 | Auto-track on manual use | No. A session Moses opens and prompts by hand is tracked only through the toggle. |
| 12 | Liveness in the list stream | Add a compact liveness state to the list stream patch so hung and dead sessions show correctly. |
| 13 | Session list state | Lift out of `Chat.tsx` into a context. |
| 14 | Session view reuse | Extract `SessionPane` logic into a `useSessionStream` hook shared by the full page and the panel. |
| 15 | Connections | A fourth SSE stream per tab is accepted for now. |
| 16 | Perf follow-up | Fix the orchestrator thread's memoization problem from the 2026-09-27 audit on this branch. |
| 17 | Turn-end age | Not added. Rows show the age since the last prompt (`lastActiveAt`). Revisit if the approximation annoys. |

## Server

### Data

New table `tracked_sessions`:

| column | type | notes |
|---|---|---|
| `session_id` | text, PK, FK `sessions.id` on delete cascade | |
| `tracked_at` | bigint | ms epoch |
| `tracked_by` | text | `"user"` or `"portal"` |

Deleting a session removes its row through the cascade, and the runtime's delete path also emits the `tracked` event so open tabs update.

Migration `0012_tracked_sessions.sql` creates the table and resolves every open or snoozed item whose kind is one of the five retired session kinds. The resolve is a one-off cleanup Moses agreed to; the strip would otherwise keep showing stale cards.

### Contract (`packages/contracts`)

```ts
export type TrackedSession = { sessionId: string; trackedAt: number; trackedBy: "user" | "portal" };
export type TrackedSessionsEvent = { type: "tracked"; sessions: TrackedSession[] };
```

`OrchestratorEvent` gains `tracked`. The portal stream sends the full tracked list on connect and on every change (the set is small; a full list is simpler than patches).

`SessionListPatch` gains `liveness: LivenessState` (the five-value enum only, not the full `SessionLiveness` block). The runtime already announces on liveness transitions for the world; the list stream reuses those announcements.

The retired kinds stay in `ItemKind` so old resolved rows still type-check; a comment marks them retired.

### Routes

| Method and path | Response |
|---|---|
| `GET /api/portal/tracked` | `{ sessions: TrackedSession[] }` |
| `PUT /api/portal/tracked/:sessionId` | `{ session: TrackedSession }`, 404 if the session does not exist |
| `DELETE /api/portal/tracked/:sessionId` | 204 |

Both mutations record `trackedBy: "user"` and log an activity entry.

### Orchestrator

Tools, in a new `tracked` tool group and always offered on chat turns:

| Tool | Behaviour |
|---|---|
| `track_session({ sessionId })` | Adds the row with `trackedBy: "portal"`. Idempotent. Accepts id prefixes through `resolveSession`. |
| `untrack_session({ sessionId, reason? })` | Removes the row. The reason goes into the activity entry. |
| `list_tracked_sessions()` | The tracked sessions with their live state: the same row shape as `list_sessions` plus `trackedAt`, `trackedBy`. |

`ops.startSession` and `setup_pr_reviews` track the sessions they create. `delete_session` untracks first so the activity log shows both.

The rendered world gets a "Tracked sessions" section listing each tracked session with its activity, liveness and age, so the agent answers "what are we waiting on" without a tool call. `WorldState` gains `tracked: string[]` so the section and `list_tracked_sessions` agree.

Prompt guidance: track a session when you start one for the user or when the user asks; untrack when the work is done and reported (for example after summarising a finished review into findings); prefer untracking over leaving stale rows. The old guidance to raise `session_*` items goes away.

Item creation: `create_item` rejects the five retired kinds with a message pointing at `track_session`. `review-watch.flagStuck` stops raising `session_waiting` and `session_hung` items; the tracked list shows those states live. `digest.diffSnapshots` and `world/changes.ts` keep recording session transitions in the change log, since the prompt's "Recent changes" section still uses them.

### Activity

New activity kinds `session.tracked` and `session.untracked`, with `refs.sessionId`, the actor (user or portal) and the reason if given.

## Web

### State

- `SessionsProvider` (new, `components/SessionsProvider.tsx`) owns what `Chat.tsx` holds today: the agents list, the `SessionSummary[]` list, the list SSE, `updateSession`, plus the tracked set from the portal stream. `useSessions()` returns `{ agents, sessions, tracked, loading, updateSession, track(id), untrack(id) }`. `Sidebar`, `SessionPane` and the new panel read from it.
- `useSessionStream(sessionId, historyCache)` (new hook, extracted from `SessionPane`) returns `{ history, loading, loadingOlder, error, meta, cursor, loadOlder, send, stop, answerPermission, setConfig, retryAttach, activity, awaitingPermission }`. `SessionPane` becomes a thin layout over it; the panel uses the same hook. Two mounted instances of the hook for one session are supported by the server and by the history cache (last writer wins, harmless).
- The selected panel session lives in the URL as a search param, `?session=<id>`, on any Portal path. `portalLocation`/`portalPath` in `lib/session-routes.ts` learn to keep it. `?session=` restores the expanded panel on reload.
- Preferences: `portal.tracked.open` (`"true"`/`"false"`, default true on desktop), `portal.tracked.width` (expanded width in px, default half the shell at first open, clamped so the main pane keeps 480 px).

### Panel (`components/tracked/TrackedPanel.tsx`)

Rendered by `PortalPage` to the right of the main pane on every Portal view, desktop ≥ 1024 px as a push panel (`border-l`, same shell styling as the GitHub inspector), below that as a right `Sheet`.

Two modes:

- **List** (fixed 320 px). Header "Tracked (n)" with a collapse button. Rows grouped in the order from decision 3 with a small group label. Each row: agent logo, title (fallback: project name plus short id), project name, state badge (`Needs approval`, `Finished`, `Working`, `Connecting`, `Offline`, `Hung`), age since last prompt via `relative-age`. Row click expands. A `…` menu holds: open full page, stop turn (only while working), ask Portal about this, untrack. Empty state explains that Portal tracks sessions it starts and that any session page has a Track toggle.
- **Session** (resizable, persisted). A header with back button, agent logo, title, state badge, "open full page" and the `…` menu. Body: `Conversation` and the link-status banner, then `ChatComposer` with `PermissionCard`s handled by `Conversation` as today. No terminal, no GitHub panel, no mode/config controls, no aurora. The resize handle is the same hand-rolled separator pattern as `Sidebar.tsx`.

The main Portal pane keeps its `max-width: 840px` centring; when the panel is expanded the pane shrinks and the thread simply becomes narrower.

**Mobile.** The list is a right `Sheet`. Selecting a row swaps the sheet content for the session view at full width and height, with the back button returning to the list. Closing the sheet clears `?session=`.

**"Ask Portal about this"** prefills the orchestrator composer of the current thread with `About session <id> (<title>): ` and focuses it. The draft store already supports writing from outside the composer.

### Wiring

- `PortalPage` gains `onOpenSession` behaviour that sets `?session=` instead of navigating, for item actions, thread mentions and status-line links. Full navigation remains available through "open full page".
- `SessionHeader` gets a Track/Untrack toggle. `ProjectsColumn` rows get the same in their menu.
- `PortalNeedsYou` filters out the retired kinds client-side as belt and braces.
- `usePortalViewCounts().chat` (the Needs-you badge) is unchanged; the sidebar badge for tracked sessions is the count of sessions in the needs-approval or finished groups, shown on the panel's collapsed toggle.

### Perf follow-up (decision 16)

`PortalThread` refetches the whole page on every `messages` event and replaces message objects, defeating memoisation. On this branch: keep object identity for unchanged messages when merging a fetched page, and memoise the message row on message id plus `updatedAt`/part count. Measure with the React profiler before and after; numbers go in the PR.

## Implementation order

1. Contract types, migration, `tracked_sessions` store, routes, portal stream event, activity kinds. Tests for the store and routes.
2. Orchestrator: tools, tool group, auto-track in `startSession`/`setup_pr_reviews`, world section, prompt guidance, `create_item` rejection, `review-watch` change. Tests for tools and the world section.
3. Liveness in the list stream patch.
4. Web: `SessionsProvider`, `useSessionStream` extraction, `SessionPane` on the hook. No visible change; existing session page still works.
5. Web: `TrackedPanel` list mode, URL param, preferences, toggles in `SessionHeader` and `ProjectsColumn`, Needs-you filter.
6. Web: session mode, resize, mobile sheet, "ask Portal", link rerouting.
7. `PortalThread` memoisation fix and profiler numbers.
8. Live check on a scratch instance (see the e2e recipe): track from chat, watch a session finish, expand it, reply from the panel, untrack from the agent.

Commit per step as it lands green; merge to main waits for Moses.

## Out of scope

- Turn-end timestamps and true "unanswered since" ages (decision 17).
- Retiring the remaining item kinds (PR, worktree, review findings, approvals, memory).
- Tracking in the left sidebar beyond the toggle.
- Notifications.
