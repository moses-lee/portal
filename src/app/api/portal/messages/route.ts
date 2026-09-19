import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { OrchestratorMessage } from "@/lib/orchestrator/types";
import { readObject, withOrchestrator } from "../respond";

export const dynamic = "force-dynamic";

/** `GET /api/portal/messages` — the whole thread `{ messages }`. */
export async function GET(req: Request) {
  return withOrchestrator(req, async (runtime) => ({ messages: await runtime.history() }));
}

/**
 * The user message the thread will keep, rebuilt from what the client sent: its id (so the
 * browser's copy and the stored one line up) and the text of its text parts, joined. Everything
 * else (other part kinds, metadata) is the server's to decide, so nothing arbitrary gets stored
 * or shown to the model. Null when there is no text.
 */
function parseUserMessage(value: unknown): OrchestratorMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.role !== "user" || !Array.isArray(message.parts)) return null;
  const text = (message.parts as unknown[])
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const { type, text } = part as Record<string, unknown>;
      return type === "text" && typeof text === "string" && text.trim() ? [text.trim()] : [];
    })
    .join("\n");
  if (!text) return null;
  return {
    id: typeof message.id === "string" && message.id ? message.id : randomUUID(),
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { at: Date.now() },
  };
}

/**
 * `POST /api/portal/messages` — body `{ message }`, the newest user message only (the server owns
 * the history); only its id and text are used. Answers with the AI SDK UI message stream; 409
 * while not ready or busy.
 */
export async function POST(req: Request) {
  return withOrchestrator(req, async (runtime) => {
    const body = await readObject(req);
    if (body instanceof Response) return body;
    const message = parseUserMessage(body.message);
    if (!message) {
      return NextResponse.json(
        { error: "Expected { message } with role \"user\" and a non-empty text part." },
        { status: 400 },
      );
    }
    return runtime.chat(message);
  });
}
