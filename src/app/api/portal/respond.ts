import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { getOrchestrator } from "@/lib/orchestrator/runtime";
import type { OrchestratorRuntime } from "@/lib/orchestrator/types";
import { checkSameOrigin } from "@/lib/shell-http";

/** `{ error }` with the error's own `status` when it carries one (409 busy / not ready, 404 unknown item). */
export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: errorStatus(err) ?? 500 });
}

/**
 * Same-origin check, then run `handler` against the ready runtime; every `/api/portal` route is
 * this shape. `handler` returns the JSON body (or a Response to pass through, for the chat stream).
 */
export async function withOrchestrator(
  req: Request,
  handler: (runtime: OrchestratorRuntime) => Promise<Response | object>,
): Promise<Response> {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  try {
    const runtime = getOrchestrator();
    await runtime.ready;
    const result = await handler(runtime);
    return result instanceof Response ? result : NextResponse.json(result);
  } catch (err) {
    return fail(err);
  }
}

/** The request's JSON body as an object, or a 400 rejection. */
export async function readObject(req: Request): Promise<Record<string, unknown> | Response> {
  const body: unknown = await req.json().catch(() => undefined);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json({ error: "Expected a JSON object body." }, { status: 400 });
  return body as Record<string, unknown>;
}

/** The `[index]` segment as a non-negative integer, or null. */
export function parseIndex(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}
