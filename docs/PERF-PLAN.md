# Portal performance plan

Date: 2026-09-27. Status: awaiting sign-off. No code changed yet.

Source: the read-only audit of 2026-09-27 (five subagents plus live measurements against the production build on :3100) and the Q&A that followed. The live server answers every GET in under 150 ms; the cost is payload volume, client rendering and remounting, and a few request paths that wait on background work.

## Decisions on record

| # | Topic | Decision |
|---|---|---|
| 1 | Branches | One branch for everything. |
| 2 | Order | Whatever specs cleanly; foundations first (below). |
| 3 | Benchmarks | Yes. Before/after numbers in the PR. |
| 4 | Live instance | Data migrations and restarts allowed. |
| 6 | Screenshots | Stop persisting the duplicate `rawOutput`; serve images by URL from a blob store; one-off migration rewrites existing rows. |
| 7 | Session first page | Page by turns, 3 turns on the first page, with a hard row cap that allows a partial last turn only when one turn exceeds it. |
| 8 | Write batching | Coalesce text chunks and drop heartbeats, with the seq-safe design from verification (below). |
| 9 | Session retention | Deferred to the session lifecycle follow-up. |
| 10 | List payload | Drop `liveness` and `state.commands` from the list; keep `state.modes` and `state.configOptions`. |
| 11 | Terminal on switch | Empty panel with a "New terminal" button; no auto-create. |
| 12 | Pane remount | Keep the remount; single-pane refactor is out of scope. |
| 13 | Thread page size | 30 messages; tool outputs load when a row is expanded. |
| 14 | Pre-chat world refresh | Presence-driven background refresh, and a chat turn never blocks on it. |
| 15 | Background job cadence | Unchanged. |
| 16 | Items | Perf-only in this branch (payload + index + resolve stranded rows). Retiring items is a separate follow-up, not queued yet. |
| 17, 18 | Git panel | Cached summary shown instantly, refreshed in background; polling cadence unchanged (15 s, network fetch every 60 s). |
| 19 | Content-visibility override | Remove it and test; real windowing only if it misbehaves. |
| 20 | Aurora / glass | Unchanged. |
| 21 | Streaming tail | Stays fully formatted markdown. |
| 22 | Connection limit | Moses sets up Tailscale Serve (HTTP/2). Repo side only verifies the origin check behind it. |
| 23 | Pollers | Terminal cwd poll 750 ms to 1 s; session meta poll stays 1 s. |

Confirmed defaults: row cap 1000 raw rows per page (a per-page bound only; scrolling up keeps loading pages back to the start of the log, no session is truncated); hover prefetch delay 400 ms; history cache keeps the 20 most recent sessions; Postgres pool 25 with a 30 s statement timeout; blob route `/api/blobs/:hash`.

Status: implemented on branch `feat/perf-audit` (2026-09-27). See "Results" at the end for the numbers and the rollout steps.

## Live baseline (2026-09-27)

| Measurement | Value |
|---|---|
| `GET /api/sessions`, 175 sessions | 4.0 MB raw, 250 KB gzip, 23 ms |
| Default events page, session `a6870eef` | 4.6 MB raw, 3.4 MB gzip, 49 ms; 100 events after merge |
| `GET /api/portal/messages` | 1.0 MB raw, 425 KB gzip, 200 messages |
| `session_events` table | 421 MB, 358k rows; median session 1.4 MB, p90 4.2 MB, max 24 MB |
| Bytes by event kind | tool_call_update 236 MB, agent_message_chunk 55 MB, tool_call 30 MB |
| Largest single events | 1.2 MB each; a screenshot carried twice (`content` + `rawOutput`) |
| Full world build (hourly tick) | 6 to 8 s typical, 21 s worst |
| Chat turn (user trigger) | 13 to 163 s, includes the pre-chat refresh when stale |

Benchmark fixtures: sessions `a6870eef-85bc-4bc4-bca5-99d990a657fe` (24 MB, 3,941 events), `ff1107d6-5346-4727-87b7-e5635ce65000` (10,179 events), `968ae371-0d96-4df8-b873-114b2f2cf813` (largest single events), and the main Portal thread.

## Workstreams, in implementation order

Each workstream ends with: unit tests green (`pnpm test`), typecheck and lint green, the relevant Playwright specs green, and its benchmark re-measured. Migrations run first on a scratch Portal against a `pg_dump` clone (see the e2e memory), then on live.

### W0. Benchmark harness

