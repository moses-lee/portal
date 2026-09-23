@apps/web/AGENTS.md

# Repository layout

pnpm workspace. `apps/web` is the Next.js frontend, `apps/server` is the Fastify backend that owns all state (sessions, terminals, projects, settings, orchestrator, Postgres), `packages/*` hold code shared between them. Run everything from the repo root with `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm build`. Postgres runs in Docker via `pnpm db:up`.
