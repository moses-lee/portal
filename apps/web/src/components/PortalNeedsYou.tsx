"use client";

import { useState } from "react";
import { BellRing, ChevronDown } from "lucide-react";
import PortalItemCard, { kindLabels, retiredItemKinds, type ItemCardHandlers } from "./PortalItemCard";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Item } from "@/lib/orchestrator/types";

/** One row of the strip: the title, opening to the full card. */
function Row({ item, handlers }: { item: Item; handlers: ItemCardHandlers }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/5"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-amber-300" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {kindLabels[item.kind]}
          </span>
          <ChevronDown
            className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pt-1 pb-2">
          <PortalItemCard item={item} {...handlers} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Past this many items the strip starts collapsed to its one-line header, so it does not bury the thread. */
export const NEEDS_YOU_COLLAPSE_AFTER = 5;

/**
 * The "Needs you (n)" strip pinned above the thread: every open needs_you item, one line each; a
 * single line when there are none. Open by default up to `NEEDS_YOU_COLLAPSE_AFTER` items, collapsed
 * past that until the user opens it; once toggled, the user's choice holds. A long open list scrolls
 * inside the strip.
 */
export default function PortalNeedsYou({
  items: all,
  handlers,
}: {
  items: Item[];
  handlers: ItemCardHandlers;
}) {
  /** Null until the user toggles: the default follows the count. */
  const [chosen, setOpen] = useState<boolean | null>(null);
  // Belt and braces: callers pass `isVisibleItem` rows, which already leave the retired kinds out.
  const items = all.filter((item) => !retiredItemKinds.has(item.kind));
  const count = items.length;
  const open = chosen ?? count <= NEEDS_YOU_COLLAPSE_AFTER;
  return (
    <section
      aria-label={`Needs you (${count})`}
      className="rounded-2xl border border-white/8 bg-white/[.02] px-2 py-1.5"
    >
      <Collapsible open={open && count > 0} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            disabled={count === 0}            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium disabled:cursor-default"
          >
            <BellRing
              className={`size-3.5 shrink-0 ${count ? "text-amber-300" : "text-muted-foreground"}`}
            />
            <span className="flex-1">
              Needs you ({count})
              {count === 0 && (
                <span className="ml-2 font-normal text-muted-foreground">
                  Nothing needs you right now.
                </span>
              )}
            </span>
            {count > 0 && (
              <ChevronDown
                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 max-h-[40dvh] space-y-0.5 overflow-y-auto border-t border-white/5 pt-1.5">
            {items.map((item) => (
              <Row key={item.id} item={item} handlers={handlers} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
