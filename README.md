# portal

Chat UI for coding agents, spoken to over the [Agent Client Protocol](https://agentclientprotocol.com).
MVP: Next.js app that spawns `claude-agent-acp` locally and streams the session to the browser.

## Run

```sh
pnpm install
pnpm dev          # binds 0.0.0.0:3000 so it is reachable over Tailscale
```

Open `http://<tailscale-ip>:3000`. Set a working directory, click **New session**, chat.
Claude uses whatever login `claude` already has on this machine.

## Layout

- `src/lib/acp.ts` — ACP layer. One long-lived `claude-agent-acp` subprocess (JSON-RPC over stdio),
  a session map, an append-only event log per session, auto-approve permission handler.
- `src/app/api/sessions` — `GET` list, `POST {cwd}` create.
- `src/app/api/sessions/[id]/events` — Server-Sent Events: replays the log, then tails it.
- `src/app/api/sessions/[id]/prompt` — `POST {text}`; returns 202, progress arrives via SSE.
- `src/app/api/sessions/[id]/cancel` — `POST`; sends `session/cancel`.
- `src/components/Chat.tsx` — reduces the event stream into user / assistant / thought / tool / plan blocks.

## Known limits (MVP)

- Sessions live in server memory; restarting the dev server loses them.
- All tool permissions are auto-approved.
- Claude Code only. Adding an agent means adding another spawn command in `acp.ts`.
