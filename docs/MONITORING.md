# Monitoring: memory, disk, and idle agent processes

Date: 2026-10-21. Status: **built** (section As built); not merged. Branch `manage-memory-and-storage`.

## Why

When Moses runs several agents, the Mac (16 GB RAM, 460 GB disk) runs out of memory or disk. Research on 2026-10-21 (live machine, system logs, the code, and outside sources) found:

- **Disk filled four times in ten days** (10-12, 10-14, 10-19, 10-19/20). Each time, Portal's own Postgres (in Docker) crashed with an fsync I/O error within minutes. On 10-20 it then refused connections for about an hour.
- **Kernel panic on 10-18** (watchdog timeout, low swap, 64 MB free). Processes held about 39 GB on the 16 GB machine: Bazel servers 9.8 GB, node 9.0 GB, rustc 6.2 GB, 136 Bazel test Postgres processes 2.3 GB, Docker 2.2 GB, **claude (10 sessions) 2.15 GB**.
- The agents are cheap: a `claude` CLI is about 350 MB, a Codex session about 530 MB. The cost is what they run in monorepo worktrees. One Bazel server per worktree (1.4–2.6 GB, idles 3 h by Bazel's default, no heap cap), and Bazel output of 10–88 GB per worktree (154 GB in total today).
- **Portal can't see any of this.** Nothing measures memory or disk (`apps/server/src/lib/process-probe.ts` runs `ps` without memory columns), and Portal keeps no log file.
- **Portal also adds to it:** a `claude` CLI lives until its session is deleted, and simply opening a session starts one (`apps/server/src/sessions/viewer.ts:120`). Adapters and scripts are not killed as process groups, so their children can be left running.

## Goals

1. A **Monitoring** view that shows memory, swap, pressure, disk, and what uses them, attributed to sessions and worktrees, with manual actions.
2. Portal **stops idle agent CLIs** after a configurable time and resumes them on the next prompt.
3. Portal **cleans up after itself**: process groups, leftovers after a crash, and a log file.
4. Two **room objects**: a barometer for memory and a jar for disk.
5. Works on **macOS now and Linux later**, with no Bazel-specific (or any repo-specific) code.

The Bazel settings change goes to the monorepo as a separate PR (section Monorepo PR).

## Decisions on record

| # | Topic | Decision | Whose call |
|---|---|---|---|
| 1 | Placement | New sidebar entry **Monitoring**, a Portal view next to Watches, Activity, Memory, System. | Moses |
| 2 | Acting | **Numbers only.** Portal never holds turns or removes anything on its own because of memory or disk. The only automatic action is the idle CLI stop (#4). | Moses |
| 3 | Actions | Monitoring has manual actions: stop a process, stop a session's CLI, remove a worktree, run the cleanup script on a worktree. | Moses |
| 4 | Idle CLI stop | On by default, after **2 hours** idle; configurable. | Moses |
| 5 | Alerts | Colour in Monitoring only. No Needs-you items, no foyer-card warning, no notifications. | Moses |
| 6 | Disk levels | Warning below **30 GB** free, critical below **15 GB**; configurable. | Moses |
| 7 | Room | Brass wall **barometer** (memory pressure) and a **jar** on a pantry shelf (disk used). | Moses |
| 8 | Old session events | Shown as a size only; no retention yet. | Moses |
| 9 | No repo-specific code | Bazel stays out of Portal. Bazel processes and folders show up through generic rules (attribution by path, watched folders, the user's script). | Moses |
| 10 | Scripts | No new script kinds. "Run cleanup script" reuses the existing `preWorktreeDelete` script on a live worktree. | Moses |
| 11 | Linux | Written for Linux but not tested there. Moses fixes it on the Linux box if it breaks. | Moses |
| 12 | Configurable vs fixed | As in section Settings. | Moses |
| 13 | Memory measure on macOS | Footprint (what Activity Monitor and jetsam use), from `top`. RSS undercounts idle agents, because macOS compresses them. | mine |
| 14 | Sampling | System numbers every 60 s, always (cheap). The process table every 5 s while a Monitoring view is open, otherwise not at all. Folder sizes on open if older than 10 min, every 10 min while open, and on Refresh. | mine |
| 15 | History | An in-memory ring of system samples (60 s × 24 h) for the memory, swap and disk charts. Lost on restart, never written to the DB. | mine |
| 16 | Idle clock | The stop clock starts at the later of `idleSince` and when the CLI was last attached, so opening an old session gives it the full 2 hours. Opening a session still attaches, as today (mode and config replay depend on it). | mine |
| 17 | Idle stop audit | Each automatic stop is logged to Activity (`session.cli_stopped_idle`), the same way idle worktree removal is. Activity is a log, not an alert, so it doesn't conflict with #5. | mine |
| 18 | Stop scope | "Stop process" is offered only for processes attributed to a session, a worktree, or Portal. Unattributed processes (Chrome, Docker, …) are listed but can't be stopped from Portal. | mine |

## Vocabulary

- **System sample**: one reading of memory, swap, pressure, and free disk on the volumes Portal cares about.
- **Pressure**: `normal`, `warning` or `critical`, one shared scale across operating systems (section Probe).
- **Process table**: one snapshot of every process with pid, ppid, pgid, memory, elapsed time, and command. It extends the existing `process-probe.ts`.
- **Attribution**: which owner a process is charged to. The owners are a session, a worktree, Portal itself, or none.
- **Disk survey**: cached folder sizes for Portal's home, each worktree, image blobs, logs, the database, and the watched folders.
- **Watched folder**: a folder outside Portal whose size the user wants to see (e.g. `~/Library/Caches/bazel`, `~/.codex`, `~/.claude`).

## The Monitoring view

Portal view `monitoring` (an overlay with an internal path, `portalPath("monitoring")`, like System and Activity), sidebar entry **Monitoring** (icon `Gauge`), added to `PortalView`, `portalViews`, `viewMeta` and `sidebarViews` (`apps/web/src/components/portal/views.tsx`, `apps/web/src/lib/session-routes.ts`). It has no badge.

Top to bottom:

1. **Summary strip**: four tiles.
   - Memory: used of total, plus the pressure label.
   - Swap: used of total.
   - Disk: free on the volume holding Portal's home.
   - Agents: live CLIs and their combined memory.

   Each tile is coloured by level: normal is neutral, warning amber, critical red. Memory follows pressure; swap follows pressure too, with no level of its own; disk follows the configured levels.
2. **Charts**: memory used, swap used, and free disk over the last 24 h from the history ring, as small line charts with the levels drawn as bands.
3. **Sessions**: one row per session with a live CLI. Columns: title, project, state (the shared `sessionState`), memory of its process tree, process count, how long it has been idle, and when the idle stop will fire. It expands to the process tree (command, pid, memory, age). Actions: **Stop CLI**, and **Stop** per child process.
4. **Worktrees**: one row per Portal worktree project. Columns: name, size on disk, sessions, memory of processes attributed to it (e.g. a Bazel server, a dev server, test databases) and their count, and the lifecycle state ("removal in 31 h", "kept: uncommitted changes for 9 days", "pinned"). A worktree kept for uncommitted changes for more than 7 days is highlighted. It expands to its processes. Actions:
   - **Stop** per process.
   - **Run cleanup script**: runs `preWorktreeDelete` in the worktree without removing it. Disabled when no script is set or a session in that worktree is busy, and asks for confirmation.
   - **Remove worktree**: the existing removal path with its existing confirmations.
5. **Portal**: the server, the web server, the adapters, and Postgres (container or local), each with its memory.
6. **Other processes**: the 15 largest processes not attributed to anything, read-only.
7. **Disk**:
   - Free and total per volume.
   - Portal's home split into worktrees (total), blobs, logs and other.
   - The database total and its five largest tables.
   - Each watched folder with its size and its 10 largest children (name, size, last modified).
   - A note that sizes are measured with `du`, so files shared through APFS clones or hard links are counted in each place.
   - **Refresh** button and "measured 4 min ago".

Phones: the same sections stacked; tables become cards.

## Server

### Probe (`apps/server/src/monitoring/probe/`)

One interface, two implementations, chosen by `process.platform`. Every other OS returns `null` and the view shows "Not supported on this OS".

```ts
type SystemSample = {
  at: number;
  memory: { totalBytes: number; availableBytes: number; usedBytes: number };
  swap: { totalBytes: number; usedBytes: number };
  pressure: { level: "normal" | "warning" | "critical"; raw: string };
  volumes: { path: string; totalBytes: number; freeBytes: number }[];
};
type ProcessRow = { pid; ppid; pgid; elapsedSeconds; cpuSeconds; memoryBytes; command; cwd: string | null };
```

| Reading | macOS | Linux |
|---|---|---|
| Total memory | `os.totalmem()` | same |
| Available / used | `vm_stat` (free + inactive + speculative + purgeable pages) | `MemAvailable` in `/proc/meminfo` |
| Swap | `sysctl vm.swapusage` | `SwapTotal` / `SwapFree` in `/proc/meminfo` |
| Pressure | `sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical | `/proc/pressure/memory`. Critical when `full avg10` ≥ 10 or available < 5 %; warning when `some avg10` ≥ 10 or available < 10 %; normal otherwise (mine, fixed) |
| Free disk | `fs.statfs` | same |
| Process list | one `ps -A -o pid=,ppid=,pgid=,etime=,time=,rss=,command=` (POSIX keywords, same on both) | same |
| Process memory | footprint from one `top -l 1 -stats pid,mem` per table read; RSS where top fails | RSS from `ps` |
| Working folder | one `lsof -a -d cwd -Fpn -p <pids>` for the candidate processes (section Attribution) | `readlink /proc/<pid>/cwd` |
| Folder size | `du -sk -x <path>` under `nice` | same |
| Database size | `pg_database_size`, `pg_total_relation_size` per table | same |

`process-probe.ts` keeps its role for liveness. Its `ps` arguments gain `pgid` and `rss`, so liveness and monitoring share one table read when both want one in the same tick.

### Attribution (`apps/server/src/monitoring/attribution.ts`)

Each process is charged to the first owner that matches:

1. **Session**: the process is the session's CLI root (`findSessionRoot`) or a descendant of it.
2. **Portal**: the server itself, its children that are adapters (`descendants(serverPid)` minus session trees), the web server (found by its listening port), and Postgres (on macOS the VM of the container runtime the port's listener belongs to: Colima/Lima, Docker Desktop, OrbStack or Podman, a Virtualization.framework VM recognised by that runtime's disk images among its open files, never any other app's VM; on Linux the container's processes, from `docker ps --filter publish=<port>` whether or not a listener was seen).
3. **Worktree**: the process's working folder, or a path in its command line, is inside a Portal worktree's folder. A Bazel server matches through `--workspace_directory=<path>` with no Bazel-specific code, and so do dev servers and test databases started inside a worktree. Only processes using more than 20 MB get their working folder looked up, to keep `lsof` cheap. A process that matches nothing on its own inherits the worktree of its nearest ancestor that did (`inheritedFrom` in the row); only worktrees are inherited.
4. **None**: everything else.

A process whose parent is pid 1 and that is charged to a session or a worktree is marked **orphan** in the view.

### Disk survey (`apps/server/src/monitoring/disk.ts`)

Runs `du` over: each worktree folder, `<portalHome>/blobs`, `<portalHome>/logs`, the rest of `<portalHome>`, and each watched folder with its immediate children. Runs one at a time under `nice`, cached in memory with a timestamp, and is never started twice at once. Database sizes come from the same pool as everything else.

### Sampler and API

- `monitoring/sampler.ts` takes a system sample every 60 s into the 24 h ring. It runs whether or not a browser is open; it is a handful of `sysctl`/`statfs` calls.
- `GET /api/monitoring` returns the latest sample, the ring, the attributed process table (read fresh, at most once per 5 s whoever asks), the session and worktree rows, and the cached disk survey with its age. It starts a survey when the cached one is older than 10 minutes.
- `POST /api/monitoring/disk/refresh` starts a survey now.
- `POST /api/monitoring/folders/check` `{ paths }` says whether each folder exists now (`~` expanded, at most 20), for the watched-folder warning in Settings.
- `POST /api/monitoring/processes/:pid/stop` sends SIGTERM to the process (its group, when it leads one), then SIGKILL after 5 s. It decides on a table at most 5 s old and refuses unless the row is `stoppable`: attributed to something, not inherited (stop the process it came from), not Portal's server, web server or database (an adapter may be stopped), not the server or anything above it, and not in a process group with any of those. Each row carries `stoppable` and `stopBlockedReason`, so the view shows the same rules. Just before the signal the table is read again, and the process must still have the same command and start time (and, for a group, still lead it).
- `POST /api/sessions/:id/stop-cli` runs the idle stop for one session now.
- `POST /api/projects/:id/cleanup-script` runs `preWorktreeDelete` in the worktree, with the same environment as before a delete plus `PORTAL_SCRIPT_TRIGGER=manual` so a script can tell the two apart. It answers 409 while a session in that worktree is busy.
- The portal stream gains a `monitoring` event every 60 s with the summary only (pressure level, memory used, swap used, disk free and level), for the room and the summary strip. The view polls `GET /api/monitoring` every 5 s while it is open.

### Idle CLI stop (in `acp-runtime.ts`, next to the probe timer)

Every minute, for each session whose link is live:

- **When it fires:**
  - The session is idle: `idleSince` is set, meaning no open turn, no pending approval and no background work, which is the lifecycle rule.
  - The stop clock, `max(idleSince, attachedAt)`, is older than `sessions.idleStop.afterMinutes`.
  - The setting is on.
- **Stop:** the steps of `deleteSession` up to and including `detach`: `session/close` when the agent supports it, with a timeout, then detach. Nothing is deleted. The link goes offline, as after a server restart.
- **Kill check:** if the session's CLI root is still in the next process table 10 s later, kill it with SIGTERM, then SIGKILL after 5 s.
- **Empty adapter:** when an adapter has no live sessions left, it is stopped too. That covers Codex, where one `codex app-server` (about 410 MB) serves every session.
- **Resume:** the next prompt resumes the session through `openTurn`, which already attaches when the link isn't live (`acp-runtime.ts:1257`). So does the queue, and so does opening the session.
- **Activity:** `session.cli_stopped_idle`, with the session and the time it had been idle.

### Process cleanup

- **Adapters** are spawned with `detached: true` (their own process group). `fail()` and `dispose` kill the group (`-pgid`), SIGTERM then SIGKILL after 5 s.
- Their pgids are written to `<portalHome>/run/adapters.json`, each with the pid and start time of the server that started it. On boot, a listed group is killed before new adapters start when its server is no longer running and it still looks like that adapter (orphaned, same command and start time), which covers a server that crashed or was SIGKILLed; a group whose server still runs (another server on the same Portal home) is left alone and stays listed.
- **Scripts** (the configured scripts: `preWorktreeDelete` and the others, and Run cleanup script): the script's process group is killed after a normal exit too, not just on timeout, so nothing a script backgrounds outlives it. The orchestrator's `run_command` is not a script and keeps its old behaviour. A worktree's removal and its cleanup script never run at once (the second gets a 409).
- **Terminals:** unchanged (a terminal's job is to keep what you start).
- **Session delete:** after `session/close`, the session's CLI tree is checked and killed, as in the idle stop.

### Log file

The server writes its Fastify log and `console.*` output to `<portalHome>/logs/server.log` as well as stdout, rotated at 10 MB with 5 files kept. Monitoring shows the folder's size.

## Settings

New fields:

| Setting | Path | Default | Range |
|---|---|---|---|
| Disk warning level | `monitoring.disk.warnFreeGb` | 30 | 1–10 000, above critical |
| Disk critical level | `monitoring.disk.criticalFreeGb` | 15 | 1–10 000 |
| Watched folders | `monitoring.watchedFolders` | `[]` | up to 20 absolute paths; `~` expanded |
| Stop idle agent CLIs | `sessions.idleStop.enabled` | true | |
| Idle time before stopping | `sessions.idleStop.afterMinutes` | 120 | 10–10 080 |

The Settings dialog gains a **Monitoring** section with the disk levels and watched folders (one path per line; a missing folder shows a warning but is kept). The idle stop goes in the existing Sessions section, beside worktree removal.

Already configurable and unchanged: `scripts.preWorktreeDelete`, `sessions.worktrees.removeAfterHours`, the hung-after minutes.

Fixed in code: pressure levels, sampling rates, attribution rules, the 20 MB lookup floor, the stop grace (5 s), the 7-day highlight for kept worktrees, log rotation, the history length.

## Room

Two live objects, following the PALACE rules: each stands for one fact, hovering shows a card with the numbers, and clicking opens Monitoring. They change only when the numbers change; nothing animates at rest. They read the portal stream's `monitoring` event; with no event yet (or an unsupported OS) they show a resting state and the card says so.

- **Barometer** on the back or left wall (the free spot is picked during the build). Its needle points to normal, warning or critical, with a small eased swing when the level changes. Card: memory used, swap, and pressure.
- **Jar** on a small pantry shelf. Its fill is the used fraction of the volume holding Portal's home. The lid is neutral, amber or red by the disk levels. Card: free and total, the five largest items from the last survey, and when it was measured.

Both go into `apps/web/src/room/live.ts` (state mapping and hover text, unit-tested) and `scene/Barometer.tsx` and `scene/Jar.tsx`. They are added to the `data-room` summary for tests and to `sketch.ts`, so the loading sketch lines up.

## Monorepo PR (`liquid-labs-inc/monorepo`, separate from Portal)

Add to `.bazelrc`:

```
# Let idle Bazel servers exit: after an hour, or sooner when the machine is short of memory.
startup --max_idle_secs=3600
startup --shutdown_on_low_sys_mem
# Cap each server's heap; Bazel's default is a quarter of RAM per server.
startup --host_jvm_args=-Xmx3g
# One action cache shared by every checkout of the repo.
build --disk_cache=~/.cache/bazel-disk
```

Notes:
- **The repo is shared**, so these flags reach teammates and CI. Startup options can't be scoped with `--config`. If that's unwelcome, the same lines go in a `try-import %workspace%/user.bazelrc` or `~/.bazelrc`.
- **`-Xmx3g`** is checked against a full `quant-api` test build (the biggest server today is 2.6 GB footprint) and raised if the build runs out of heap.
- **The disk cache** grows without a limit unless garbage collection is set. The Bazel 9.1 flag for a maximum disk-cache size is confirmed and added in the PR.

## Tests

- **Shared:** settings validation and merge for the new fields; the pressure mapping from raw Linux and macOS values; the level for a disk reading.
- **Server:**
  - Parsers for `vm_stat`, `sysctl vm.swapusage`, `top -l 1`, `ps`, `lsof -F`, `/proc/meminfo`, `/proc/pressure/memory`, using captured strings (no live Linux run).
  - Attribution over a fixture table (session tree, adapter, worktree by cwd, by command-line path, orphan).
  - The idle stop clock (idle, attach time, setting off, busy, pending approval, background work) with a fake clock.
  - The stop route's refusals.
  - The adapter pgid file on boot.
  - The script group kill after a normal exit.
  - Routes.
- **Web unit:** row building and level colours; the room objects' mapping and hover text.
- **Playwright (`tests/ui/monitoring.spec.ts`):** the sidebar entry opens the view; tiles and colours render from a fixed fixture; Stop CLI calls the route; the room's `data-room` reports the barometer level and jar fill.
- **Live check** on a scratch instance with a cloned DB (see the e2e safety notes):
  - the numbers match Activity Monitor within reason;
  - a session's CLI stops at a lowered idle setting and resumes on a prompt;
  - Stop on a worktree's process works;
  - the cleanup script runs.

## Implementation order

Each step ends green and committed.

1. **Probe and sampler:** the shared types, macOS and Linux probes, parsers with tests, the history ring, `GET /api/monitoring` with the system part, and the stream event.
2. **Attribution and disk:** the process table with memory and pgid, attribution, the disk survey, database sizes, and the rest of the route.
3. **View:** the sidebar entry, route, summary, charts, sessions, worktrees, Portal, other, disk, and refresh.
4. **Settings:** the new fields, the Monitoring section, the idle stop in Sessions.
5. **Actions and idle stop:** the stop route, Stop CLI, Run cleanup script, Remove worktree, the idle stop timer, the Activity entry, and empty-adapter shutdown.
6. **Cleanup:** adapter process groups, the boot sweep, the script group kill, the CLI tree check on delete, and the log file.
7. **Room:** barometer and jar.
8. **Polish:** Playwright, the live check, and an As built section here.

The monorepo PR is drafted alongside, and opened only when Moses says so. No DB migration is needed; settings live in the existing settings row. The live instance needs a rebuild and restart.

## As built (2026-10-21)

Built by subagents, reviewed (server and web reviews, every finding fixed) and live-checked on a scratch instance (empty database, scratch home) against this Mac. Changes from the spec above:

- **Route:** Monitoring is a Portal overlay view like System, not a browser route.
- **Stop rules (server-owned):** each process row carries `stoppable` and `stopBlockedReason`; the view only shows them. Refused: unattributed processes, inherited rows, Portal's server, web server and database (adapters may be stopped), the server and every process above it, and any process whose group holds one of those. The stop re-reads `ps` when the table is older than 5 s and signals only if pid, command and start time still match.
- **Inheritance:** a process with no match of its own inherits the worktree of its nearest ancestor that matched, shown as "via pid N" and not stoppable (stop the ancestor). This is how a build server's children and test databases count with their worktree.
- **macOS database VM:** only the VM of the container runtime serving the database port (colima/lima, Docker Desktop, OrbStack, podman, identified through its open disk images) is charged to Portal; other VMs are "none".
- **Adapter sweep:** `adapters.json` entries record the owning server (pid and start time); groups of a server that is still running are never killed, so two servers sharing a home don't kill each other's adapters.
- **Script group kill** applies to configured scripts (pre-delete and the manual cleanup), not to the orchestrator's `run_command`.
- **Worktree work lock:** a removal and a cleanup script never run at once on one project (409 either way); the sweep retries next time.
- **Watched folders:** `POST /api/monitoring/folders/check` reports which exist; Settings uses it on open and after a save.
- **Log rotation:** five files in all (`server.log` and `.1`–`.4`).
- **Units:** memory in binary units (as Activity Monitor), disk in decimal GB (as Finder and the levels); one shared `formatBytes`.
- **Noise:** the server's own `ps`/`top`/`lsof`/`du` runs are left out of the table.

Live check results: memory, swap and disk matched `vm_stat`, `sysctl` and `df`; process footprints matched `top` to the MB; a Haiku session stopped 24 s after its 10-minute mark (CLI and adapter exited, Activity entry written) and resumed on the next prompt with its context, model and mode; every refusal held; the cleanup script ran with `PORTAL_SCRIPT_TRIGGER=manual` and its backgrounded `sleep` was killed; a frozen adapter group left by a `kill -9`ed server was killed on the next boot. A plain `kill -9` leaves no orphans at all (adapters exit on stdin EOF).

Known gaps: stopping a process that doesn't lead a group leaves its children running (they drop out of the worktree's rows). The monorepo PR is still a draft.

## Out of scope

- Holding turns or limiting concurrency under memory or disk pressure (decision 2).
- Alerts outside the view (decision 5).
- Retention for session events, the activity log, or `~/.codex` and `~/.claude` (decision 8; sizes are shown).
- Blob garbage collection (60 MB today).
- Hard memory caps per session (possible on Linux with cgroups, not on macOS).
- Smaller Rust test binaries (debug-info flags) and the Bazel test Postgres write volume: monorepo work, raised separately.
- The `pnpm` / `concurrently` launcher chain (about 470 MB) and leftover `portal_test_*` databases.
