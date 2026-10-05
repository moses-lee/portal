@apps/web/AGENTS.md

# Repository layout

pnpm workspace. `apps/web` is the Next.js frontend, `apps/server` is the Fastify backend that owns all state (sessions, terminals, projects, settings, orchestrator, Postgres), `packages/*` hold code shared between them. Run everything from the repo root with `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm build`. Postgres runs in Docker via `pnpm db:up`.

# Vocabulary

- **Watches** (UI and the model's tools: `create_watch`, `list_watches`, ...) are **intents** in code, the DB (`intents`), activity kinds (`intent.*`), and REST (`/api/portal/intents`). The UI called them **Goals** until 2026-10-04.
- **Needs you** items are orchestrator items (`orchestrator_items`), shown on the *Needs your attention* page (`/attention`); `needsAttention` in `@portal/shared/items` decides which count.
- The tracked-sessions panel is not items: it shows tracked sessions' live state, and the session item kinds are retired.
