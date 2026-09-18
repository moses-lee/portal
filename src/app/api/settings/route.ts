import { NextResponse } from "next/server";
import { errorStatus } from "@/lib/fs-paths";
import { getSettingsStore } from "@/lib/settings-storage";
import { checkSameOrigin } from "@/lib/shell-http";

export const dynamic = "force-dynamic";

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: errorStatus(err) ?? 500 });
}

export async function GET(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  try {
    return NextResponse.json({ settings: await getSettingsStore().read() });
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(req: Request) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const body: unknown = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  try {
    return NextResponse.json({ settings: await getSettingsStore().patch(body) });
  } catch (err) {
    return fail(err);
  }
}
