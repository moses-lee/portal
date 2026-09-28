"use client";

import { useMemo } from "react";
import { diffLines } from "diff";

/** An edit's before/after as a line diff; very large changes show both versions instead. */
export default function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
}) {
  const changes = useMemo(
    () =>
      (oldText?.length ?? 0) + newText.length > 300_000
        ? undefined
        : diffLines(oldText ?? "", newText, {
            timeout: 30,
            maxEditLength: 1500,
          }),
    [oldText, newText],
  );
  return (
    <div className="overflow-hidden rounded-lg border border-white/5">
      <div className="break-all border-b border-white/5 px-3 py-2 font-mono text-xs text-muted-foreground">
        {path}
      </div>
      {changes ? (
        <pre className="max-h-96 overflow-auto py-2 text-[11px] leading-6">
          {changes.map((change, i) => (
            <span
              key={i}
              className={`block min-w-max px-3 ${change.added ? "bg-emerald-400/5 text-emerald-200" : change.removed ? "bg-rose-400/5 text-rose-200" : "text-muted-foreground"}`}
            >
              {change.value
                .replace(/\n$/, "")
                .split("\n")
                .map((line, index) => (
                  <span key={index} className="block">
                    <span
                      className="mr-3 select-none opacity-50"
                      aria-hidden="true"
                    >
                      {change.added ? "+" : change.removed ? "−" : " "}
                    </span>
                    {line || " "}
                  </span>
                ))}
            </span>
          ))}
        </pre>
      ) : (
        <div className="space-y-3 p-3 text-xs">
          <p className="text-muted-foreground">
            Large change — showing full versions.
          </p>
          <p>Before</p>
          <pre className="max-h-64 overflow-auto">{oldText ?? "New file"}</pre>
          <p>After</p>
          <pre className="max-h-64 overflow-auto">{newText}</pre>
        </div>
      )}
    </div>
  );
}