- A small script under `apps/server/scripts/` that times and sizes the endpoints in the baseline table, raw and gzipped, and prints a table. Run before W1 and after each workstream.
- Manual DevTools traces for: cold session open, warm return to a session, orchestrator open, git panel return. Recorded in the PR description.

### W1. Session event storage (server)

Foundation for everything on the session page. Files: `apps/server/src/lib/acp-runtime.ts`, `sessions/pg-session-store.ts`, `sessions/store.ts`, `lib/session-pages.ts`, `lib/liveness.ts`, `db/schema.ts`, a new `lib/blobs.ts`, a new route, one SQL migration, one one-off script.

**1a. Heartbeats never get a seq.** Decide before `emit()`: a `tool_call_update` with status in progress or absent, carrying no `content`, `rawOutput`, `rawInput`, `title`, `kind`, or `locations`, for a call that is already in progress, is consumed by `trackToolCall` for liveness and then dropped. Add `status` to `OpenToolCall` so the pending-to-in-progress transition is still logged. Memory, SSE ids, and DB stay in lockstep, so no client change and no restart drift. Liveness and hung detection are in-memory only and unaffected.

**1b. Text chunks coalesce in the write chain.** Adjacent `agent_message_chunk` or `agent_thought_chunk` runs merge into one stored row under the **last** chunk's seq (timestamp of the first), so `max(seq)+1` still equals `nextSeq` after every flush. Flush on any non-chunk event, on kind change, in `readEvents` before it awaits the write chain, in `dispose`, and on a cap of 1 s or 4 KB so a crash loses at most that. Each flush is one multi-row insert. Keep the read-side `coalesceTextChunks` for imported and pre-existing rows. Add the belt-and-braces reset in `eventsSince` when a cursor is ahead of the log. Update the "dense from 0" comments in `schema.ts` and `store.ts`; update the `EventPage.nextSeq` doc.

**1c. Images move to a blob store.** Before `emit()`, any tool call or update whose `content` has an image item (`content.type === "image"`, base64 `data`) is rewritten: the bytes go to `<portalHome>/blobs/<sha256>` (content-addressed, so the duplicate in `rawOutput` collapses to the same file), and the event carries `{ type: "image", mimeType, uri: "/api/blobs/<sha256>", data: "" }`. When `rawOutput` mirrors the same image it is replaced by a small stub naming the uri. A new `GET /api/blobs/:hash` serves the file with `Cache-Control: immutable`, no gzip, hash validated against `/^[a-f0-9]{64}$/`. In-memory ring buffer, SSE, and DB all carry the URL form. The web client never renders images today (the tool card filters to text), so the card gains an `<img loading="lazy">` for image items inside the collapsible body.

**1d. One-off migration script.** `pnpm --filter @portal/server migrate:blobs`: walks `session_events` in batches per session, finds rows whose body contains base64 image content, writes blobs, rewrites the rows in place, and reports bytes reclaimed. Idempotent. Postgres will not shrink the table on its own; the script prints the `VACUUM FULL session_events` step and its lock implication, and we run it on scratch first.

**1e. Pages by turns with a cap.** `readTurnPage` takes `turns` (default 3) and `maxRows` (proposed 1000). It grows backwards until the page holds that many `user` boundaries, and stops early at the cap, in which case the page may start mid-turn. The client already tolerates that: the reducer drops updates for tool calls it has not seen, and `segment` keys the first turn by its first event. Query params: `?turns=3` for the browser, `?limit=` kept for the orchestrator's row-based windows. `hasMore` and `before` semantics unchanged.

**1f. Boot scan.** Add `sessions.turn_open boolean` maintained on `turn_start`, `turn_end`, and error. `loadPersisted` reads it instead of scanning up to 5,000 tail rows per session; the migration backfills it with one scan. Load with a concurrency cap of 8.

**1g. Pool.** `max` 10 to 25, `statement_timeout` 30 s, `connect_timeout` 10 s in `db/client.ts`.

Tests: `acp-runtime.test.mjs` row-count and seq assertions updated for 1a/1b; new tests for flush-on-read, flush-on-dispose, seq continuity across a simulated restart, heartbeat drop vs pending-to-in-progress; `session-pages.test.mjs` for turns and the cap; blob write, dedupe, and route tests; migration script test on a fixture DB.

### W2. Session list payload (contracts, server, web)

