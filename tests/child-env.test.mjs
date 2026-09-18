import assert from "node:assert/strict";
import test from "node:test";
import { childEnv, NEXT_DEV_SERVER_VARS } from "../src/lib/child-env.ts";

test("childEnv drops the dev server's variables and keeps everything else", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    NODE_ENV: "development",
    TURBOPACK: "1",
    NEXT_DEPLOYMENT_ID: "",
    __NEXT_DEV_SERVER: "1",
    NEXT_PUBLIC_THING: "keep",
  };
  const env = childEnv(base);
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/x", NEXT_PUBLIC_THING: "keep" });
  for (const name of NEXT_DEV_SERVER_VARS) assert.equal(name in env, false);
  // The input is left alone.
  assert.equal(base.NODE_ENV, "development");
});

test("childEnv defaults to the current process environment", () => {
  process.env.__PORTAL_CHILD_ENV_TEST = "1";
  try {
    assert.equal(childEnv().__PORTAL_CHILD_ENV_TEST, "1");
    assert.equal("TURBOPACK" in childEnv(), false);
  } finally {
    delete process.env.__PORTAL_CHILD_ENV_TEST;
  }
});
