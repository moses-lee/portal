"use client";

import { useEffect, useState } from "react";
import { Pencil, X } from "lucide-react";
import IconButton from "./IconButton";
import { MAX_QUEUED_PROMPTS, type QueuedPrompt } from "@/lib/types";

/** How long the agent may be free with prompts still queued before the queue reads as waiting. */
const HELD_AFTER_MS = 1500;

/**
 * The prompts waiting for the agent, between the transcript and the composer: first to go out
 * first. Each can be taken back into the composer to change it, or removed. While the agent is
 * free and prompts still wait, the queue is waiting (a turn failed, the agent was lost, or it is
 * being reattached); the header says so, and any change to the queue tries again. The moment
 * between one turn's end and the next queued prompt's start also looks free, so the note waits.
 */
export default function PromptQueue({
  queue,
  busy,
  onEdit,
  onRemove,
}: {
  queue: QueuedPrompt[];
  busy: boolean;
  onEdit: (item: QueuedPrompt) => void;
  onRemove: (item: QueuedPrompt) => void;
}) {
  const idleWithQueue = !busy && queue.length > 0;
  const [held, setHeld] = useState(false);
  // Reset as soon as the agent is at work again (adjusting state during render, not in an effect).
  if (held && !idleWithQueue) setHeld(false);
  useEffect(() => {
    if (!idleWithQueue) return;
    const timer = setTimeout(() => setHeld(true), HELD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [idleWithQueue]);
  if (queue.length === 0) return null;
  return (
    <section aria-label="Queued prompts" className="prompt-queue">
      <p className="prompt-queue-heading">
        <span>
          Queued · {queue.length} of {MAX_QUEUED_PROMPTS}
        </span>
        {held && (
          <span className="text-amber-200/80">
            {" "}
            · waiting; send, edit, or remove a prompt to try again
          </span>
        )}
      </p>
      <ol className="prompt-queue-list">
        {queue.map((item, index) => (
          <li key={item.id} className="prompt-queue-item">
            <span className="prompt-queue-index">{index + 1}</span>
            <span className="prompt-queue-text" title={item.text}>
              {item.text}
            </span>
            <IconButton
              label={`Edit queued prompt ${index + 1}`}
              className="size-6"
              onClick={() => onEdit(item)}
            >
              <Pencil className="size-3.5" />
            </IconButton>
            <IconButton
              label={`Remove queued prompt ${index + 1}`}
              className="size-6"
              onClick={() => onRemove(item)}
            >
              <X className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ol>
    </section>
  );
}
