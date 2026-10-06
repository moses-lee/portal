"use client";

import { useEffect, useState } from "react";
import { Pencil, X } from "lucide-react";
import IconButton from "./IconButton";
import { MAX_QUEUED_PROMPTS, type QueuedPrompt } from "@/lib/types";

/** How long the agent may be free with prompts still queued before the queue reads as waiting. */
const HELD_AFTER_MS = 1500;

/**
 * The prompts waiting for the agent, between the transcript and the composer: first to go out
 * first. Each can be edited in place (its text goes into the composer, and Enter saves it back
 * into the same slot) or removed. While a prompt is being edited the queue is paused: nothing
 * goes out, and the header says so. Otherwise, while the agent is free and prompts still wait,
 * the queue is waiting (a turn failed, the agent was lost, or it is being reattached); the header
 * says so, and any change to the queue tries again. The moment between one turn's end and the
 * next queued prompt's start also looks free, so the note waits.
 */
export default function PromptQueue({
  queue,
  busy,
  editingId,
  onEdit,
  onRemove,
}: {
  queue: QueuedPrompt[];
  busy: boolean;
  /** The prompt this view's composer is editing; another view's edit shows as "editing in another tab". */
  editingId: string | null;
  onEdit: (item: QueuedPrompt) => void;
  onRemove: (item: QueuedPrompt) => void;
}) {
  const paused = queue.some((item) => item.editing);
  // Paused and idle is expected, not a queue that is stuck.
  const idleWithQueue = !busy && queue.length > 0 && !paused;
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
        {paused && (
          <span className="text-amber-200/80"> · paused while a prompt is edited</span>
        )}
        {held && (
          <span className="text-amber-200/80">
            {" "}
            · waiting; send, edit, or remove a prompt to try again
          </span>
        )}
      </p>
      <ol className="prompt-queue-list">
        {queue.map((item, index) => (
          <li
            key={item.id}
            className={item.editing ? "prompt-queue-item prompt-queue-item-editing" : "prompt-queue-item"}
          >
            <span className="prompt-queue-index">{index + 1}</span>
            <span className="prompt-queue-text" title={item.text}>
              {item.text}
            </span>
            {item.editing && (
              <span className="prompt-queue-mark">
                {item.id === editingId ? "editing" : "editing in another tab"}
              </span>
            )}
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
