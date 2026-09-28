"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CommitPage, CommitRow, GithubSummary, SessionSummary } from "@/lib/types";

export type UseGithubSummary = {
  /** The latest snapshot, with any "Show more" pages appended to `commits`; null until the first one lands. */
  summary: GithubSummary | null;
  /** Message from the last failed request; cleared by the next successful refresh. */
  error: string | null;
  /** True while nothing has been loaded for the project yet. */
  loading: boolean;
  /** A summary request is in flight. */
  refreshing: boolean;
  /** Reload now, running `git fetch` first. Never rejects. */
  refresh: () => Promise<void>;
  /** `git pull --ff-only`; the result replaces the summary, or git's refusal lands in `pullError`. Never rejects. */
  pull: () => Promise<void>;
  pulling: boolean;
  /** git's message when the last pull was refused; cleared by the next pull, a manual refresh, or when `behind` changes. */
  pullError: string | null;
  /** Fetch the next page of older commits (`summary.cursor`). Never rejects. */
  loadMore: () => Promise<void>;
  loadingMore: boolean;
};

const NETWORK_ERROR = "Could not reach the server.";
const POLL_MS = 15_000;
/** Every Nth poll also runs `git fetch`: 4 × 15 s = 60 s. */
const FETCH_EVERY = 4;
/** A burst of triggers (branch switch, turn end) becomes one request. */
const TRIGGER_DEBOUNCE_MS = 400;

/** Everything the hook holds for one project, so a project change resets it wholesale. */
type ProjectState = {
  projectId: string | null;
  summary: GithubSummary | null;
  error: string | null;
  pullError: string | null;
  /** Older commits from `loadMore`, valid while the summary still ends at `extraFor`. */
  extra: CommitRow[];
  /** Cursor after the last extra page; null once the root was reached. */
  extraCursor: string | null;
  /** The summary cursor and branch the extra pages continue from. */
  extraFor: { cursor: string | null; branch: string | null } | null;
};

const EMPTY: ProjectState = { projectId: null, summary: null, error: null, pullError: null, extra: [], extraCursor: null, extraFor: null };

/**
 * The last state of every project this tab looked at, shared by every instance of the hook and
 * kept across unmounts: a return to a project (another session on the same repo, the panel closed
 * and opened again, a visit to the terminal) shows what it showed last and refreshes behind it.
 */
const cache = new Map<string, ProjectState>();
const MAX_CACHED_PROJECTS = 20;
function remember(state: ProjectState) {
  if (!state.projectId) return;
  cache.delete(state.projectId);
  cache.set(state.projectId, state);
  while (cache.size > MAX_CACHED_PROJECTS) cache.delete(cache.keys().next().value as string);
}
/** The instance's state when it is this project's; else what the tab last held for it. */
function stateFor(prev: ProjectState, projectId: string): ProjectState {
  return prev.projectId === projectId ? prev : (cache.get(projectId) ?? EMPTY);
}

async function readError(r: Response) {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error || `Request failed (${r.status})`;
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the tab is visible; hidden tabs stop polling. */
function useDocumentVisible() {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== "hidden", () => true);
}

/**
 * The GitHub panel's data for one project: `GET /api/projects/<id>/github`, polled every 15 s while
 * `enabled` and the tab is visible, plus a refresh whenever the active session switches branch or
 * finishes a turn. Only every fourth poll (60 s) and the manual refresh run `git fetch`: a fetch
 * takes seconds and would otherwise compete with the transcript download on every session switch.
 */
