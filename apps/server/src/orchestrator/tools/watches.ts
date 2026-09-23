import { z } from "zod";
import type { Watch } from "../types.ts";
import { type ToolContext, capped, define } from "./context.ts";
import { pullRefSchema } from "./items.ts";

const id = z.string().min(1);

const linksSchema = z.object({
  sessionIds: z.array(z.string()).optional(),
  projectIds: z.array(z.string()).optional(),
  pulls: z.array(pullRefSchema).optional(),
});

/** Characters of notes a list row carries; get the watch itself for the rest. */
const NOTES_PREVIEW = 200;

function watchRow(watch: Watch) {
  return { id: watch.id, intent: watch.intent, status: watch.status, notes: watch.notes, links: watch.links, lastCheckedAt: watch.lastCheckedAt, updatedAt: watch.updatedAt };
}

function listRow(watch: Watch) {
  const row = watchRow(watch);
  return watch.notes.length > NOTES_PREVIEW ? { ...row, notes: `${watch.notes.slice(0, NOTES_PREVIEW)}…`, notesTruncated: true } : row;
}

export function watchTools({ store }: ToolContext) {
  return {
    create_watch: define(
      "Track an intent the user gave (\"review PRs 1, 2, 3\") so later ticks follow it up. notes hold your plan; links name the sessions, projects, and PRs involved.",
      z.object({ intent: z.string().min(1).max(500), notes: z.string().max(4000).optional(), links: linksSchema.optional() }),
      async ({ intent, notes = "", links }) => watchRow(await store.createWatch({
        intent, notes,
        links: { sessionIds: links?.sessionIds ?? [], projectIds: links?.projectIds ?? [], pulls: links?.pulls ?? [] },
      })),
    ),
    update_watch: define(
      "Rewrite a watch's notes (your current understanding), intent, or links.",
      z.object({ id, notes: z.string().max(4000).optional(), intent: z.string().min(1).max(500).optional(), links: linksSchema.optional() }),
      async ({ id, notes, intent, links }) => {
        const current = await store.getWatch(id);
        const merged = links && current ? { ...current.links, ...Object.fromEntries(Object.entries(links).filter(([, value]) => value !== undefined)) } : undefined;
        return watchRow(await store.updateWatch(id, {
          ...(notes !== undefined ? { notes } : {}), ...(intent !== undefined ? { intent } : {}), ...(merged ? { links: merged } : {}),
        }));
      },
    ),
    list_watches: define(
      "Watches by status (default active), newest first.",
      z.object({ status: z.enum(["active", "done", "cancelled"]).optional() }),
      async ({ status = "active" }) => {
        const { rows, truncated } = capped((await store.listWatches()).filter((watch) => watch.status === status));
        return { watches: rows.map(listRow), truncated };
      },
    ),
    close_watch: define(
      "Finish a watch: done when the intent was fulfilled, cancelled when it no longer applies.",
      z.object({ id, status: z.enum(["done", "cancelled"]).optional(), notes: z.string().max(4000).optional() }),
      async ({ id, status = "done", notes }) => watchRow(await store.updateWatch(id, { status, ...(notes !== undefined ? { notes } : {}) })),
    ),
  };
}
