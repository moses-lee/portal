import { shell } from "@/lib/shell";
import { checkShellOrigin } from "@/lib/shell-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = checkShellOrigin(req);
  if (rejected) return rejected;
  return Response.json(shell.getState());
}
