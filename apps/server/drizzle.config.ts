import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` is used (diffs the schema into SQL under apps/server/drizzle);
// migrations are applied by the server itself at boot, see apps/server/src/db/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://portal:portal@127.0.0.1:5433/portal",
  },
});
