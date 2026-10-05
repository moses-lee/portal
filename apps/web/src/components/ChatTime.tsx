import { formatDay, formatMessageTime } from "@/lib/orchestrator/format";

/**
 * A chat message's time, always shown (touch screens have no hover): "14:05" under its day's
 * divider (`day`, any time on that day), with the day added when the message fell on another.
 */
export function MessageTime({ at, day, className = "" }: { at: number; day: number; className?: string }) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
      className={`text-[11px] font-normal tabular-nums text-muted-foreground/70 ${className}`}
    >
      {formatMessageTime(at, day)}
    </time>
  );
}

/** The line between a chat's days: "Today", "Yesterday", "Oct 3". */
export function DayDivider({ at, className = "" }: { at: number; className?: string }) {
  const label = formatDay(at);
  return (
    <div role="separator" aria-label={label} className={`flex items-center gap-3 text-[11px] font-medium text-muted-foreground ${className}`}>
      <span aria-hidden className="h-px flex-1 bg-white/8" />
      <time dateTime={new Date(at).toISOString()}>{label}</time>
      <span aria-hidden className="h-px flex-1 bg-white/8" />
    </div>
  );
}
