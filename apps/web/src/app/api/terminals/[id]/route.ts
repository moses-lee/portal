import { checkSameOrigin } from "@/lib/shell-http";
import { terminals } from "@/lib/terminals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = checkSameOrigin(req);
  if (rejected) return rejected;
  const { id } = await params;
  if (!terminals.close(id)) return Response.json({ error: "Unknown terminal." }, { status: 404 });
  return new Response(null, { status: 204 });
}
