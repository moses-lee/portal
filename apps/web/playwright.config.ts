import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const externalServer = process.env.PORTAL_UI_BASE_URL;
const webPort = 3199;
const serverPort = 3198;
const serverOrigin = `http://127.0.0.1:${serverPort}`;
/** Next's own dev-server variables, inherited by shells Portal spawns; `next build` misbehaves with them set. */
const withoutDevEnv = "env -u NODE_ENV -u TURBOPACK -u NEXT_DEPLOYMENT_ID -u __NEXT_DEV_SERVER";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  workers: 3,
  timeout: 30_000,
  use: {
    baseURL: externalServer ?? `http://localhost:${webPort}`,
    viewport: { width: 1440, height: 960 },
    channel: process.env.PLAYWRIGHT_CHROME ? "chrome" : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Started in order, each waited on before the next. Most API calls are mocked by the fixtures;
  // the rest (settings persistence) reach a real server on a database recreated for every run.
  webServer: externalServer
    ? undefined
    : [
        {
          // The database reset is part of this command rather than its own entry: Playwright waits on a
          // URL or port for every entry, and a one-shot script has neither.
          command: `DATABASE_URL="$(node tests/ui-support/e2e-db.mjs)" && export DATABASE_URL && node ../server/src/index.ts`,
          url: `${serverOrigin}/api/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: {
            PORTAL_SERVER_PORT: String(serverPort),
            PORTAL_SERVER_HOST: "127.0.0.1",
            PORTAL_HOME: join(tmpdir(), `portal-ui-tests-${process.pid}`),
          },
        },
        {
          // A production build, as the suite ran before the server split: pages are served precompiled,
          // where `next dev` compiles each route on its first visit inside a test's timeout. The proxy
          // target is baked into the build's rewrites, so PORTAL_SERVER_ORIGIN must be set for the build.
          command: `${withoutDevEnv} pnpm build && ${withoutDevEnv} pnpm start`,
          // Proxied to the server: a 200 here means both processes are up and the rewrite points right.
          url: `http://localhost:${webPort}/api/health`,
          reuseExistingServer: false,
          timeout: 300_000,
          env: {
            PORT: String(webPort),
            PORTAL_SERVER_ORIGIN: serverOrigin,
          },
        },
      ],
});