- New `SessionListEntry` = `SessionSummary` without `liveness`, with `state` reduced to `{ modes, configOptions }`. Applied to `GET /api/sessions` and the list stream's `created` event only. The in-process `listSessions()` the orchestrator uses is untouched.
- Web: `SessionPane` seeds from the partial state and gets `commands` from the first `meta` event (already the path for cold deep links); `session-config.ts` accepts the reduced state; Playwright fixtures drop `liveness`.
- Tests: `session-routes.test.mjs` asserts the list omits `commands` and `liveness`; `session-config.test.mjs` updated.

### W3. Session switching (web)

- `TerminalPanel`: no auto-create on mount. Empty state with a "New terminal" button. Focus and visibility refetches unchanged.
- `Chat.tsx`: `useCallback` for every handler passed to `ProjectsColumn` and `Sidebar`; `useMemo` for the `start` object handed to `SessionPane`, so the memoized sidebar stops re-rendering on every stream event.
- `ProjectsColumn`: hover prefetch delay 100 ms to 400 ms, cancelled on mouse leave.
- Playwright: switching sessions with the panel open creates no terminal; a click on the button creates one.

### W4. Transcript rendering (shared, web)

- Remove the `![content-visibility:visible]` override in `Conversation.tsx` and `PortalThread.tsx`. Manual test matrix: scroll up through a long session, jump to bottom, streaming while scrolled up, find-in-page, older-page prepend keeps position. Fallback if it misbehaves: window the turn list.
- Incremental reducer in `packages/shared/src/transcript.ts`: `createTurnReducer()` holds the tool and permission maps and applies one event, replacing only the block it touched. `appendEvent` becomes O(1) per event. Turns keep `firstSeq`/`lastSeq` and drop the raw `events` array once closed.
- `SessionPane`: coalesce SSE events per animation frame before `setHistory`.
- Streaming markdown stays formatted: the assistant block is split at the last settled paragraph; settled paragraphs are memoized on their text, only the tail re-parses per frame.
- `history-cache.ts`: LRU of 20 sessions.
- Tests: reducer equivalence (incremental result equals `reduce(events)`) over the fixture logs; cache eviction.

### W5. Orchestrator (server, web)

- **Thread paging.** `GET /api/portal/messages?before=<ordinal>&limit=30` and the per-thread form return `{ messages, hasMore, nextBefore }`, newest page by default, using the existing `(thread_id, ordinal)` index. Tool parts ship without `output`; `GET /api/portal/threads/:id/messages/:messageId` returns the full message and the card fetches it on expand. `PortalThread` loads the newest page, prepends older pages on scroll-to-top through the scroller's prepend-preserve, and merges by id.
- **Live updates.** The `messages` SSE event carries the appended message ids and `lastMessageAt`. The client fetches only messages newer than what it holds and merges by id; it skips the fetch when the event's run is the turn it just streamed. `reconnected` refetches the newest page and merges. `PortalPage` unmounts hidden threads that are not streaming.
- **Status.** `status()` memoized for 1 s; the stream-open handler reuses its reads instead of re-running `listItems`, `pending`, and `listIntents`; `emitStatus` debounced 250 ms and skipped with no listeners; settings and the API key cached in memory with `settings.subscribe` invalidation; `approvals.pending()` becomes read-only and expiry moves to the jobs worker tick.
- **Items, perf-only.** `listItems({ status })` with an index on `(status, created_at)`; the UI and SSE get open and snoozed only; one-off SQL resolves the 31 stranded pre-2026-09-25 `session_*`/`pr_*` rows. Retiring items is a follow-up.
- **World refresh.** While any tab is present, a background full refresh runs when the last one is older than 5 min (throttled to one in flight). A chat turn never awaits it: it starts on the current world and the prompt states the world's age. `GET /api/portal/world` serves the latest build and refreshes in the background.
- **Thread persistence.** `writeMessages` stops deleting and reinserting the whole thread: targeted `DELETE` below the trim ordinal and `UPDATE` of trimmed rows; the thread is read once per turn and passed along.
- Tests: paging and cursor tests in `orchestrator-*.test.mjs`; SSE merge tests in the web thread spec; status memo and read-only pending tests; a Playwright spec for scroll-to-top paging.

### W6. Git panel cache (web, server)

