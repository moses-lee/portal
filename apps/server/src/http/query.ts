/** Query-string reading shared by the routes. */
import type { FastifyRequest } from "fastify";

/** The first value of a query parameter, as `URLSearchParams#get` gave the web routes. */
export function query(req: FastifyRequest, name: string): string | null {
  const value = (req.query as Record<string, string | string[] | undefined>)[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
