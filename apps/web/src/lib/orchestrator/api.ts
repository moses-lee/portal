/**
 * Small JSON helpers for `/api/portal/**`: every failure becomes an `Error` whose message a person
 * can read (the server's `{ error }` when it sent one), so views show it as is.
 */

export const NETWORK_ERROR = "Could not reach the server. Check the connection and try again.";

async function failure(r: Response, fallback: string): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return new Error(j.error ?? fallback);
}

/** GET (or any request) answering JSON; throws a readable error. */
export async function portalJson<T>(path: string, init?: RequestInit, fallback = "Portal could not do that. Try again."): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error(NETWORK_ERROR);
  }
  if (!r.ok) throw await failure(r, fallback);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

/** A write with a JSON body (or none). */
export function portalSend<T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, fallback?: string): Promise<T> {
  return portalJson<T>(
    path,
    body === undefined
      ? { method }
      : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    fallback,
  );
}

/** A query string from the defined, non-empty values. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
