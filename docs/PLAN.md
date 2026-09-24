# Portal: server split and the Muse-style orchestrator

Status as of 2026-09-23. This is the working plan for turning Portal from a chat UI with a
timer-driven assistant into a coordinator that knows the user's world, runs its own background
work, and keeps an auditable memory. Phases 1, 2, and 3 are merged into `main` (§1.2, §1.5, §1.8).
The live instance still runs phase 1 code until it is restarted (§1.6). Known gaps are in §1.7;
what comes next is in §1.9.

Companion research (outside the repo, in the author's notes): Muse product/architecture,
Muse agent design, Muse memory deep-dive, Instinct memory, agent-memory survey, the original
orchestrator runtime and prompt/tools/UX summaries, the Next rewrite proxy probe, and the phase 1
review and live-verification reports. The essentials are folded into this document.

---

## 1. Where we are

### 1.1 What Portal is

Portal is a self-hosted web UI for coding agents. It talks to Claude Code and Codex over the
Agent Client Protocol (ACP), shows each session's transcript live, gives every session and the
standalone page a real terminal (node-pty over Socket.IO), manages projects and git worktrees,
summarizes GitHub state per project, and has a "Talk to Portal" thread where an orchestrator
watches sessions and pull requests and turns changes into "Needs you" items.

### 1.2 What phase 1 delivered (branch `feat/portal-server`, four commits)

Before: one Next.js 16 app with API routes, a custom `server.mjs` for Socket.IO, and JSON files
under `~/.portal` (session index plus per-session event logs, `projects.json`, `settings.json`
holding API keys in plain text, and the orchestrator's `conversation.json`, `items.json`,
`watches.json`, `snapshot.json`, `ticks.json`, `memory.md`).

After:

```
portal/
  package.json              pnpm workspace: dev / prod / start / test / test:ui / db:up / db:down
  docker-compose.yml        Postgres 18 + pgvector (pgvector/pgvector:0.8.6-pg18-trixie), port 5433
  apps/
    web/                    Next.js 16, frontend only. next.config proxies /api/* (and the terminal
                            WebSocket at /api/shell/socket) to the server. No API routes, no server.mjs.
    server/                 Fastify 5 on Node 24 (type stripping, .ts imports), Drizzle + postgres.js
      src/app.ts            buildApp(): compress, db + migrations, legacy import, services, routes
      src/context.ts        AppContext: config, db, log, presence, sessions, projects, settings,
                            terminals, orchestrator. Services read siblings from it at call time.
      src/sessions/         ACP runtime on the Postgres event log; routes incl. both SSE streams
      src/projects/         Postgres store with in-memory cache; worktrees, branches, GitHub summary
      src/settings/         overrides row + AES-256-GCM credentials under <PORTAL_HOME>/server.key
      src/terminals/        node-pty registry, Socket.IO on app.server, /api/shell/socket
      src/orchestrator/     the existing orchestrator, unchanged behaviour, Postgres store
      src/import/           one-time importer from ~/.portal (boot hook + CLI)
      src/http/             same-origin guard, SSE helper, status errors
      src/db/               schema.ts, migrations (drizzle-kit generate; runtime migrator applies)
      src/lib/              Node-only helpers shared across domains (git-info, fs-paths, exec, ...)
  packages/
    contracts/              wire types shared by browser and server (@portal/contracts/*)
    shared/                 pure logic used by both (settings, scripts, branch matching, transcript)
  scripts/launchd/          LaunchAgent template for start-at-login (not installed)
```

Data model today (Drizzle, `apps/server/src/db/schema.ts`): `sessions`, `session_events(session_id,
seq, ts, body jsonb)`, `projects`, `removed_projects`, `settings(key, body jsonb)`,
`credentials(name, ciphertext, key_id)`, `orchestrator_messages`, `orchestrator_items`,
`orchestrator_watches`, `orchestrator_ticks`, `orchestrator_documents`.

Verification at the end of phase 1: server 343 unit tests, web 46, shared 35, Playwright UI suite
45 (server on a fresh `portal_e2e` database plus a production web build), lint, typecheck and build
clean; live smoke through the production proxy for JSON routes, both SSE streams, the origin guard
and terminal I/O over WebSocket. A code review and a live verification against a copy of the real
`~/.portal` were run before merging (reports in the author's notes).

### 1.3 Things learned in phase 1 that constrain what follows

- **Bun was tried and dropped.** node-pty does not work under Bun; Node 24 runs everything as is.
- **The Next rewrite proxy** forwards SSE only with `Cache-Control: no-transform` (else gzip buffers
  the stream), holds response headers until the first byte (the SSE helper writes a comment at
  once), cuts idle streams at 30 s (pings every 15 s), forwards WebSocket upgrades under `/api/`
  but silently drops upgrade requests whose path has a trailing slash (Socket.IO runs with
  `addTrailingSlash: false` on both ends), rewrites `Host` but sets `x-forwarded-host`, and passes
  `origin` and `sec-fetch-site` through. The same-origin guard compares `Origin` against
  `x-forwarded-host`.
- **The proxy target is baked into the web build** for `next start` (`PORTAL_SERVER_ORIGIN`), so
  build and start must agree. `pnpm prod` does this.
- **The ACP SDK's type declarations** do not resolve under TypeScript's NodeNext resolution; the
  server tsconfig uses bundler resolution.
- **`PORTAL_HOME`** now holds only `server.key`, the worktrees folder and the legacy files kept as a
  backup. Back up `server.key`: credentials are unrecoverable without it.

### 1.4 Cut-over

The old app can keep running from the `main` checkout until the user switches. The first boot of
the new server with the default `PORTAL_HOME` against an empty database imports `~/.portal` and
renames `settings.json` (it holds plain-text keys). Stop the old instances first, or run the new
stack with a scratch `PORTAL_HOME` to try it. `pnpm --filter @portal/server run import --dry-run`
previews the import.

### 1.5 What phase 2 delivered (merged into `main`)

Built by the integrator plus five parallel agents (jobs, world, memory, approvals, web) under
`docs/phase-2-brief.md`, then merged, fixed, and checked live.

- **Layout.** The orchestrator moved to `apps/server/src/orchestrator/`: `hub.ts` (shared parts and
  domain services read at call time), `turn.ts` (every model turn: role model, run record, system
  prompt with CORE.md, world, and retrieved memory, tools redacted, gated, and logged), `tick.ts`,
  and one directory per domain (`activity/`, `jobs/`, `world/`, `memory/`, `approvals/`), each with
  a store interface, memory and Postgres stores, service, tools, routes, and prompt guidance.
  Contracts per domain in `packages/contracts/src/{activity,jobs,world,memory,approvals}.ts`.
- **Data.** Migrations 0002–0005: all phase 2 tables; watches became intents with check jobs, tick
  reports became tick-job runs, the Ideas list is gone (open ideas resolved).
- **Behaviour.** Threads with one lock each (only the agent opens side threads); the tick is a job
  and chat never waits for it; agent-scheduled jobs (`every`/`cron`/`at`) and intents with trigger,
  budget, cooldown, and expiry; helpers as sub-turns; the world state rendered into every prompt
  and `resolve_pull`/`resolve_repo`/`resolve_session`; curated memory with inbox, revisions,
  CORE.md, scoped retrieval, and a quote rule so only the user's own words become user_stated;
  deterministic approvals with scoped grants, a dialog, and job pausing; a chat role (default
  `claude-opus-5-5`) and a bookkeeping role (default `claude-haiku-4-5`) with the model following
  the provider; usage on every run; the activity log.
- **Fold-in fixes.** Dismissals stick until the condition clears; `kind` is patchable; a capped tick
  keeps the snapshot; short sessions count as finished; reviews of other people's PRs get a
  reviewer's brief (or the orchestrator's own prompt from memory).
- **UI.** Tabs Chat (threads), Goals (intents, upcoming jobs, runs), Activity, Memory (entities,
  records with provenance, inbox, revisions), System (CORE.md, the world as the model sees it,
  grants); a live status line; the approvals dialog app-wide; the bookkeeping model in Settings.
- **Verified.** Server 540, web 59, shared 36 tests; Playwright 69; live on a scratch instance over a
  clone of the real database: "review PR 2367" resolved to liquid-labs-inc/monorepo with no
  question and started a review; chat answered in 5 s during a tick; a delete raised the approval
  dialog and a denial was respected; a remembered preference showed in the memory browser with its
  quote. The migrations ran cleanly on the real data.

### 1.6 Switching the live instance to phase 2

The live server (`node src/index.ts` on 3100, no watch) and web (`next start` on 3000) keep running
the phase 1 code they loaded. To switch: stop both by port, `pnpm install`, `pnpm prod` from the
repo root. The first boot applies migrations 0002–0005 to the live database (verified on a clone:
watches become intents, open ideas are resolved, tick reports become runs). The live database
stores only an OpenAI key and the new defaults are Anthropic (`claude-opus-5-5` for chat,
`claude-haiku-4-5` for bookkeeping), so add an Anthropic key in Settings, or choose OpenAI models
for both roles; until then the page asks for a key.

### 1.7 Known gaps

After phase 3; none blocks use, and each is a candidate for what comes next. Phase 3 closed these phase 2 gaps: prompt weight, the inline helper
that ignored a cancelled chat turn, the `consolidate` stub, entity summaries and `reviewBy`, the
expired or declined job approval that left its job stuck, the recurring job that asked for the
same approval again, and `resolve_pull` finding only repos Portal has checked out (the user's own
PRs now resolve anywhere).

- **Review sessions stop on permission prompts.** Claude Code asks before each `gh` or shell
  command, so an unattended review waits for the user (live: both sessions stopped on their first
  command). The goal now raises the `session_waiting` item at once. Starting review sessions in a
  mode that allows read-only commands would remove the wait; that is a permissions decision for
  the user.
- **Review goals leave their worktrees behind.** Each reviewed PR keeps its worktree (under
  `<PORTAL_HOME>/worktrees`) and the local branch created for it after the findings arrive;
  nothing offers to remove them, and the tick's `worktree_merged` item only covers merged branches.
- **Consolidator.**
  - Corroboration is never recorded: proposing a claim that already waits in the inbox answers
    `unchanged` and drops the second source, so "recurring or corroborated" can only be seen in
    differently worded duplicates. Live, all nine real proposals stayed in the inbox as
    single-source. A proposal needs a list of sources (or a sightings count) that a repeat appends to.
  - The 25% guard counts rejected proposals as removals, so with a small memory a pass that
    rejects a few noisy proposals is refused whole.
  - The job always follows Settings: a reschedule from Goals is overwritten on the next settings
    change. Goals' runs list does not link to the curation run page.
- **Model-written text.** A proposal written by the model can carry HTML entities (`&lt;n&gt;`
  seen live), which the memory browser and digests show literally.
- **Monitors.** A check job that fails five times (GitHub down) is marked failed and the intent
  stays active without a check. The world gains PRs only on a full refresh (the tick), so a bare
  number that is not in the attention list falls back to asking each Portal repo.
- **Approvals.**
  - Approving a card action holds the `decide` request open until the replayed call finishes,
    which can take minutes for a worktree removal with scripts.
  - The shell classifier cannot see repo-local git config: `core.fsmonitor`, `core.pager`, or an
    alias can run code even during a read-only `git status`.
  - Only the classic tools are gated and replayable. Gating a jobs, world, or memory tool needs an
    entry in `approvals/policy.ts` and in the replay rebuild.
- **Jobs and runs.** `POST /api/portal/runs/:id/cancel` answers 409 for chat runs. Without a key
  the tick still runs on schedule and records a run saying nothing was checked.
- **Memory.** There is no route to create an entity on its own. Retrieval scans every entity on
  each turn, which is fine at the current size.
- **World.** Ids in the rendered world are 8-character prefixes, but classic tools need full ids.
  World rebuilds write no activity entry. `get_tick_digest` still calls `collectSnapshot` itself.
- **Web.** Any open tab counts as present. "Decide later" on an approval lasts until a reload.
  Upcoming fetches active and paused jobs in two requests.
- **Types.** The hub's memory and approvals interfaces are narrower than the services.

### 1.8 What phase 3 delivered (merged into `main`)

- **Prompt weight.** A chat turn starts with the 28 tools most turns use (about 5k tokens of
  schemas instead of 11k for all 69) and loads the rest by group with `use_tools`; a call to a
  tool whose group is not loaded becomes a `use_tools` call instead of failing the turn. History is
  cut at about 12k tokens as well as 40 messages. Anthropic turns use automatic prompt caching.
  Live, on the same clone and questions: 49.1k → 31.6k input tokens for a two-step answer (14.3k of
  them cached), 94.6k (three steps) → 41.3k (two steps, 14.5k cached).
- **Review flow.** `setup_pr_reviews` refuses to start a review of someone else's PR without a
  brief when memory has review guidance (the author's records, the `code-review` task type, the
  repo's conventions) and hands the guidance back; the model writes the brief and passes the
  records' ids. The goal's check needs no model: every two minutes it reads each session (a turn
  that ended, or one that failed, stalled, or was deleted) and raises the `session_waiting` item
  when a review waits for a permission. When all have ended, a summarizer on the chat model reports
  each PR through `report_review`, and each PR gets a `review_findings` Needs-you item (verdict,
  findings by severity with file:line, links to the PR and the session, the memory records used).
- **Monitor flow.** `monitor_pull` creates a goal whose checks call GitHub once (a per-PR GraphQL
  status) and compare it with the previous check. It reports only merged, closed, checks failing
  or passing again, changes requested, approved, and conflicts (new reviews and comments when
  asked), keeps one item updated in place, and ends itself when the PR merges or closes. Asking
  again updates it; `cancel_intent` takes a PR number. No model runs these checks.
- **Consolidator.** The `consolidate` job runs nightly (03:00 local) and when the inbox reaches ten
  proposals (at most hourly), all three configurable in Settings, plus Run now in Memory. A
  chat-model turn proposes a plan; the server applies it: promotions keep their authority and
  never replace the user's own claims, observed records past `reviewBy` expire, the user's own go
  on one re-confirm item, entity summaries are written, and a plan removing more than 25% is
  refused whole. The digest and diff are on the run's page in Memory → Curation; one line goes to
  the main thread.
- **Also.** Tools receive the SDK's call options (abort signal), so stopping a chat turn stops an
  inline helper; job approvals resume, reschedule, or end the job on every outcome.
- **Verified.** Server 572, web 61, shared 37 tests; Playwright 74. Live on a scratch instance
  over a clone of the real database, with real Anthropic calls: "review PRs 2499 and 2496" wrote
  a CI-focused brief from two remembered preferences in one call, both sessions reviewed
  read-only, and two findings items arrived (#2499 needs changes with two blocking findings,
  #2496 looks good with five should-fix items). "Monitor PR 2572 until it merges" set its baseline
  from GitHub. The assistant proposed nine observations from real sessions; the consolidator
  left all nine in the inbox (single-source, as the rules require), rewrote one summary, and its
  digest showed in the UI. The activity log listed every step. The review worktrees and branches
  it created in the monorepo were removed afterwards.

### 1.9 What's next

The three phases in §5 are done. What remains is making them dependable in daily use:

1. **Switch the live instance** to the current `main` (the §1.6 restart; it applies migrations
   0002–0005, phase 3 added none). The live database now stores an Anthropic key.
2. **Unattended reviews:** decide how review sessions handle permission prompts (a mode that
   allows read-only commands, or an allowlist Portal answers), and clean up review worktrees and
   branches once the findings are read.
3. **Memory that can learn:** record repeat sightings on proposals so the consolidator can promote,
   and count only removals of active records in its guard, with a floor.
4. **Talk to Portal feels like a session.** Three changes, decided with the user:
   - **Prose, not cards.** The thread stops attaching item cards and per-PR lists to messages.
     When the tick or a goal has something to say, Portal writes a short summary in sentences
     ("two of your PRs need you: …; 139 review requests wait, the oldest a month old"); review
     results arrive as a prose verdict. The Needs-you strip stays as the place to act, dismiss,
     and open an item's full detail (per-PR lists, file:line findings). Today the tick prompt
     (`prompt.ts`) tells the model to paste the digest's detail lists as item bodies, and
     `PortalMessage.tsx` renders every touched item as a card under its message; phase 3's
     findings and monitor items followed the same pattern.
   - **Same send behaviour as sessions.** Both pages already render `ChatComposer`, but each wires
     its own sending: sessions clear the draft when the server acknowledges the prompt and show
     "Sending…" meanwhile; Portal (`PortalThread.tsx`, on `useChat`) clears only at the first
     streamed token, which in this AI SDK version comes after the model starts answering, so the
     text sits in the box. Move the session page's send logic (draft capture, sending state, clear
     on acknowledgement, error text, prompt history) into one hook both pages use; for Portal the
     acknowledgement is the reply stream opening, by when the server has stored the message.
     Changing Portal's API so replies arrive over its event stream, as sessions do, is deferred.
   - **The aurora.** Mount the session pages' `AuroraBackground` unchanged in `PortalPage`,
     covering every tab: working while Portal answers the user, waiting (amber) while an approval
     is pending, idle otherwise, including while background jobs run.
5. **The rest of §1.7**, then bearer-token auth for external clients (§6).

---

## 2. What the current orchestrator does, and why it is not enough

The orchestrator (`apps/server/src/orchestrator/`) is a Vercel AI SDK `ToolLoopAgent` (24 steps,
5-minute turns, gpt-5-mini by default) with one shared chat thread and a scheduler:

- **Tick.** Every 10 minutes while a tab is open (60 while idle) a deterministic pre-scan collects
  sessions (idle/working/waiting), authored and review-requested PRs via one `gh api graphql`
  query, worktree merged/dirty state, and missing folders into a snapshot; `diffSnapshots` turns
  transitions into fingerprinted changes; the model runs only when there are changes or due
  watches, with a reduced tool set, and creates or updates items.
- **Items and watches.** Items are "Needs you" or "Ideas" cards with kinds, links and up to four
  actions; watches are free-text intents with model-maintained notes that come due every tick.
- **Memory.** One `memory.md` (32 KiB cap) of which the first 4 KiB reach the prompt.
- **Concurrency.** One `busy` flag for chat and tick. Chat during a tick gets a 409; Stop cancels
  whichever is running.

What is wrong with it, in the user's words: it is "dumb", because every turn starts with zero
world context. "Review PR 2367" cannot resolve to the monorepo without asking. Monitoring cadence
is a fixed timer the agent cannot change. Memory is an unstructured file that silently overflows.
Known bugs to fold into the redesign rather than patch: memory truncation at 4 KiB; dismissed items
recur as new items; item `kind` is never patchable; the snapshot advances even when the model
skipped changes or hit the step cap, so those changes are lost; the review prompt mismatch; a
finished short session is not detected; the model does not follow the provider setting.

---

## 3. What Muse does, and what we take from it

Meta's **Muse** (September 2026) is a consumer personal agent that works on goals in the background.
It runs one persistent "Secure VM" per user, with a coordinator model that delegates to nested
sub-agents tracked in Postgres, a separate guard agent ("Sentinel") that approves anything reaching
the outside, and a harness copied from OpenClaw (`SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`).
Muse Code, its coding sibling, adds long-lived background helpers, isolated worktrees per writer,
and a write-ahead event log so crashed runs restart exactly.

The design principles we keep (the full checklist is in the research notes):

1. **A coordinator, not a workhorse.** The agent delegates: ACP sessions in worktrees for code,
   bounded helper turns for research and summarizing, scheduled jobs for monitoring.
2. **Chat you do not take turns in.** Background work never blocks the conversation.
3. **Goal, then plan, then background work.** It speaks up only on a state change or a decision.
4. **Status everywhere.** A live status line, an Activity log of everything done and planned, an
   Upcoming list of scheduled work.
5. **Approvals outside the transcript**, with scoped grants (once / this task / this repo / always),
   so injected text in a transcript cannot forge one. Autonomy follows reversibility.
6. **Memory as evidence.** Claims with provenance (source, quote, confidence), superseded rather
   than overwritten, validated on a schedule, with a nightly reflection pass. Forgetting is a real
   workflow, not a deletion.
7. **The harness is inspectable.** Memory and system files are visible in the UI.

What we deliberately do not copy: the consumer persona features, the "Ideas" feed (dropped), a
separate guard model (the approvals gate is deterministic server code), cloud hosting, and Muse's
proactivity-as-data-grab. Portal's world model covers only the user's Portal projects.

From **Instinct** (Spear Street) and the wider survey we take: a small always-loaded core plus a
retrieved tail; one fact per record; `(subject, key)` uniqueness among active records so
contradictions are detectable; explicit authority (user-stated vs observed vs inferred); a
consolidator that is the only writer of the curated tier while explicit user statements apply
immediately; procedures kept apart from facts; and must-always rules living in code, not memory.

---

## 4. Target architecture

Three layers on top of the phase 1 server:

**Layer 1: world state (generated, never curated).** A live model of the user's Portal: projects
mapped to repo owner/name and default branch, worktrees and their branches, open PRs (authored,
review-requested, recently touched) with checks/review/conflict state, sessions with activity and
titles, active intents and jobs. Rebuilt on tick and on events, rendered to roughly 1–2k tokens at
the top of every prompt, snapshotted for diffing. `resolve_pull(number)` is a deterministic lookup
across known repos, so "PR 2367" needs no guessing.

**Layer 2: memory (curated).** Entities (people, repos, task types, global) each with a summary,
and records: one claim each, with `type` (preference, feedback, convention, fact, procedure,
reference), `key`, `status` (active, proposed, superseded, expired, archived), `scope`, `authority`
(user_stated, user_confirmed, observed, inferred), `source` (session, message, quote), `trust`,
`pinned`, `review_by`, `supersedes`. Unique `(entity, key)` among active records. The **inbox** is
`status = proposed`. Every change writes a revision row. A generated `CORE.md` (pinned directives
plus one index line per entity) is injected each turn; the rest is retrieved by scope (repo of the
current session, task type, person named) and full-text search. The orchestrator **interprets**
procedures ("how I review Y's PRs") when it writes a session prompt; it never pastes them verbatim.

**Layer 3: intents and jobs (scheduled).** Structured rows, not prose. Intents are standing
"when X, do Y" with trigger, action, scope, expiry, fire budget and cooldown; cancel is explicit.
Jobs have a schedule (`every`, `cron` or `at`), a payload, `next_run_at`, and runs with logs and
usage. A worker loop claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, woken by LISTEN/NOTIFY
with a polling fallback. The current 10-minute tick becomes the default `tick` job; the agent
creates the rest (a PR monitor at two minutes, a curation pass at night, a helper turn now).

Cross-cutting: an append-only `activity_log` (who did what, with refs) that the Activity view and
audits read; an `approvals` table with scoped grants; threads (one main, side threads per task) so
chat and jobs never share a lock; a frontier Anthropic model for chat and curation and a cheap model
for tick bookkeeping; usage recorded per run.

Planned tables: `activity_log`, `world_snapshots`, `memory_entities`, `memory_records`,
`memory_revisions`, `intents`, `jobs`, `job_runs`, `threads`, `messages`, `approvals`; `items`
loses the `ideas` list. New routes: `/api/world`, `/api/memory/**` (entities, records, inbox
approve/reject, revisions), `/api/jobs/**`, `/api/intents/**`, `/api/approvals/**`,
`/api/activity`, `/api/threads/**`.

---

## 5. Phases

Each phase ends green on `pnpm test`, the Playwright suite, and a live check on a scratch instance,
and is committed.

### Phase 0: prerequisites (done)

Colima repaired after the September 10 disk-full corruption; `docker-compose.yml`; Postgres 18
with pgvector on port 5433.

### Phase 1: split to server + Postgres, behaviour unchanged (done)

1. pnpm workspace, `apps/web`, `apps/server` skeleton, `packages/contracts`, Next rewrites, `pnpm dev`.
2. Drizzle schema for every domain, migrations, Postgres client, throwaway database per test file.
3. ACP runtime and sessions into the server; both SSE streams; a `subscribe` API on the runtime.
4. Projects, worktrees, git, GitHub summary; Postgres `ProjectsStore` with an in-memory cache.
5. Settings in Postgres; credentials encrypted under the server key; web settings dialog unchanged.
6. Terminals and Socket.IO on the Fastify server.
7. Orchestrator as is onto a Postgres store; deps from the app context; scheduler at boot.
8. Importer from `~/.portal`; `server.mjs` and `instrumentation.ts` removed.
9. Playwright starts server plus web; README rewritten; `packages/shared`; launchd template.

### Phase 2: orchestrator v2 core (done; see §1.5 and §1.7)

Goal: the coordinator never blocks, knows the world, remembers with provenance, and asks before
doing anything irreversible. Behaviour visibly changes for the user in this phase.

1. **Concurrency.** Chat turns and jobs run independently (a lock per thread, not per process).
   Stop cancels only the chat turn. Item actions check status and emit events.
2. **Jobs and intents.** Tables, worker loop, `job_runs` with usage; the tick becomes a job whose
   cadence follows presence; tools `schedule_job`, `cancel_job`, `create_intent`, `cancel_intent`,
   `run_helper` (a bounded sub-turn recorded as a run). Persisted schedule survives restarts.
3. **World state.** Builder over projects, worktrees, sessions and the GitHub query already in the
   digest; prompt rendering with a token budget; `world_snapshots`; `resolve_pull`,
   `resolve_repo`, `resolve_session` tools; `/api/world` for the UI.
4. **Memory.** Tables, validator (frontmatter-equivalent checks, unique active key, no secrets,
   untrusted content can never become a directive), tools `remember` (user-stated, immediate),
   `propose_memory` (observed, to inbox), `search_memory`, `explain_memory` (evidence), `forget`
   (retraction with lineage), `CORE.md` generation frozen per turn, scoped retrieval by repo, task
   type and person. Import of the old `memory.md` into records via the inbox.
5. **Approvals.** `needsApproval` on destructive tools (remove worktree, delete session, shell
   commands that write, anything outbound) and on server-side card actions; scoped grants;
   approval requests as their own SSE event and dialog, never a chat message.
6. **Model.** Frontier Anthropic model for chat and curation, cheap model for tick bookkeeping;
   model follows the provider setting; usage recorded on every run.
7. **Fold-in fixes** from §2: memory size, dismiss stickiness, patchable `kind`, snapshot advances
   only for handled changes, review prompt, short-session finish detection.
8. **UI.** Remove Ideas. Needs-you stays. New: Goals/Upcoming (intents and jobs with next run),
   Activity log, Memory browser (entities, records, inbox approve/reject, revisions), System view
   (`CORE.md`, world state), live status line, approvals dialog. Talk to Portal page keeps one
   main thread and gains side threads.

Exit: "review PR 2367" resolves to the monorepo without a question; the user can chat while a job
runs; a destructive tool call shows an approval card; the memory browser shows every record with
its source; all of it under test.

### Phase 3: flows and reflection (done; see §1.8 and §1.7)

Goal: the three flows the user asked for, end to end, plus the background hygiene that keeps the
memory trustworthy.

1. **"Review PR N."** Resolve repo → ensure worktree → start a session with a prompt the
   orchestrator writes from `people/<author>/review-style` and `task-types/code-review` records →
   a watch job at the agent's chosen cadence → a summarizing helper turn when the session finishes
   → a Needs-you item with the real findings and links.
2. **"Monitor PR N until merged."** An intent plus a job; cadence chosen by the agent; notifies on
   state changes only; explicit cancel.
3. **"Remember that ..."** `remember` with `authority: user_stated`; observed facts from sessions
   and PRs go to the inbox.
4. **Consolidator job** (nightly or idle): promote recurring inbox items; detect `(entity, key)`
   contradictions and propose supersession; expire past `review_by` into a re-confirm list;
   regenerate `CORE.md` and entity summaries; refuse a rewrite that loses more than 25% of records;
   log revisions and activity; write a human digest.
5. **Sub-agents.** Bounded helper turns as `job_runs` with usage, for research, summarizing and
   curation; nested delegation only where a flow needs it.

Exit: the three flows work on the user's real projects; the consolidator has run on real inbox
data with its diff visible in the UI; the activity log explains every action the agent took.

---

## 6. Decisions on record

- Target is Muse's **personal agent** interaction model, not Muse Code.
- The orchestrator may run its own sub-turns and sub-agents; it is not limited to starting sessions.
- No Ideas list. Keep Needs-you plus Goals/Upcoming.
- Per-token cost is not a constraint: frontier model for chat and curation, cheap model for
  bookkeeping.
- Cadence is 100% agent-configurable through jobs and intents.
- World model and curated memory are visible in the UI for auditing.
- Observed facts go to an inbox; user-stated facts apply immediately; the orchestrator interprets
  procedures rather than pasting them.
- Postgres in Docker from the first commit; the server owns everything stateful including
  credentials; Next.js is a frontend only.
- Node 24 + pnpm + Fastify 5 + Drizzle/postgres.js. Bun was abandoned. Socket.IO stays.
- Bearer-token auth for external clients (CLI, Hermes): later. Single user for now.
- Talk to Portal matches the session pages: same composer and send behaviour, same aurora, and a
  thread in prose, with actionable detail only in the Needs-you strip.

## 7. Open questions

Settled during phase 2: the live Portal was cut over before phase 2; side threads are opened by the
agent only and retrieve memory for their own scope (plus CORE.md); no notifications outside the
Portal UI for now. Settled for phase 3: the consolidator runs nightly around 03:00 and when the
inbox reaches about ten items (at most hourly), all configurable in Settings; its digest is one
line in the main thread with the full digest and diff on the run's page; monitors report merged,
closed, checks failing and recovering, changes requested, approved, and conflicts, with new
comments opt-in per monitor.

- Embeddings: not needed for phase 2 (scoped retrieval plus full-text search); pgvector is
  installed if phase 3 wants semantic search over the journal.
