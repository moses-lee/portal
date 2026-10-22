# Watches redesign

Status: built 2026-10-22 on branch `fix-watches`. Where the build differs from the plan, the "As built" section at the end says so.

Vocabulary: a **watch** is an intent in code, in the DB (`intents`), and in REST. See the root CLAUDE.md.

## Why

The 2026-10-22 audit of the live DB found these problems:

- **Checks run on a cut-down agent.** They use Sonnet 5 with 14 of about 80 tools and a 12-step cap. They still read the main agent's system prompt, which names tools they don't have.
  - The main agent wrote check notes telling the check to "use run_command/curl/gh api". Checks couldn't follow them.
  - Examples: the status-page watch never fired, the merge-queue watch was blind, and the commits watch guessed.
- **Junk firings and closes.** Checks call `fire_watch` with the title "NO_UPDATE" or "placeholder". They call `close_watch` with reasons like "this call was a mistake". The result is junk Needs-you items, junk chat posts, and watches closed by accident.
- **Watches end too early.** Fire budgets of 1, or the model calling a watch "fulfilled", end it while the user is still working in the session.
  - HMBh0kqS closed, then 32 more prompts followed.
- **Watches never end.** 85 of the last 90 watches had no expiry.
  - One watch on sessions dead since 10-13 was still checked every 5 minutes on 10-22.
  - The four active watches ran about 2,500 checks a day.
- **"Always watch sessions Portal starts" is done by hand.** It lives in a memory record, and the main agent creates one watch per session. Some sessions got no watch, and duplicate watches piled up.
- **Noise.** A watch fires on turns the user drove themselves while reading the session (48 firings for prod-readiness).

## Principles

These come from Muse, Muse Code, CopilotKit/openmuse, nanoMuse, Claude Code, Hermes and Devin.

1. **Code detects, the model acts.**
   - Code evaluates triggers: session events and PR state.
   - The model runs only when something happened.
   - Model polling is only a fallback, for conditions that code can't evaluate.
2. **Same harness as chat.** A watch run is a normal turn with the full toolset and the full step cap. It differs from chat in only three ways:
   - Its model is the new `watch` role, Sonnet 5.5.
   - It has a framing prompt.
   - It cannot create watches or jobs (no recursion).
3. **No fire or close tool.** The run's final reply *is* the firing. A reply that starts with `[quiet]` means nothing worth telling. Ending a watch is a code rule, an expiry, or the user.
4. **Dedupe on events, not titles.** Each event has a key, for example `session:<id>:turn:<turnEndedAt>`. An event is handled once.
5. **Model proposes, server clamps.** For expiry, the model picks a lifetime. The default is 7 days and the maximum is 30. Expiry is never silent.
6. **Suppress when present.** A session event is not reported while that session is focused on a visible device.
7. **A standing preference is one rule**, not one watch per instance.

## Design

### Watch shape (migration 0017)

`intents` gains these columns:

- `trigger jsonb`, one of:
  - `{type: "session", sessionIds, on: ["turn_end", "permission", "error", "dead"]}`
  - `{type: "pull", ...}`: today's pull-watch payload, still computed in code.
  - `{type: "review", ...}`: today's review-watch payload, unchanged.
  - `{type: "poll", everyMs, idleEveryMs?}`: a model-checked condition with no event source, such as a status page or the merge queue.
  - `{type: "portal_sessions"}`: the standing rule.
- `once boolean`: end after the first firing ("tell me when X" said once).
- `last_event_key text` and `seen jsonb`: dedupe, plus events that were suppressed because the user was looking. These go into the next run's prompt so they aren't re-reported.
- `renewals int`.

`expires_at` is set on every new watch except the standing rule. `fire_budget` and `cooldown_ms` stay in the table for old rows, but new watches no longer get them. The repeat-title refusal stays only for the code-fired pull watches.

`sessions` gains `started_by text` ('portal' | 'user'). `startSession` sets it to 'portal'.

### Trigger engine (`jobs/watch-events.ts`, new)

- Add `OrchestratorDeps.sessions.onChange`, a wrapper over `acp-runtime` `onSessionsChange`, next to `onDeleted`.
- Map each patch to an event:
  - `turnEndedAt` changed → `turn_end`
  - `awaitingPermission` became true → `permission`
  - liveness became dead or hung → `dead`
  - an error event → `error`
- Settle each session for about 20 seconds, so a queued follow-up turn doesn't fire twice.
- Each event is matched against active watches and the standing rule. A match is never run inline. Instead, the watch's job gets `nextRunAt = now` and the event goes in its payload. The worker then runs it, which keeps today's concurrency limit, leases, cancel guard and run records.
- **Missed events.** At boot, and every 10 minutes, the engine compares each watched session's `turnEndedAt` and permission state against what the watch has seen, and queues anything missed. This covers restarts and a dropped listener.
- **Session deleted** → its watches end (`done`, reason "session removed"). A dead session reports once, then waits until it expires.

### The watch run

