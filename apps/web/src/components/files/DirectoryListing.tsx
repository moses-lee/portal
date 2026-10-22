"use client";

import { CornerLeftUp, FileText, Folder } from "lucide-react";
import type { FileListing } from "@portal/contracts/files";
import { formatBytes, parentPath } from "@/lib/files";

/**
 * A directory's entries (docs/FILES.md, decision 15): directories first, as the server sorts them,
 * then files with their sizes, and a `..` row while there is a parent. Choosing a row opens it in
 * the same pane (`onOpen`, the pane's own navigation).
 */
export default function DirectoryListing({ listing, onOpen }: { listing: FileListing; onOpen: (path: string) => void }) {
  const parent = parentPath(listing.path);
  const childPath = (name: string) => (listing.path === "/" ? `/${name}` : `${listing.path}/${name}`);
  const row = "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none";
  return (
    <ul data-directory-listing aria-label={`Contents of ${listing.path}`} className="flex flex-col py-2">
      {parent !== null && (
        <li>
          <button type="button" onClick={() => onOpen(parent)} className={`${row} text-muted-foreground`}>
            <CornerLeftUp className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-mono">..</span>
          </button>
        </li>
      )}
      {listing.entries.map((entry) => (
        <li key={entry.name}>
          <button type="button" data-entry={entry.name} onClick={() => onOpen(childPath(entry.name))} className={row}>
            {entry.kind === "dir" ? (
              <Folder className="size-4 shrink-0 text-sky-300/70" aria-hidden="true" />
            ) : (
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {entry.name}
              {entry.kind === "dir" && <span className="text-muted-foreground">/</span>}
            </span>
            {entry.kind === "file" && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{formatBytes(entry.size)}</span>}
          </button>
        </li>
      ))}
      {listing.entries.length === 0 && <li className="px-3 py-1.5 text-[13px] text-muted-foreground">Empty folder</li>}
      {listing.truncated && (
        <li className="px-3 py-1.5 text-[11px] text-muted-foreground">Only the first {listing.entries.length.toLocaleString()} entries are shown.</li>
      )}
    </ul>
  );
}
