"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ResponsiveDialog from "../ResponsiveDialog";
import { parseLineSuffix } from "@/lib/file-links";
import { useOpenFile } from "./useOpenFile";

/**
 * "Open file…" from a session's pane menu (docs/FILES.md, "File pane"): a path, absolute or
 * relative to the session's working directory, with an optional `:42` line. Left empty, it opens
 * the working directory's listing.
 */
export default function OpenFileDialog({
  open,
  onOpenChange,
  cwd,
  displayCwd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd: string | null;
  /** The cwd as shown to people (`~/…`), for the hint. */
  displayCwd?: string | null;
}) {
  const openFile = useOpenFile();
  const [value, setValue] = useState("");
  const submit = () => {
    const input = value.trim();
    const target = input ? parseLineSuffix(input) : { path: cwd ?? "~", line: null };
    onOpenChange(false);
    setValue("");
    openFile({ ...target, cwd });
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setValue("");
        onOpenChange(next);
      }}
      title="Open file"
      description={
        cwd
          ? `A path on this computer, absolute or relative to ${displayCwd || cwd}. Leave it empty to browse that folder.`
          : "An absolute path on this computer, or ~/…. Leave it empty to browse your home folder."
      }
    >
      <form
        className="flex gap-2 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          autoFocus
          aria-label="Path"
          placeholder="docs/PLAN.md"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="h-9 font-mono"
        />
        <Button type="submit" className="h-9">
          Open
        </Button>
      </form>
    </ResponsiveDialog>
  );
}
