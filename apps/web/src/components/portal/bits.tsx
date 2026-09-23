"use client";

import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { formatDateTime, relativeTime } from "@/lib/orchestrator/format";

export type Tone = "neutral" | "amber" | "sky" | "emerald" | "rose" | "violet";

const toneClass: Record<Tone, string> = {
  neutral: "bg-white/8 text-foreground/70",
  amber: "bg-amber-300/15 text-amber-200",
  sky: "bg-sky-300/12 text-sky-200",
  emerald: "bg-emerald-400/12 text-emerald-300",
  rose: "bg-rose-400/12 text-rose-300",
  violet: "bg-violet-400/12 text-violet-200",
};

/** A small rounded label, the item cards' badge style. */
export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-4 tracking-wide uppercase ${toneClass[tone]} ${className}`}>
      {children}
    </span>
  );
}

/**
 * "in 5 min" with the exact local time on hover. `past` marks something that already happened:
 * a clock that has not ticked since then must not call it "any moment".
 */
export function When({ at, now, prefix, past = false }: { at: number; now: number; prefix?: string; past?: boolean }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {prefix ? `${prefix} ` : ""}
      {relativeTime(past ? Math.min(at, now) : at, now)}
    </time>
  );
}

/** An absolute time ("today 14:05") with the full date on hover. */
export function At({ at, now }: { at: number; now?: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {formatDateTime(at, now)}
    </time>
  );
}

/** A view's section heading with an optional count and trailing controls. */
export function SectionTitle({
  id,
  children,
  count,
  actions,
}: {
  id?: string;
  children: ReactNode;
  count?: number;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex min-h-7 items-center gap-2">
      <h2 id={id} className="text-[13px] font-medium tracking-[-.01em]">
        {children}
        {count !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}
      </h2>
      <div className="ml-auto flex items-center gap-1">{actions}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl border border-dashed border-white/8 px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
      <LoaderCircle className="size-3.5 animate-spin" />
      {children}
    </p>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-xs leading-relaxed text-destructive">
      {children}
    </p>
  );
}

/** Pretty JSON (or a string as is) in a scrollable block, the tool rows' style. */
export function JsonBlock({ value, label, className = "" }: { value: unknown; label?: string; className?: string }) {
  if (value === undefined) return null;
  return (
    <div className={className}>
      {label && (
        <p className="mb-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</p>
      )}
      <pre className="max-h-72 overflow-auto rounded-lg bg-black/20 p-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground/80">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** The scrolling column every non-chat view sits in. */
export function ViewBody({ children, label, wide = false }: { children: ReactNode; label: string; wide?: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label={label}>
      <div className={`mx-auto w-full ${wide ? "max-w-[1100px]" : "max-w-[880px]"} space-y-8 px-5 py-6 pb-16 max-sm:px-3`}>
        {children}
      </div>
    </div>
  );
}
