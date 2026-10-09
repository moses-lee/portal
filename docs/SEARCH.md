# Global search

Date: 2026-10-08. Status: built on branch `feat/search`, live-tested against a clone of the production database (as-built notes at the end).

## Why

Portal holds hundreds of sessions across many projects and worktrees. Finding the one that worked on a given pull request, or the one where a particular thing was said, meant scrolling the projects column. This adds a Raycast-style search dialog (sidebar button, ⌘K) that finds sessions and projects by name, branch, pull request, and conversation text.

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | Entry points | A Search button at the bottom left of the sidebar above Settings, with a `⌘K` hint. Cmd+K on Mac and Ctrl+K elsewhere toggle it, even while a composer or terminal has focus, unless another dialog is open. |
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
- `Chat.tsx` holds the open state and the capture-phase ⌘K/Ctrl+K listener (physical `KeyK` also counts, held keys are ignored, any other open dialog or popover disables it); a session result opens through the workspace's open-session action, a project result through the start tab. Recents drop entries whose session or project is gone.

## Portal tab

Date: 2026-10-09. Built on branch `orchestrator-on-search`.

The dialog has two tabs, Search and Portal. Portal is the orchestrator's main thread (history, composer, drafts), the same conversation as the Portal page's Chat, available over any page.

| # | Topic | Decision |
|---|---|---|
| 11 | Shortcuts | ⌘J (Ctrl+J off Apple platforms) opens the dialog on Portal; ⌘K keeps opening Search. The open tab's own key closes the dialog, the other key switches tabs. Both follow decision 1: caught before a composer or terminal, held keys ignored, nothing while another dialog is open. Ctrl+J is therefore taken from the terminal (line feed) off Mac. |
| 12 | Threads | Main thread only. Portal can open side threads (`open_thread`), but the live instance had none on 2026-10-09; they stay on the Portal page. |
| 13 | On the Portal page | ⌘J still opens the dialog there; the two views of the main thread share the draft and both pick up the other's messages through the stream. |
| 14 | Size | One size for both tabs. The dialog grew by the tab strip's 40 px (640 × 520 px, at most 76 vh + 40 px) so the search panel keeps its 480 px; the bottom sheet on phones. |
| 15 | Tab switching | The two shortcuts, a click on a tab, or Left/Right on the tab strip. |
| 16 | Search scope | Portal's own conversation is not searchable from the Search tab. |

How it works:

- `paletteShortcut` (`lib/search.ts`) maps a key press to `"search"`, `"portal"` or null. A Latin layout goes by the letter typed (Dvorak's own J key); a non-Latin one by the physical key.
- `Chat.tsx` holds the open tab (`null | "search" | "portal"`). `SearchDialog` keeps the last tab through the closing animation, mounts the Portal panel the first time its tab shows, and keeps both panels mounted (hidden) until it closes, so the query and a streaming reply survive a switch. The Portal panel's chunk (`PortalThread`, the chat SDK, markdown) loads on first use.
- Each panel focuses its own field when shown (the search box, the composer with the caret at the end); the element the dialog was opened from is noted in a layout effect before that, and gets focus back on close.
- What the user is looking at goes with each message as on the Portal page, so a question asked over a session is about that session.
- An in-app link in a reply (a session, a tab) and a curation run's digest line close the dialog and navigate. Closing mid-reply loses nothing: the server keeps consuming the stream, and on reopen the thread shows Portal answering and loads the stored reply.

Tests: web `tests/search.test.mjs` (the shortcut mapping, layouts); Playwright `tests/ui/search-portal.spec.ts` (⌘J over a session with the view sent along and focus returned, switching with state kept and the shared draft, a reply's link closing the dialog) and the settings suppression in `tests/ui/search.spec.ts` covering ⌘J.

## Rollout

The live instance needs a restart for migration 0014; the backfill runs on its own after boot and logs when it is done.

## As built

- A PR that no source knows (not in the world, the change log, or an item) is still found when a session title names it, through the client's title substring match; the row then has no PR subtitle. Example on the clone: `2761`.
- Ctrl+K on Linux and Windows is taken from the terminal and the composer by decision 1, so the shell's kill-to-end-of-line no longer reaches xterm.
- Two-character queries have no trigram, so Postgres scans the table for them; at today's 4 MB of text that is still a few milliseconds. Route latency on the clone was 30–40 ms per query end to end.
- Right at boot a live append can split a reply whose row the backfill has written but not committed; the text is still all indexed.
- Sessions with no message rows are re-read in full on each boot until they have one. The message insert shares the event transaction, so a failing insert drops that event batch rather than letting the index drift.
- Tests: server `tests/search.test.mjs` (store rows, chunk joining across appends, backfill boundary, PR number/title/branch/item queries, snippet, escaping, query cap); web `tests/search.test.mjs` (ranking, merged PR score, recents, highlight, shortcut); Playwright `tests/ui/search.spec.ts` (button, shortcut toggle and suppression while settings is open, Esc, sections, keyboard open, stale-result handling, recents on reopen).
