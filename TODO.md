# TODO

- [ ] **List sessions started from the CLI.** Both adapters implement ACP `session/list`; Portal could surface conversations started from `claude` or `codex` directly, importing them into its own log on first open (`session/load` replays the transcript).
- [ ] **Session retention.** Logs under `~/.portal/sessions/logs` grow without bound; add an age or size limit, or archive old sessions.
- [ ] **Session store scaling.** `index.json` is rewritten whole on every metadata change and startup scans every log end to end (measured 5.8 s and 650 MB for 1,500 large sessions), with one append handle held per persisted session. Split per-session metadata out of the index, record the event count so startup only checks the tail, cap startup concurrency, and close idle handles.
- [ ] **Let agents read terminals.** Codex's desktop app can read (not type into) the thread's terminal. ACP has a `terminal` client capability, but it is the reverse direction (agent-driven commands in client PTYs); exposing tab output to the agent would need a Portal-specific bridge such as an MCP tool.
- [ ] **Worktree follow-ups.** Worktrees are projects of their own that remember their original project (see README, *Worktrees*). Still missing: checking out fork PRs (needs a second remote), listing remotes other than `origin`, and refreshing (`git fetch`) from the picker instead of relying on what the repository already knows.
- [ ] **Per-project default agent.** Remember the last agent used per project and preselect it on the start page.