- `prepareTurn` gets `kind: "intent_check"` and `role: "watch"`. It offers every tool except `create_watch`, `monitor_pull`, `schedule_job` and `run_helper` with `wait: false`. The step cap is 24 (`MAX_STEPS`).
- Approvals gate tools as they do for any background run. A run that leaves an approval pending ends as `awaiting_approval`.
- The prompt includes:
  - the watch's text, trigger and action
  - its notes
  - **the event**: which session, what happened, and the turn's last assistant text, taken from `sessionProgress` and `reviewText` in review-watch.ts
  - events the user already saw
  - the current time and expiry
- **The reply contract:**
  - A reply of 1–3 sentences is the firing: it updates the watch's Needs-you item and posts to the chat.
  - A reply that starts with `[quiet]` is kept in the run's record, with no item and no post.
  - An empty reply counts as quiet.
- `fire_watch` and `close_watch` are removed from runs. The run keeps:
  - `update_watch` (notes)
  - `renew_watch`, only in the final run before expiry, once, for up to 7 days
  - `end_watch({reason, evidence})`, only on poll watches. The server checks that `evidence` is not empty and logs it.
- The system prompt gets a "This is a watch run" section. The chat-only guidance about tool groups is left out, because every tool is offered up front.

### Presence

- The web client reports focus with `POST /api/workspace/presence {deviceId, sessionId | null, visible}`. It sends it on focus change, on `visibilitychange`, and as a heartbeat every 30 seconds. The server keeps it in memory with a 90-second TTL.
- At a session event: if any device shows that session in its focused pane while visible, the event is recorded in `seen` and not run.
- If the user switches away before the turn ends, the event fires as usual.
- Events the user can't see this way still fire: permission waits and dead sessions while the user is looking at another tab.

### Lifecycle

- `create_watch` takes `expiresInHours?`. The server clamps it to 1–720 hours (default 168) and returns the expiry it actually set.
- **Ending in code:**
  - session watch: when all of its sessions are deleted
  - pull watch: when the PR is merged or closed (as today)
  - review watch: when its report is posted (as today)
  - `once`: after the first firing
- **At expiry:**
  - If the condition can still happen, run one final watch run with an "expiring" note. The model may call `renew_watch` once.
  - Otherwise, close as `expired` and raise one "Watch expired — renew?" item with a Renew action.
- **Failures:** three failed runs in a row pause the watch and raise a "Watch failing" item. A failed run is never logged as "nothing new".

### Standing rule: "Report on sessions Portal starts"

- Stored as a single intent with `trigger.type = "portal_sessions"`, no expiry, and turned on or off in the Watches page.
- It matches sessions with `started_by = 'portal'`, except sessions that already have a review watch from `setup_pr_reviews`.
- **Migration:**
  - Create the rule (enabled).
  - Close the per-session "always watch" watches whose sessions it covers.
  - Supersede the memory record `watch-started-sessions` with a pointer to the rule, so the main agent stops creating one watch per session.
- The main agent's guidance (jobs/prompt.ts) says the rule exists and that per-session watches are for one-off asks.

### Model

- New `ModelRole` `watch`, with default `{anthropic, claude-sonnet-5-5}`.
- It gets a row in Settings → models.
- Verified 2026-10-22: `claude-sonnet-5-5` exists ($2/$10 per M tokens, 1M context), the stored key can use it, and tool calls work. It rejects `thinking: {type: "disabled"}` and probably a forced `tool_choice`; Portal sends neither today, so the watch path must keep it that way. Its default effort is high; consider `effort: "low"` or `"medium"` for watch runs.

### UI (WatchesView)

- **Each card shows:**
  - the trigger in words ("Reports turn ends, permission waits, errors for #3667 session"; "PR #3313 state changes"; "Checked every 5 min")
  - the expiry, with a Renew button
  - the last event
  - the count of seen-and-suppressed events
  - the last run's outcome (fired / quiet / failed)
- "N of B fired" is removed.
- A rule toggle sits at the top.

### Existing data at cut-over

- The four active watches:
  - hRpiut3c, ufPhII3s and Nythqpq0 are per-session "always watch" watches. They close as superseded by the rule if their session has `started_by = 'portal'`. Otherwise they convert to session triggers.
  - J3HiGvD6 (dead sessions since 10-13) converts to a session trigger expiring 7 days after cut-over.
- `started_by` is backfilled to 'portal' for sessions whose `create_session` or `setup_pr_reviews` call appears in `activity_log`.

## Build order

0. Add the `watch` role (`claude-sonnet-5-5`, verified) and its settings row.
1. Watch run on the full harness, with the reply contract (`[quiet]`) and without the fire and close tools. This alone stops junk firings and fixes the missing capabilities, though checks are still polled.
2. Migration 0017 (`trigger`, `once`, dedupe, `started_by`). Trigger engine for session events, plus the reconcile loop.
3. Presence endpoint, web heartbeat, suppression.
4. Lifecycle: expiry clamp, end rules, the final run before expiry with `renew_watch`, expiry and failure items.
5. Standing rule, provenance backfill, data migration of the active watches, superseding the memory record, main-agent guidance.
6. Watches UI.
7. Verification (below).

