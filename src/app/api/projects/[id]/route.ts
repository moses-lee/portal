import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { projects } from "@/lib/projects";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function fail(err: unknown) {
  return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: errorStatus(err) ?? 500 });
}

export async function PATCH(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const name = body && typeof body === "object" ? (body as Record<string, unknown>).name : undefined;
  if (typeof name !== "string") {
    return NextResponse.json({ error: "Expected {name}." }, { status: 400 });
  }
  try {
    return NextResponse.json(await projects.rename(id, name));
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request, { params }: Context) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  await projects.ready;
  const { id } = await params;
  try {
    // Sessions created from this project keep running; they simply lose their group.
    await projects.remove(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return fail(err);
  }
}
