"use client";

import { useEffect, useMemo, useState } from "react";
import type { SearchResponse } from "@portal/contracts/search";
import { SERVER_MIN_CHARS } from "@/lib/search";

const DEBOUNCE_MS = 120;
/** A spinner only for a request slower than this, so a fast answer never flashes one. */
const SLOW_MS = 200;

/**
 * What the server finds for `query` (`GET /api/search`): message text hits and sessions tied to a
 * pull request. Debounced, nothing under two characters, the in-flight request aborted when the
 * query changes, answers cached per query for as long as the caller is mounted (one opening of the
 * search dialog). A failed request (the route missing, a 500, no network) counts as no hits for
 * now but is not cached, so the query is asked again next time.
 *
 * While a longer query is on its way, the previous answer's messages that still contain it stay,
 * so the list does not blink empty; its PR hits do not (they named another PR). `pending` is true
 * until this query has an answer, `loading` only once that has taken a while.
 */
export function useSearch(query: string): { data: SearchResponse | null; loading: boolean; pending: boolean } {
  const q = query.trim();
  const enabled = q.length >= SERVER_MIN_CHARS;
  const [cache, setCache] = useState(() => new Map<string, SearchResponse>());
  /** The latest answer, cached or not (a failure is an empty one). */
  const [last, setLast] = useState<SearchResponse | null>(null);
  /** The query whose request has been out longer than `SLOW_MS`. */
  const [slow, setSlow] = useState<string | null>(null);
  if (!enabled && last) setLast(null);
  const cached = enabled ? cache.get(q) : undefined;

  useEffect(() => {
    if (!enabled || cached) return;
    const controller = new AbortController();
    const debounce = setTimeout(async () => {
      let data: SearchResponse;
      let ok = false;
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        const body = response.ok ? ((await response.json()) as Partial<SearchResponse>) : {};
        data = { q, messages: body.messages ?? [], pulls: body.pulls ?? [] };
        ok = response.ok;
      } catch {
        data = { q, messages: [], pulls: [] };
      }
      if (controller.signal.aborted) return;
      if (ok) setCache((previous) => new Map(previous).set(q, data));
      setLast(data);
    }, DEBOUNCE_MS);
    const slowTimer = setTimeout(() => setSlow(q), SLOW_MS);
    return () => {
      controller.abort();
      clearTimeout(debounce);
      clearTimeout(slowTimer);
    };
  }, [q, enabled, cached]);

  const answered = cached ?? (last?.q === q ? last : undefined);
  const data = useMemo<SearchResponse | null>(() => {
    if (!enabled) return null;
    if (answered) return answered;
    if (!last || !q.toLowerCase().startsWith(last.q.toLowerCase())) return null;
    const lower = q.toLowerCase();
    return { q, messages: last.messages.filter((hit) => hit.snippet.toLowerCase().includes(lower)), pulls: [] };
  }, [enabled, answered, last, q]);
  const pending = enabled && !answered;
  return { data, loading: pending && slow === q, pending };
}