export function useGithubSummary({ projectId, enabled, session }: {
  projectId: string | null;
  /** The inspector is visible; polling pauses otherwise. */
  enabled: boolean;
  /** The active session, whose branch changes and turn ends trigger a refresh when it belongs to the project. */
  session: SessionSummary | undefined;
}): UseGithubSummary {
  const [state, setState] = useState<ProjectState>(() => (projectId ? (cache.get(projectId) ?? EMPTY) : EMPTY));
  /** Every change goes through here so the tab-wide cache mirrors the instance. */
  const commit = useCallback((update: (prev: ProjectState) => ProjectState) => {
    setState((prev) => {
      const next = update(prev);
      remember(next);
      return next;
    });
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const visible = useDocumentVisible();
  /** Counter of summary requests; only the newest one's response is applied. */
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  /** A cached snapshot shows at once; this instance still refreshes it on its first look. */
  const loadedForRef = useRef<string | null>(null);

  const current = projectId ? stateFor(state, projectId) : EMPTY;

  /** `fetchRemote` runs `git fetch` first; `fresh` (the manual refresh) also asks gh again about the PR. */
  const load = useCallback(async (fetchRemote: boolean, { fresh = false } = {}) => {
    if (!projectId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++requestRef.current;
    setRefreshing(true);
    try {
      const params = [fetchRemote ? "fetch=1" : "", fresh ? "fresh=1" : ""].filter(Boolean).join("&");
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github${params ? `?${params}` : ""}`, { signal: controller.signal });
      if (id !== requestRef.current) return;
      if (!r.ok) throw new Error(await readError(r));
      const { summary } = (await r.json()) as { summary: GithubSummary };
      if (id !== requestRef.current) return;
      loadedForRef.current = projectId;
      commit((prev) => {
        const base = stateFor(prev, projectId);
        // A refused pull stays visible until the remote moves on; polls alone do not clear it.
        const behindChanged = !base.summary || base.summary.behind !== summary.behind;
        return {
          projectId,
          summary,
          error: null,
          pullError: behindChanged ? null : base.pullError,
          extra: base.extra,
          extraCursor: base.extraCursor,
          extraFor: base.extraFor,
        };
      });
    } catch (e) {
      if (controller.signal.aborted || id !== requestRef.current) return;
      loadedForRef.current = projectId;
      const message = e instanceof Error && e.message ? e.message : NETWORK_ERROR;
      commit((prev) => ({ ...stateFor(prev, projectId), projectId, error: message }));
    } finally {
      if (id === requestRef.current) setRefreshing(false);
    }
  }, [projectId, commit]);

  const active = enabled && visible && !!projectId;

  // First look at a project (a cached snapshot is refreshed behind itself), then polling while the
  // inspector and document are visible.
  useEffect(() => {
    if (!projectId) return;
    if (loadedForRef.current !== projectId || active) void load(false);
    if (!active) return;
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      void load(tick % FETCH_EVERY === 0);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, active, load]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // Session triggers: a branch switch or the end of a turn, debounced.
  const sessionId = session?.id;
  const sessionProjectId = session?.projectId;
  const branch = session?.git?.branch;
  const busy = session?.busy;
  const seenRef = useRef<{ sessionId: string | undefined; branch: string | undefined; busy: boolean | undefined }>({ sessionId: undefined, branch: undefined, busy: undefined });
  const triggerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = { sessionId, branch, busy };
    if (seen.sessionId !== sessionId) return;
    const branchChanged = seen.branch !== branch;
    const turnEnded = seen.busy === true && busy === false;
    if (!branchChanged && !turnEnded) return;
    if (!projectId || sessionProjectId !== projectId) return;
    if (triggerRef.current) clearTimeout(triggerRef.current);
    triggerRef.current = setTimeout(() => {
      triggerRef.current = null;
      void loadRef.current(false);
    }, TRIGGER_DEBOUNCE_MS);
  }, [sessionId, sessionProjectId, branch, busy, projectId]);
  // A pending trigger for the previous project must not supersede the new project's first load.
  useEffect(() => () => {
    if (triggerRef.current) clearTimeout(triggerRef.current);
    triggerRef.current = null;
  }, [projectId]);

  const refresh = useCallback(() => {
    if (projectId) commit((prev) => { const base = stateFor(prev, projectId); return base.pullError ? { ...base, pullError: null } : prev; });
    return load(true, { fresh: true });
  }, [projectId, load, commit]);

  const pull = useCallback(async () => {
    if (!projectId) return;
    setPulling(true);
    commit((prev) => { const base = stateFor(prev, projectId); return base.pullError ? { ...base, pullError: null } : prev; });
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github/pull`, { method: "POST" });
      if (!r.ok) throw new Error(await readError(r));
      const { summary } = (await r.json()) as { summary: GithubSummary };
      // Supersede any poll in flight so it cannot overwrite the post-pull snapshot with an older one.
      requestRef.current += 1;
      controllerRef.current?.abort();
      setRefreshing(false);
      commit((prev) => ({ ...stateFor(prev, projectId), projectId, summary, error: null, pullError: null }));
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : NETWORK_ERROR;
      commit((prev) => ({ ...stateFor(prev, projectId), projectId, pullError: message }));
    } finally {
      setPulling(false);
    }
  }, [projectId, commit]);

  const extraValid = !!current.summary && !!current.extraFor
    && current.extraFor.cursor === current.summary.cursor && current.extraFor.branch === current.summary.branch;
  const cursor = current.summary ? (extraValid ? current.extraCursor : current.summary.cursor) : null;

  const tailCursor = current.summary?.cursor ?? null;
  const tailBranch = current.summary?.branch ?? null;
  const loadMore = useCallback(async () => {
    if (!projectId || !cursor || loadingMore) return;
    // The page continues this tail; if a poll replaces the summary meanwhile, the page is dropped.
    const tail = { cursor: tailCursor, branch: tailBranch };
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github/log?before=${encodeURIComponent(cursor)}`);
      if (!r.ok) throw new Error(await readError(r));
      const page = (await r.json()) as CommitPage;
      commit((prev) => {
        const base = stateFor(prev, projectId);
        if (!base.summary) return prev;
        if (base.summary.cursor !== tail.cursor || base.summary.branch !== tail.branch) return prev;
        const continuing = !!base.extraFor && base.extraFor.cursor === tail.cursor && base.extraFor.branch === tail.branch;
        return {
          ...base,
          extra: continuing ? [...base.extra, ...page.commits] : page.commits,
          extraCursor: page.cursor,
          extraFor: tail,
        };
      });
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : NETWORK_ERROR;
      commit((prev) => ({ ...stateFor(prev, projectId), projectId, error: message }));
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, cursor, loadingMore, tailCursor, tailBranch, commit]);

  const summary = useMemo<GithubSummary | null>(() => {
    if (!current.summary) return null;
    if (!extraValid) return current.summary;
    return { ...current.summary, commits: [...current.summary.commits, ...current.extra], cursor: current.extraCursor };
  }, [current.summary, current.extra, current.extraCursor, extraValid]);

  return {
    summary,
    error: current.error,
    loading: !!projectId && !current.summary && !current.error,
    refreshing,
    refresh,
    pull,
    pulling,
    pullError: current.pullError,
    loadMore,
    loadingMore,
  };
}