- **Client.** `createGithubSummaryCache` modeled on `history-cache.ts`: a `Map<projectId, ProjectState>` with in-flight dedupe and generations, created in `Chat` next to `historyCache` and passed to the inspector. On mount the cached entry renders immediately with `refreshing: true` while `load()` runs. Relative ages tick from a client clock. Prefetch from the sidebar hover path. Refresh, not delete, on: `meta.git` branch change, busy-to-idle, `POST /github/pull`, worktree create or remove.
- **Server.** Per-repo snapshot cache keyed by a fingerprint (HEAD, upstream, `origin/<base>` shas, symbolic HEAD, last fetch time, pull-cache identity) read from ref files; on a match phases 3 to 7 are skipped. `at` moves to a response header; body gets an `ETag` and the route honours `If-None-Match` with 304. Pull cache keyed on head sha too and bypassed only by manual refresh. `rev-list`, the PR lookup, and the first log page run concurrently.
- Tests: cache hit on return, invalidation on branch change, 304 path, fingerprint miss on new commit.

### W7. Server churn

- Terminal cwd poll 750 ms to 1 s.
- `http/sse.ts` serializes each broadcast once; `terminals/socket.ts` counts bytes without re-stringifying.
- Blob route excluded from global gzip.

### W8. Bundle

- `next/dynamic` for `SettingsDialog`, `ApprovalsDialog`, and whichever of `PortalPage` or `SessionPane` the route does not need; `diff` imported inside `ToolCard`.

### W9. HTTP/2 verification

- After Tailscale Serve is up: confirm mutating requests pass `crossOriginError` behind the proxy (it compares `Origin` to `X-Forwarded-Host` or `Host`); add the ts.net host handling if Serve does not forward it. Re-run the DevTools "Stalled" check with two tabs.

## Verification

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` from an agent shell with `NODE_ENV`, `TURBOPACK`, `NEXT_DEPLOYMENT_ID`, and `__NEXT_DEV_SERVER` unset.
- Playwright UI specs under `apps/web/tests/ui` against route mocks, run against port 3000 of a scratch Portal.
- Migrations (1d, 1f, items index and resolve) rehearsed on a scratch clone of the live DB before running live.
- Benchmark table from W0 re-run after each workstream and pasted into the PR.

## Out of scope, tracked separately

- Session retention and archival (9).
- Background job cadence and presence (15).
- Retiring items and finding a new home for review findings (16b).
- Single-pane session refactor (12).
- Merging SSE streams into one connection (22a).

## Results (2026-09-27, branch `feat/perf-audit`)

Measured with `pnpm --filter @portal/server bench` against the live server (old code, live data) and
against a scratch server running the branch on a `pg_dump` clone of the live database with the
migrations and the blob migration applied. Same three sessions, best of three.

| Endpoint | Before raw / gzip | After raw / gzip |
|---|---|---|
| `GET /api/sessions` (182 sessions) | 4.0 MB / 245 KB | 582 KB / 25 KB |
| `GET /api/portal/messages` | 971 KB / 440 KB (200 msgs) | 152 KB / 76 KB (30 msgs) |
| events, session `a6870eef` (screenshots) | 4.4 MB / 3.3 MB | 1.5 MB / 1.1 MB |
| events, session `ff1107d6`, `?turns=3` | 8 KB (last turn only) | 28 KB (3 turns) |

The remaining 1.5 MB of the worst session is text tool output (file contents, command output) from
its last three turns; gzip handles that far better than it did the base64 images.

Verification: server suite 661 tests green (run in four chunks under heavy machine load; two tests
flaked once on timing and pass alone), web unit tests 64 green, shared tests 41 green, Playwright UI
suite 78 green, typecheck and lint clean for server, web, and shared.

What changed against the plan while building:
- Both pages stay statically imported; `SettingsDialog`, `ApprovalsDialog`, and the diff view load on
  demand instead (W8).
- The standalone terminal page (`/terminal`) still opens a first tab by itself; only a session's panel
  shows the empty state (11).
- The stranded-items cleanup skips kind `custom` (a test fixture uses it; no live custom item is open).
- The prompt already stamps the world's build time, so nothing was added for the world's age (14).
- W9 is Moses's: after Tailscale Serve is up, check that mutating requests are not refused with 403
  (`http/origin.ts` compares `Origin` with `X-Forwarded-Host`, then `Host`).

Rollout, in order:
1. Merge and restart the server (migrations `0010` and `0011` apply at boot: the `turn_open` column,
   the items status index, and the resolve of the 31 stranded items). The first boot settles
   `turn_open` for existing sessions by reading their tails once.
2. `pnpm --filter @portal/server migrate:blobs` (idempotent; safe with the server up). On the clone it
   moved 71 rows and 38 MB into `~/.portal/blobs` in under a second.
3. Optional, with the server stopped: `VACUUM FULL session_events;` to hand the space back.
4. `pnpm build` for the web app and restart it (the events page now asks for `?turns=3`).
