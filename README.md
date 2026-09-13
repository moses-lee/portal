# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
Next.js app that runs Claude Code and Codex through local ACP adapters and streams sessions to the browser.

## Run

```sh
pnpm install
pnpm dev          # binds 0.0.0.0:3000 so it is reachable over Tailscale
```

Open `http://localhost:3000` or `http://<tailscale-ip>:3000`. Select an agent and working directory, click **New session**, and chat. The selection applies to new sessions; each existing session keeps its original agent.

Sign in on the machine running Portal before creating a session:

- **Claude Code:** run `claude` and complete sign-in.
- **Codex:** run `codex login`. The ACP package includes a compatible Codex binary; `CODEX_PATH` can override it when needed.

Portal uses the agents' existing credentials and default model/reasoning settings. Tool permission requests are automatically approved through ACP; Portal does not override agent sandbox defaults.

## Layout

- `src/lib/agents.ts` — server-side registry: agent names, launch configurations, and login instructions.
- `src/lib/acp-runtime.ts` — shared ACP runtime. One lazy subprocess per agent, isolated sessions, append-only event logs, and automatic permissions.
- `src/lib/acp.ts` — runtime singleton preserved across development hot reloads.
- `src/lib/types.ts` — shared event and session metadata types.
- `src/app/api/agents` — `GET` available agents and the default selection.
- `src/app/api/sessions` — `GET` list, `POST {cwd, agentId}` create. Omitting `agentId` defaults to Claude Code.
- `src/app/api/sessions/[id]/events` — Server-Sent Events: replays the log, then tails it.
- `src/app/api/sessions/[id]/prompt` — `POST {text}`; returns 202, progress arrives via SSE.
- `src/app/api/sessions/[id]/cancel` — `POST`; sends `session/cancel`.
- `src/components/Chat.tsx` — reduces the event stream into user / assistant / thought / tool / plan blocks.

## Adding an agent

Install its ACP adapter and add an entry to `src/lib/agents.ts` with a unique ID, display name, executable, arguments, and login instructions. An optional `env` object extends the host environment. Launch commands stay on the server; the browser receives only IDs and names.

Adapters must speak ACP over stdio and support the current text-chat flow. The shared client advertises no optional filesystem or terminal capabilities. Compatible adapters need no changes to the chat UI or session routes.

## Checks

Using Node.js 24 or newer:

```sh
pnpm test         # fake ACP processes; no credentials or model calls
pnpm lint
pnpm build
```

## Known limits

- Sessions live in server memory; restarting the dev server loses them.
- If an agent process exits, its session history remains visible, but continuing requires a new session. Other agents' sessions keep running.
- Agent selection is fixed per session. Model selection, login screens, and custom-agent configuration UI are not included.
