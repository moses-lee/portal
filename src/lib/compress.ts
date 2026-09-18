import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);

/** Bodies below this size are sent as-is: the gzip framing would cost about as much as it saves. */
const MIN_BYTES = 1024;

/**
 * A JSON response, gzipped when the client accepts it. Route handlers use this for bodies that can
 * be large (transcript pages, the GitHub snapshot): the custom server in `server.mjs` serves Next's
 * handler directly, so Next's own compression never runs, and transcript JSON shrinks about 20×.
 */
export async function jsonResponse(req: Request, body: unknown, init: ResponseInit = {}): Promise<Response> {
  const text = JSON.stringify(body);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.append("Vary", "Accept-Encoding");
  if (acceptsGzip(req) && Buffer.byteLength(text) >= MIN_BYTES) {
    const compressed = await gzip(text);
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(compressed.byteLength));
    return new Response(new Uint8Array(compressed), { ...init, headers });
  }
  return new Response(text, { ...init, headers });
}

function acceptsGzip(req: Request): boolean {
  const header = req.headers.get("accept-encoding") ?? "";
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name.trim() !== "gzip" && name.trim() !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}
