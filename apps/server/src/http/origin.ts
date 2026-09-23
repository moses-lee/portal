/**
 * Same-origin guard for state-changing routes. Portal's trust boundary is its private host or
 * tailnet, so this only stops a page on another site from driving the API through a browser that
 * can reach Portal. Requests arrive through the Next.js proxy, which keeps `Origin` and
 * `Sec-Fetch-Site` and names the browser-facing host in `X-Forwarded-Host`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export function crossOriginError(req: FastifyRequest): string | null {
  if (req.headers["sec-fetch-site"] === "cross-site") return "Cross-site requests are not allowed.";
  const origin = req.headers.origin;
  if (!origin) return null;
  const forwarded = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim() || req.headers.host;
  try {
    if (new URL(origin).host !== host) throw new Error();
  } catch {
    return "Cross-origin requests are not allowed.";
  }
  return null;
}

/** Sends a 403 and returns true when the request must not proceed. Use as the first line of a mutating handler. */
export function rejectCrossOrigin(req: FastifyRequest, reply: FastifyReply): boolean {
  const error = crossOriginError(req);
  if (!error) return false;
  void reply.code(403).send({ error });
  return true;
}
