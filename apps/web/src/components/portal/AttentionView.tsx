"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, EyeOff, LoaderCircle } from "lucide-react";
import PortalItemCard, { isVisibleItem, kindLabels, retiredItemKinds, type ItemCardHandlers } from "../PortalItemCard";
import type { PortalLinks } from "../PortalPage";
import { ConfirmButton, Empty, ErrorLine, SectionTitle, useRowAction, ViewBody, When } from "./bits";
import { usePortalLive, useNow } from "./PortalLive";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { portalSend } from "@/lib/orchestrator/api";
import { groupByKind } from "@/lib/orchestrator/items";
import type { Item } from "@/lib/orchestrator/types";

type BulkStatus = "resolved" | "dismissed";

/** What the server answers to `POST /api/portal/items/bulk`. */
type BulkResult = { items: Item[]; missing?: string[] };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Resolve all" and "Dismiss all" for a set of items, each confirmed by a second click. */
function BulkActions({ items, what, onDone }: { items: Item[]; what: string; onDone: (updated: Item[]) => void }) {
  const { pending, error, run } = useRowAction();
  const act = (status: BulkStatus) =>
    run(status, async () => {
      const result = await portalSend<BulkResult>("/api/portal/items/bulk", "POST", { ids: items.map((item) => item.id), status });
      onDone(result.items);
    });
  if (items.length === 0) return null;
  const count = plural(items.length, "item");
  return (
    <>
      <ConfirmButton
        label={`Resolve ${what}`}
        confirmLabel={`Resolve ${count}`}
        disabled={pending !== null}
        onConfirm={() => void act("resolved")}
        icon={<Check />}
      />
      <ConfirmButton
        label={`Dismiss ${what}`}
        confirmLabel={`Dismiss ${count}`}
        disabled={pending !== null}
        onConfirm={() => void act("dismissed")}
        icon={<EyeOff />}
      />
      {pending && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
      <ErrorLine>{error}</ErrorLine>
    </>
  );
}

/**
 * Needs your attention: every item Portal raised that still waits on the user (open, or snoozed past
 * its time), grouped by kind with the approvals first, each group clearable in one go; then the items
 * snoozed for later, folded away. The list is the live one the stream keeps, so the sidebar badge, this
 * page, and the cards agree. Cards keep their own actions and menu (resolve, snooze, dismiss, reopen).
 */
export default function AttentionView({ handlers }: { links: PortalLinks; handlers: ItemCardHandlers }) {
  const { items, putItem } = usePortalLive();
  const now = useNow(30_000);
  const due = useMemo(() => items.filter((item) => isVisibleItem(item, now)), [items, now]);
  const groups = useMemo(() => groupByKind(due), [due]);
  const snoozed = useMemo(
    () =>
      items
        .filter((item) => item.status === "snoozed" && item.snoozedUntil !== null && item.snoozedUntil > now && !retiredItemKinds.has(item.kind))
        .sort((a, b) => a.snoozedUntil! - b.snoozedUntil!),
    [items, now],
  );
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const applyAll = (updated: Item[]) => updated.forEach(putItem);

  return (
    <ViewBody label="Needs your attention">
      <section aria-labelledby="attention-due">
        <SectionTitle id="attention-due" count={due.length} actions={<BulkActions items={due} what="all" onDone={applyAll} />}>
          Needs you
        </SectionTitle>
        {due.length === 0 ? (
          <Empty>
            Nothing needs you. Portal raises an item here when something waits on your decision: a
            watch that fired, a review’s findings, a PR that needs a hand, or an approval.
          </Empty>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.kind} aria-labelledby={`attention-${group.kind}`} className="space-y-2.5">
                <SectionTitle
                  id={`attention-${group.kind}`}
                  count={group.items.length}
                  actions={<BulkActions items={group.items} what={kindLabels[group.kind].toLowerCase()} onDone={applyAll} />}
                >
                  <span className="text-muted-foreground">{kindLabels[group.kind]}</span>
                </SectionTitle>
                {group.items.map((item) => (
                  <PortalItemCard key={item.id} item={item} {...handlers} />
                ))}
              </section>
            ))}
          </div>
        )}
      </section>

      {snoozed.length > 0 && (
        <section aria-labelledby="attention-snoozed">
          <Collapsible open={snoozedOpen} onOpenChange={setSnoozedOpen}>
            <CollapsibleTrigger asChild>
              <button type="button" className="mb-2.5 flex min-h-7 w-full items-center gap-2 text-left">
                <h2 id="attention-snoozed" className="text-[13px] font-medium tracking-[-.01em]">
                  Snoozed
                  <span className="ml-1.5 font-normal text-muted-foreground">{snoozed.length}</span>
                </h2>
                <ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${snoozedOpen ? "rotate-180" : ""}`} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-2.5">
                {snoozed.map((item) => (
                  <div key={item.id}>
                    <p className="mb-1 pl-1 text-[11px] text-muted-foreground">
                      Back <When at={item.snoozedUntil!} now={now} />
                    </p>
                    <PortalItemCard item={item} {...handlers} />
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </section>
      )}
    </ViewBody>
  );
}
