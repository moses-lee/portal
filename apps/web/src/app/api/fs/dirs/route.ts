import { NextResponse } from "next/server";
import { errorStatus, listDirectories, resolveDirectory } from "@/lib/fs-paths";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

/** Directory browser backend for the add-project dialog; only subdirectories are exposed. */
export async function GET(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const query = new URL(req.url).searchParams;
  const input = (query.get("path") ?? "").trim() || "~";
  const hidden = query.get("hidden") === "1";
  try {
    return NextResponse.json(await listDirectories(await resolveDirectory(input), { hidden }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
  }
}
