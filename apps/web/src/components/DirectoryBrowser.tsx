"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DirListing } from "@/lib/types";

export type DirectoryBrowserProps = {
  /**
   * The folder currently chosen (absolute), or "" for none; it seeds the first listing (home when
   * empty). The browser navigates on its own and reports every listed folder through `onChange`,
   * so treat `value` as what the browser last reported rather than steering it from outside.
   */
  value: string;
  /** Called with the absolute path of the folder now listed (the folder "Use this folder" would pick). */
  onChange: (path: string) => void;
};

/** Last answer: `listing` is the most recent successful one (kept across errors), `error` belongs to `key`. */
type Result = { key: string; listing: DirListing | null; error: string | null };

const inputClass = "min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-xs outline-none focus:border-indigo-500 disabled:opacity-50";

function listingKey(path: string, hidden: boolean, reload: number) {
  return `${hidden ? 1 : 0}:${reload}\n${path}`;
}

/** Breadcrumb segments for an absolute path: `/` then every parent up to and including the path. */
function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    out.push({ label: part, path: current });
  }
  return out;
}

/** Browse host folders via `GET /api/fs/dirs`; the listed folder is the selection. */
export default function DirectoryBrowser({ value, onChange }: DirectoryBrowserProps) {
  const [request, setRequest] = useState(value);
  const [hidden, setHidden] = useState(false);
  /** Text in the path field while the user edits it; null shows the listed folder. */
  const [typed, setTyped] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const hiddenId = useId();
  const statusId = useId();

  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
  });

  const key = listingKey(request, hidden, reload);
  const loading = result?.key !== key;

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      let listing: DirListing;
      try {
        const params = new URLSearchParams();
        if (request) params.set("path", request);
        params.set("hidden", hidden ? "1" : "0");
        const r = await fetch(`/api/fs/dirs?${params}`, { signal: controller.signal });
        const j = (await r.json()) as DirListing & { error?: string };
        if (!r.ok) throw new Error(j.error ?? `Could not list ${request || "the home folder"}.`);
        listing = j;
      } catch (e) {
        if (controller.signal.aborted) return;
        const message = e instanceof Error && e.message !== "Failed to fetch"
          ? e.message
          : "Could not reach the server. Check the connection and try again.";
        // Keep the last good listing on screen so the user can navigate away from a bad typed path.
        setResult((prev) => ({ key, listing: prev?.listing ?? null, error: message }));
        return;
      }
      if (controller.signal.aborted) return;
      setResult({ key, listing, error: null });
      setTyped(null);
      if (listing.path !== valueRef.current) onChangeRef.current(listing.path);
    };
    void load();
    return () => controller.abort();
  }, [request, hidden, key]);

  const listing = result?.listing ?? null;
  const parent = listing?.parent ?? null;
  const error = result && result.key === key ? result.error : null;

  const navigate = (path: string) => {
    setTyped(null);
    setRequest(path);
  };

  const submitTyped = () => {
    const path = (typed ?? listing?.path ?? "").trim();
    if (!path) return;
    if (path === request) setReload((n) => n + 1); // same path again: reload it
    else setRequest(path);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 text-xs">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitTyped();
        }}
        className="flex items-center gap-2"
      >
        <input
          aria-label="Folder path"
          aria-describedby={statusId}
          value={typed ?? listing?.path ?? ""}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="~/repos/project"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={inputClass}
        />
        <button type="submit" className="shrink-0 rounded border border-zinc-700 px-2 py-1.5 hover:bg-zinc-800">Go</button>
      </form>

      <nav aria-label="Folder breadcrumb" className="flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-1 font-mono text-[11px] text-zinc-400">
        {listing && crumbs(listing.path).map((crumb, i, all) => {
          const current = i === all.length - 1;
          return (
            <span key={crumb.path} className="flex items-center">
              {i > 1 && <span aria-hidden="true" className="text-zinc-600">/</span>}
              <button
                type="button"
                onClick={() => navigate(crumb.path)}
                aria-current={current ? "location" : undefined}
                disabled={current}
                className={`max-w-40 truncate rounded px-1 py-0.5 ${current ? "text-zinc-200" : "hover:bg-zinc-800 hover:text-zinc-200"}`}
              >
                {crumb.label}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="flex items-center gap-3">
        <label htmlFor={hiddenId} className="inline-flex items-center gap-1 text-zinc-400">
          <input id={hiddenId} type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="accent-indigo-500" />
          Show hidden folders
        </label>
        <span id={statusId} role="status" className="ml-auto truncate text-zinc-500">
          {loading ? "Loading…" : listing ? `${listing.entries.length} ${listing.entries.length === 1 ? "folder" : "folders"}` : ""}
        </span>
      </div>

      {error && <p role="alert" className="rounded bg-red-950/50 px-2 py-1.5 text-red-300">{error}</p>}

      <ul aria-label="Subfolders" aria-busy={loading} className="max-h-64 min-h-24 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/60 p-1">
        {parent && (
          <li>
            <button
              type="button"
              onClick={() => navigate(parent)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <span aria-hidden="true">↑</span>
              <span>Parent folder</span>
            </button>
          </li>
        )}
        {listing?.entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => navigate(entry.path)}
              title={entry.path}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800"
            >
              <span aria-hidden="true" className="text-zinc-600">▸</span>
              <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">{entry.name}</span>
              {entry.isGitRepo && (
                <span title="Git repository" className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                  <span aria-hidden="true">⎇ </span>git
                </span>
              )}
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && (
          <li className="px-2 py-1 text-zinc-500">No subfolders{hidden ? "" : " (hidden folders are not shown)"}.</li>
        )}
      </ul>
    </div>
  );
}
