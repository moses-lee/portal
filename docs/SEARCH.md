# Global search

Date: 2026-10-08. Status: built on branch `feat/search`, live-tested against a clone of the production database (as-built notes at the end).

## Why

Portal holds hundreds of sessions across many projects and worktrees. Finding the one that worked on a given pull request, or the one where a particular thing was said, meant scrolling the projects column. This adds a Raycast-style search dialog (sidebar Search icon, /) that finds sessions and projects by name, branch, pull request, and conversation text.

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | Entry points | A Search icon beside Agent at the top of the unified sidebar. `/` opens Search outside text fields, composers, and terminals; other dialogs keep their keyboard input. |
| 2 | Look | Raycast-style: centered, anchored near the top, about 640 px wide, blurred backdrop, bare input, grouped rows with section headers, a footer hint bar. Arrow keys move, Enter opens, Esc closes. Bottom sheet below 640 px. |
| 3 | Empty query | "Recent" (the last eight items opened from search) and "Recent sessions" (the six newest, the sidebar's recency rule). Recents are per device in localStorage. |
| 4 | Result types | Sessions and projects only. Nothing links outside Portal; a pull request is a way to find the sessions that worked on it, never a result of its own. |
| 5 | Session matches | Title, project name, branch, agent, and PR association. PR association means: the worktree is on the PR's head branch, the title names the PR, or an orchestrator item links the two. The row's subtitle shows the PR when that is how it matched. |
| 6 | Project matches | Name, folder, and worktree branch. Opening a project opens a start-page tab with that project selected. |
| 7 | Messages | User prompts and agent replies only. No tool output, no thoughts. Opens the session at its latest page in round one; jumping to the message is a follow-up. |
| 8 | Match style | Substring, case-insensitive. Rank prefix over word-start over substring, then by recency. |
| 9 | PR titles | From what Portal already fetches: the world's PR list and the change log's PR rows. No new GitHub traffic. An unseen PR matches by number only. |
| 10 | Backfill | The migration adds the table and index only. The server indexes existing logs in the background after boot, per session, resumable. |

## Server

### Data

New table `session_messages`, one row per prompt or agent reply piece, derived from `session_events`:

| column | type | notes |
|---|---|---|
| `session_id` | text, FK `sessions.id` on delete cascade | |
| `first_seq` | integer | the first event the row covers |
| `seq` | integer | the last event the row covers; PK with `session_id` |
| `role` | text | `user` or `agent` |
| `ts` | bigint | ms epoch |
| `text` | text | capped at 10 000 characters |

Index: GIN trigram (`pg_trgm`) on `text`, so `ILIKE '%q%'` is an index scan. The conversation text is a few megabytes against a half-gigabyte event log dominated by tool output, which is why a derived table beats indexing the log.

Migration `0014` installs `pg_trgm`, creates the table and the index. It does not backfill.

### Write path

`PgSessionStore.append` derives message rows from each batch and inserts them in the same transaction as the events, so the table never drifts from the log. The runtime flushes a streamed reply every 250 ms, so one reply reaches the store as many appends; when a batch opens with a reply chunk and the previous stored event ends an agent row, that row is replaced by one covering both (same `first_seq` and timestamp, the newest `seq`, still capped at 10 000 characters). A reply is therefore one row however it was streamed.

A boot-time task (5 s after listen, unref'd timer, one connection) backfills every session: it walks events below the lowest row's `first_seq` and above the highest `seq`, joins reply runs the same way, and merges a run that ends at the boundary into the row there. Each session is its own transaction, so it is idempotent and safe to interrupt; it is stopped on shutdown and logs one line when done. On the production clone (268 sessions, 476k events) it took about 5 s and produced 6 088 rows, 12 MB with the index.

### Route

`GET /api/search?q=` answers only what the client cannot compute from the lists it already holds:

- `messages`: up to 8 hits, newest first, each with a snippet around the first match.
- `pulls`: sessions associated with a pull request the query names. The catalog is the world's open PRs, the change log's PR rows, and every PR an orchestrator item links (number only unless the others know the title); it is rebuilt from the database at most every 30 s. The query matches a catalog entry by number (`123`, `#123`, `repo#123`), by title substring, or by head-branch substring. Association is by orchestrator item link, by title (`repo#123`, `owner/name#123`, or a bare `#123` when the session's project is not known to belong to another repo), or by branch: the session's project is a worktree whose branch equals the PR's head branch and belongs to that repo (via the world's repo-to-project map, extended to worktrees whose parent belongs to the repo). Sessions in a main checkout never match by branch; the table stores no branch at session time and reading the folder's current branch would link every session ever run there. Several ways report item over title over branch.
- `q` is trimmed and cut to 200 characters; under 2 characters answers empty.

Contract: `packages/contracts/src/search.ts`.

## Web

- `lib/search.ts`: pure query parsing, matching, ranking, merge of server PR hits, recents list. Unit tested.
- `useSearch`: debounced (120 ms), aborting, cached call to the route; two-character minimum. While a query is pending it shows the previous answer only when the new query extends the old one, keeping only messages that still contain it and no PR hits; failed requests are not cached. `pending` keeps the empty state from flashing before the server answers.
- `SearchDialog`: its chunk is split out like the settings dialog; the panel mounts only while open. Empty query shows Recent and Recent sessions; with a query, Projects (4), Sessions (8), Messages (8). Selection is tracked by row identity, so late server results do not move it. Desktop is its own Radix Dialog (the shared `ResponsiveDialog` forces a visible title); under 640 px a bottom Sheet.
- `Chat.tsx` holds the open state and the capture-phase shortcut listener (`/` for Search outside editors; ⌘K/Ctrl+K for Agent, including composers and terminals; held keys are ignored and another open dialog disables it); a session result opens through the workspace's open-session action, a project result through the start tab. Recents drop entries whose session or project is gone.

## Removed conversations

Conversations retained after project removal remain searchable, including recent and message results, with a **Removed** badge. Every entrypoint opens the retained history with **Project removed** and a restoration action. Removed conversations do not reconnect their agent or offer message, permission, settings, or terminal controls until the project is restored. Restoration continues the conversation that was opened; blockers and failures remain visible alongside its history. Project lifecycle events keep result labels and project lists current across viewers. Permanently deleted conversations are unavailable.

## Agent popup

Updated 2026-10-14. Search and Agent are separate dialogs. Search keeps its result types, appearance, and keyboard selection; it has no conversation tab.

- Agent opens from the sidebar's bot button or ⌘K (Ctrl+K outside Apple platforms). The same shortcut toggles it; ⌘J is retired. Opening either dialog replaces the other.
- Agent is centered at about 60vw × 85dvh on desktop and fills the viewport on mobile. It includes live status and the existing conditional main/side/archived thread picker. There is no full-page orchestrator route.
- Conversation instances stay mounted after dismissal so streaming replies, drafts, and transcript scroll survive reopening. The dialog's focus trap and scroll lock are released on dismissal.
- Main and side threads keep their draft/history keys. Each message carries the focused workspace session/tab/pane, including while a page covers that workspace.
- Session/tab links reveal the workspace; memory, watch, and thread links dispatch local overlay or Agent actions without changing the browser URL. Closing a response never cancels its server turn.
- Search still excludes the orchestrator conversation from its searchable data.

Tests: `tests/search.test.mjs`, `tests/ui/search.spec.ts`, `tests/ui/search-portal.spec.ts`, `tests/ui/portal-threads.spec.ts`, and `tests/ui/talk-to-portal.spec.ts`.

## Rollout

The live instance needs a restart for migration 0014; the backfill runs on its own after boot and logs when it is done.

## As built

- A PR that no source knows (not in the world, the change log, or an item) is still found when a session title names it, through the client's title substring match; the row then has no PR subtitle. Example on the clone: `2761`.
- Ctrl+K on Linux and Windows is taken from the terminal and the composer for Agent, so the shell's kill-to-end-of-line no longer reaches xterm.
- Two-character queries have no trigram, so Postgres scans the table for them; at today's 4 MB of text that is still a few milliseconds. Route latency on the clone was 30–40 ms per query end to end.
- Right at boot a live append can split a reply whose row the backfill has written but not committed; the text is still all indexed.
- Sessions with no message rows are re-read in full on each boot until they have one. The message insert shares the event transaction, so a failing insert drops that event batch rather than letting the index drift.
- Tests: server `tests/search.test.mjs` (store rows, chunk joining across appends, backfill boundary, PR number/title/branch/item queries, snippet, escaping, query cap); web `tests/search.test.mjs` (ranking, merged PR score, recents, highlight, shortcut); Playwright `tests/ui/search.spec.ts` (button, shortcut toggle and suppression while settings is open, Esc, sections, keyboard open, stale-result handling, recents on reopen).