## Verification

- **Unit and integration tests** (`apps/server/tests/jobs-*.test.mjs`, built on `jobs-harness.mjs`):
  - events map to runs, and dedupe works
  - settle debounce
  - reconcile after a restart
  - presence suppression and switching away
  - `[quiet]` versus a firing
  - expiry clamp, renew, and the expired item
  - three failures pause the watch
  - the rule matches Portal-started sessions and skips review sessions
  - no recursion (no `create_watch` inside a run)
- **UI test:** update `portal-watches.spec.ts`.
- **Live test** on a clone of the live DB with real Sonnet 5.5 runs (the recipe in memory):
  - start a session through the agent and prompt it; expect one firing per turn, and none while focused
  - a poll watch on a status page using `run_command`
  - expire one and renew it
  - kill a session and confirm it reports dead once

## Calls made without Moses (open to change)

- Clicking a "Start session" card action counts as Portal-started, so the rule covers it.
- A dead session is reported once, and its watch then waits until it expires. It does not end immediately, because the session can be reconnected.
- Pull watches stay polled in code every 5 minutes, because Portal has no GitHub push.
- `fire_budget` and `cooldown_ms` columns are kept rather than dropped, to keep the migration small.

## As built (2026-10-22)

Where the build differs from the plan above:

- **No `once` column.** "Fire once" is a fire budget of 1; a watch that keeps reporting has no budget (`create_watch` takes `once`). New watches never get a cooldown. Both columns stay for older rows, whose budgets and cooldowns are still enforced.
- **No `sessions.started_by`.** The standing rule keeps its own list of sessions: `create_session` and the Start-session card action add theirs through `jobs.sessionStarted`, and `setup_pr_reviews` sessions stay out because their review watch reports them.
- **The rule is created lazily.** The first session Portal starts creates it, switched on. The one-time cut-over at boot creates it only when there are per-session "always watch" watches to hand over. A rule the user turned off stays off and is never created again. The memory record `watch-started-sessions` stays as it is; the main agent's guidance says the rule covers it.
- **A session's own watch wins over the rule.** If a session has a watch of its own (the user asked for one), the rule ignores that session's events, so nothing is reported twice.
- **Event keys come from session state**, not from tracking state changes (`sessionEventsOf`):
  - a turn end is `turn:<turnEndedAt>`, once the session is not busy, has nothing queued, and has no permission open
  - a permission wait is `permission:<lastActiveAt>`: one report per prompt, however many permissions that prompt asks for
  - a stall is `stalled:<dead|hung>:<since>`
  
  Because the key comes from state, the same function serves the live path, the catch-up pass, and the run's own reconcile, and no settle timer is needed.
- **The run tools are always offered.** `end_watch` and `renew_watch` are in every run's tool set and refuse at call time when they don't apply, since tool sets are built before the watch is read. `end_watch` used during a run takes effect after the run's reply is delivered (the live test showed a run ending its watch and having its report refused). The run also gets `list_watches`.
- **No special run before expiry.** A run within a day of expiry can call `renew_watch` once. An idle watch simply expires and leaves a "Watch expired" item. The Watches page has "Renew for a week" (`PATCH /api/portal/intents/:id {renew: true}`) and Re-activate.
- **Failures.** After three failed runs in a row, the watch's job is marked failed and an "ask Portal" item says so. The events a failed run took go back to waiting for the retry.
- **Presence is per browser tab.** Each tab reports its own focus. A page surface (Agent, Watches, and so on) over the workspace counts as showing no session. Every event kind is suppressed while its session is in a focused pane on a visible tab.
- **The model role.** `watch` is `claude-sonnet-5-5` on Anthropic and `gpt-5` on OpenAI, set in Settings → Talk to Portal. Effort is left at the default.

**Verified:**
- Server: 866 of 867 tests pass. The one failure, `room-routes` (stream event order), was failing before this work.
- The Watches and Settings Playwright specs pass.
- Live, on a fresh database with real Claude sessions and Sonnet 5.5 runs:
  - the rule was created from `create_session`
  - a turn end fired a report with the session's findings
  - a turn the user watched was recorded as seen
  - a turn after the user looked away fired
  - a permission wait fired once
  - a turn end after a commit fired with the commit
  - a poll watch on githubstatus.com used `run_command` and reported the indicator after the user approved the `curl`
- Live, on a clone of the real database:
  - the three per-session "always watch" watches moved into the rule
  - the watch on dead sessions became a session watch with a seven-day expiry
  - no model ran

**Follow-ups:**
- **Approving "once" doesn't help a background job.** The approved call runs, but the job's rerun is a fresh turn that asks again. "For this job" works. Before this branch, only helpers met this; now watch runs do too.
- **Approve items linger.** "Approve: …" items for approvals already decided stayed open in the live test.
- **Old run summaries.** Runs from before the cut-over still read "Checked; the trigger does not hold yet."
