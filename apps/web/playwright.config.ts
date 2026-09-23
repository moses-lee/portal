import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const externalServer = process.env.PORTAL_UI_BASE_URL;
export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: true,
  workers: 3,
  timeout: 30_000,
  use: {
    baseURL: externalServer ?? "http://localhost:3199",
    viewport: { width: 1440, height: 960 },
    channel: process.env.PLAYWRIGHT_CHROME ? "chrome" : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: externalServer
    ? undefined
    : {
        command: "pnpm build && pnpm start",
        url: "http://localhost:3199",
        timeout: 120_000,
        env: {
          PORT: "3199",
          PORTAL_HOME: join(tmpdir(), `portal-ui-tests-${process.pid}`),
        },
      },
});
