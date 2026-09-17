import { NextResponse } from "next/server";
import { getSession, readEvents, ready } from "@/lib/acp";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 2000;

/** A plain non-negative decimal integer, or null. */
function parseCount(value: string | null): number | null {
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/**
 * One page of the session's log, oldest first, ending before `?before=<seq>` (default: the newest
 * events) and starting at a turn boundary. Follow the live tail with `/stream?since=<last seq>`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ready;
  if (!getSession(id)) return NextResponse.json({ error: "Unknown session." }, { status: 404 });
  const query = new URL(req.url).searchParams;
  const before = query.get("before") === null ? undefined : parseCount(query.get("before"));
  const limit = query.get("limit") === null ? DEFAULT_LIMIT : parseCount(query.get("limit"));
  if (before === null || limit === null || limit < 1) {
    return NextResponse.json({ error: "Invalid page cursor." }, { status: 400 });
  }
  return NextResponse.json(await readEvents(id, { before, limit: Math.min(limit, MAX_LIMIT) }));
}
