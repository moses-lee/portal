"use client";

import { useEffect, useRef, useState } from "react";
import type { Workspace, WorkspaceOp } from "@portal/contracts/workspace";
import type { WorkspaceApplied } from "../WorkspaceProvider";
import { navigateTo } from "@/lib/navigation";
import { isResolverPath, type WorkspaceRoute } from "@/lib/session-routes";
import { locationPath, resolveRoute } from "@/lib/workspace";

/** The resolver path's identity, one try per path; null on a tab path (nothing to resolve). */
export function routeKeyOf(route: WorkspaceRoute): string | null {
  return route.kind === "session" ? `session:${route.sessionId}` : route.kind === "start" ? "start" : null;
}

/**
 * The resolvers (decision 7 and 9): once the workspace is known, `/sessions/<id>` focuses the
 * session's pane or opens it in a new tab, `/new` a start page (`resolveRoute`), then the URL is
 * rewritten to the tab path. Opens are tracked per path: a path visited again while its open is in
 * flight is not opened twice, and a different path resolves on its own. An answer only rewrites the
 * URL when the device is still on the path that asked (and the view is still mounted): `/sessions/a`
 * then `/sessions/b` within one round trip lands on b, and leaving for Portal is not undone. A refused
 * open is reported once (`failed`), not retried on every workspace change; a new visit tries again.
 * Nothing resolves while an op of this device is in flight (`pending`): the bare start page creating
 * a session shows the guessed workspace (a tab, no start pane) before the caller moves the URL to it,
 * and resolving that would open a second start page.
 */
export function useRouteResolver({
  route,
  workspace,
  loaded,
  pending,
  apply,
}: {
  route: WorkspaceRoute;
  workspace: Workspace;
  loaded: boolean;
  pending: boolean;
  apply: (op: WorkspaceOp) => Promise<WorkspaceApplied>;
}): { failed: boolean } {
  const routeKey = routeKeyOf(route);
  const inFlight = useRef(new Set<string>());
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // A new path starts clean (derived during render: no extra effect pass).
  if (failedKey !== null && failedKey !== routeKey) setFailedKey(null);
  /** The path the device is on now, for answers that arrive after it moved on. */
  const currentKey = useRef(routeKey);
  const mounted = useRef(false);
  useEffect(() => {
    currentKey.current = routeKey;
  }, [routeKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!loaded || pending || routeKey === null || route.kind === "tab" || inFlight.current.has(routeKey) || failedKey === routeKey) return;
    // The URL is read live: the op that just settled navigated in the same tick, and this render
    // still carries the resolver path the next one will not.
    if (!isResolverPath(window.location.pathname)) return;
    const resolution = resolveRoute(workspace, route);
    if (resolution.kind === "stay") return;
    if (resolution.kind === "focus") {
      navigateTo(locationPath(workspace, resolution.location), { replace: true });
      return;
    }
    const key = routeKey;
    inFlight.current.add(key);
    apply(resolution.op)
      .then(({ workspace: next, location }) => {
        if (!mounted.current || currentKey.current !== key || !location) return;
        navigateTo(locationPath(next, location), { replace: true });
      })
      .catch(() => {
        if (mounted.current) setFailedKey(key);
      })
      .finally(() => {
        inFlight.current.delete(key);
      });
  }, [loaded, pending, route, routeKey, failedKey, workspace, apply]);
  return { failed: failedKey !== null && failedKey === routeKey };
}
