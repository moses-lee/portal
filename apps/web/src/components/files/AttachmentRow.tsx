"use client";

import { CircleAlert, FileText, X } from "lucide-react";
import { cn } from "cn";
import { formatBytes, type PendingAttachment } from "@/lib/attachments";

/**
 * A composer's attachments, above its text (docs/FILES.md): thumbnails for images, name and size
 * chips for other files, each with ✕ to remove, its upload progress while a send runs, and a mark
 * with the reason when its upload failed. The row scrolls sideways when it outgrows the composer.
 */
export default function AttachmentRow({
  items,
  onRemove,
  disabled = false,
}: {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
  /** A send is in flight: nothing can be removed until it settles. */
  disabled?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex w-full min-w-0 gap-3 overflow-x-auto pt-3 pr-3 pb-1">
      {items.map((item) => (
        <li key={item.id} className="relative flex-none">
          <div
            title={item.error ? `${item.name}: ${item.error}` : item.name}
            className={cn(
              "relative flex h-14 items-center overflow-hidden rounded-xl border border-white/10 bg-white/[.04]",
              item.previewUrl ? "w-14" : "max-w-[200px] gap-2 pr-3 pl-2.5",
              item.status === "failed" && "border-destructive/70",
            )}
          >
            {item.previewUrl ? (
              // A local object URL or the stored copy; next/image cannot optimise either.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.previewUrl} alt={item.name} className="size-full object-cover" />
            ) : (
              <>
                <FileText aria-hidden className="size-4 flex-none text-muted-foreground" />
                <span className="flex min-w-0 flex-col text-left leading-tight">
                  <span className="truncate text-xs text-foreground">{item.name}</span>
                  <span className="text-[10px] text-muted-foreground">{formatBytes(item.size)}</span>
                </span>
              </>
            )}
            {item.status === "uploading" && (
              <span
                role="progressbar"
                aria-label={`Uploading ${item.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(item.progress * 100)}
                className="absolute inset-x-0 bottom-0 h-1 bg-black/40"
              >
                <span
                  className="block h-full bg-primary transition-[width]"
                  style={{ width: `${Math.max(4, item.progress * 100)}%` }}
                />
              </span>
            )}
            {item.status === "failed" && (
              <span className="absolute bottom-1 left-1 grid size-4 place-items-center rounded-full bg-destructive text-white">
                <CircleAlert aria-hidden className="size-3" />
                <span className="sr-only">Upload failed: {item.error}</span>
              </span>
            )}
          </div>
          {/* A 36 px target around a small visible ✕, so it stays tappable on a phone. */}
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            title={`Remove ${item.name}`}
            disabled={disabled}
            onClick={() => onRemove(item.id)}
            className="group/remove absolute -top-3 -right-3 grid size-9 place-items-center rounded-full disabled:opacity-0"
          >
            <span className="grid size-5 place-items-center rounded-full border border-white/15 bg-neutral-900 text-muted-foreground group-hover/remove:text-foreground group-focus-visible/remove:ring-2 group-focus-visible/remove:ring-ring">
              <X className="size-3" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
