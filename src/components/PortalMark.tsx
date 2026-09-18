import { cn } from "@/lib/utils";

/**
 * Portal's mark: a glowing ring inside a soft tile. Size it with `size-*` on
 * the outer span; the ring scales with it. `ringClassName` restyles the ring's
 * border and glow for other sizes. Defaults to the sidebar's look.
 */
export default function PortalMark({
  className,
  ringClassName,
}: {
  className?: string;
  ringClassName?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-7 items-center justify-center rounded-full border border-white/20 bg-white/5",
        className,
      )}
      aria-hidden="true"
    >
      <span
        className={cn(
          "size-1/2 rounded-full border-2 border-indigo-200/75 shadow-[0_0_12px_#a5b4fc30]",
          ringClassName,
        )}
      />
    </span>
  );
}
