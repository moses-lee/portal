"use client";

/**
 * The Palace page's room (docs/PALACE.md, Palace page): the view's whole area, see-through to the
 * shared canvas behind it. The camera cannot be moved here or anywhere (Revision 2): a drag does
 * nothing and a wheel scrolls nothing. Hover cards and clicks come from the page's room pointer
 * (`pointer.ts`), which shows the pointer cursor over an object; a clicked robot waves first.
 */
export default function PalaceView() {
  return <section aria-label="Palace" data-palace data-room-passthrough className="min-h-0 flex-1 select-none" />;
}
