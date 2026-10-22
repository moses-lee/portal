"use client";

import { useOptionalWorkspace } from "../WorkspaceProvider";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { homeDirectory, parseFileInput, rawUrl, requestLine, resolveLocally, statFile } from "@/lib/files";
import { requestAppNavigation } from "@/lib/surface-navigation";
import { locationPath } from "@/lib/workspace";

/**
 * Opens a file pane for a path an agent or the user referred to (docs/FILES.md). `path` may be
 * absolute, `~/…`, `file://…`, or relative to `cwd` (the session's working directory); `line`
 * scrolls the editor there.
 */
export type OpenFileTarget = { path: string; cwd?: string | null; line?: number | null };

/**
 * Open a file pane (decision 2) and move this device there. The input loses a `:42`/`#L42` suffix
 * (the line, unless `line` is given), then the server's stat makes it absolute (`~`, `file://`,
 * relative to `cwd`, symlinks resolved). A path that does not exist still opens, at the absolute path
 * formed here (`~` from the server's home), and the pane says "Not found". `open_file` focuses a pane
 * already showing the path (decision 16), else adds a tab at the end; the line is handed to the pane
 * in memory (`requestLine`). Navigation goes through the shell, so an overlay over the workspace
 * (Agent, Search) closes on the way. Outside a workspace the raw file opens in a browser tab.
 */
export function useOpenFile(): (target: OpenFileTarget) => void {
  const workspace = useOptionalWorkspace();
  return useStableCallback((target: OpenFileTarget) => {
    const parsed = parseFileInput(target.path);
    const line = target.line ?? parsed.line;
    const cwd = target.cwd ?? null;
    if (!workspace) {
      window.open(rawUrl(resolveLocally(parsed.path, cwd, null) ?? parsed.path), "_blank", "noreferrer");
      return;
    }
    void (async () => {
      const stat = await statFile(parsed.path, cwd);
      const path = stat.kind === "ok" ? stat.stat.path : resolveLocally(parsed.path, cwd, await homeDirectory());
      // Relative with no working directory, or `~` with no home known: nothing absolute to open.
      if (!path) return;
      try {
        const { workspace: next, location } = await workspace.apply({ op: "open_file", path });
        if (line) requestLine(path, line);
        if (location) requestAppNavigation(locationPath(next, location));
      } catch {
        // Reported by the provider.
      }
    })();
  });
}
