"use client";

import { FileText } from "lucide-react";
import { cn } from "cn";
import type { Attachment } from "@portal/contracts/files";
import { formatBytes, isImage, rawFileUrl } from "@/lib/attachments";
import { useOpenFile } from "./useOpenFile";

/**
 * The files sent with a prompt (docs/FILES.md): in a user bubble, image thumbnails served from
 * their stored copies (loaded lazily, at a bounded size) and chips for other files; `compact` is
 * the prompt queue's one-line form. Tapping one opens it in a file pane.
 */
export default function AttachmentList({
  attachments,
  compact = false,
  className,
}: {
  attachments: readonly Attachment[];
  compact?: boolean;
  className?: string;
}) {
  const openFile = useOpenFile();
  if (attachments.length === 0) return null;
  if (compact) {
    // A queue row is one line: the first two, then a count.
    const shown = attachments.slice(0, 2);
    const more = attachments.length - shown.length;
    return (
      <span className={cn("flex min-w-0 flex-none items-center gap-1", className)}>
        {shown.map((attachment) => (
          <button
            key={attachment.path}
            type="button"
            title={`Open ${attachment.name}`}
            aria-label={`Open ${attachment.name}`}
            onClick={() => openFile({ path: attachment.path })}
            className="flex h-6 max-w-[110px] items-center gap-1 rounded-md border border-white/10 bg-white/[.04] px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {isImage(attachment.mimeType) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={rawFileUrl(attachment.path)} alt="" loading="lazy" className="size-4 flex-none rounded-sm object-cover" />
            ) : (
              <FileText aria-hidden className="size-3 flex-none" />
            )}
            <span className="truncate">{attachment.name}</span>
          </button>
        ))}
        {more > 0 && (
          <span className="text-[11px] text-muted-foreground" title={attachments.slice(2).map((a) => a.name).join(", ")}>
            +{more}
          </span>
        )}
      </span>
    );
  }
  return (
    <ul aria-label="Attachments" className={cn("flex flex-wrap justify-end gap-2", className)}>
      {attachments.map((attachment) => (
        <li key={attachment.path} className="min-w-0">
          <button
            type="button"
            title={`Open ${attachment.name}`}
            aria-label={`Open ${attachment.name}`}
            onClick={() => openFile({ path: attachment.path })}
            className="block min-w-0 overflow-hidden rounded-2xl border border-bubble-border bg-bubble text-left transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {isImage(attachment.mimeType) ? (
              // Served by the files route; next/image cannot optimise it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={rawFileUrl(attachment.path)}
                alt={attachment.name}
                loading="lazy"
                decoding="async"
                className="block max-h-48 max-w-[min(240px,60vw)] min-h-12 min-w-12 object-contain"
              />
            ) : (
              <span className="flex h-12 max-w-[240px] items-center gap-2.5 px-3.5">
                <FileText aria-hidden className="size-4 flex-none text-muted-foreground" />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-[13px] text-foreground">{attachment.name}</span>
                  <span className="text-[11px] text-muted-foreground">{formatBytes(attachment.size)}</span>
                </span>
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
