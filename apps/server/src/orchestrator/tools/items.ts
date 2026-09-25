import { z } from "zod";
import { fullId, knownIds, mapRefs } from "../ids.ts";
import { httpError } from "../ops.ts";
import { itemKinds } from "../store.ts";
import type { Item } from "../types.ts";
import { type ToolContext, capped, define } from "./context.ts";

export { itemKinds };

const id = z.string().min(1);

export const pullRefSchema = z.object({ repo: z.string().min(1), number: z.number().int().positive(), url: z.string().min(1) });

const linksSchema = z.object({
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  pull: pullRefSchema.optional(),
  intentId: z.string().optional(),
  jobId: z.string().optional(),
  threadId: z.string().optional(),
});

const label = z.string().optional();
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_session"), sessionId: z.string().min(1), label }),
  z.object({ type: z.literal("open_url"), url: z.string().min(1), label }),
  z.object({ type: z.literal("start_session"), projectId: z.string().min(1), prompt: z.string().min(1), agentId: z.string().optional(), label }),
  z.object({ type: z.literal("send_prompt"), sessionId: z.string().min(1), prompt: z.string().min(1), label }),
  z.object({ type: z.literal("remove_worktree"), projectId: z.string().min(1), label }),
  z.object({ type: z.literal("ask_portal"), text: z.string().min(1), label }),
]);

/** "<kind>:<key>": a change kind or the per-PR "pr" prefix, then a key without whitespace. */
const FINGERPRINT = /^[a-z_]+:\S+$/;

const kindSchema = z.enum(itemKinds);

function itemRow(item: Item) {
  return { id: item.id, kind: item.kind, title: item.title, status: item.status, fingerprint: item.fingerprint, updatedAt: item.updatedAt };
}

export function itemTools({ store, deps, touched, now }: ToolContext) {
  async function change(id: string, patch: Parameters<typeof store.updateItem>[1]) {
    const item = await store.updateItem(id, patch);
    touched.add(item.id);
    return itemRow(item);
  }
  /** Links and buttons with full ids; an id that names no session or project, or several, is refused. */
  async function strictRefs(refs: Parameters<typeof mapRefs>[0]) {
    const known = await knownIds(deps);
    return mapRefs(refs, (kind, id, where) => fullId(known, kind, id, where));
  }
  return {
    create_item: define(
      "Create a Needs-you item: something that needs the user's decision or action. fingerprint: for a change, get_changes's verbatim; else \"<kind>:<key>\" (e.g. pr:owner/name#7, custom:<slug>); when an open item already carries it, that item is updated instead of duplicated, and while the user has dismissed an item with it nothing is created.",
      z.object({
        kind: kindSchema, title: z.string().min(1).max(200), body: z.string().max(2000),
        links: linksSchema.optional(), actions: z.array(actionSchema).max(4).optional(), fingerprint: z.string().min(3),
      }),
      async ({ kind, title, body, fingerprint, ...refs }) => {
        if (!FINGERPRINT.test(fingerprint)) throw httpError('fingerprint must look like "<kind>:<key>" without spaces; copy it from get_changes.', 400);
        // Stored links and buttons carry full ids, whatever prefix the model passed.
        const { links = {}, actions = [] } = await strictRefs(refs);
        const existing = await store.findItemByFingerprint(fingerprint);
        if (existing) {
          const row = await change(existing.id, { kind, title, body, links, actions });
          return { ...row, updated: true, note: "An item with this fingerprint already existed; it was updated instead of creating a duplicate." };
        }
        // A dismissal holds until the condition clears (the next full world refresh then releases it): the user said not to show this again.
        const dismissed = (await store.listItems()).find((item) => item.fingerprint === fingerprint && item.status === "dismissed");
        if (dismissed) return { suppressed: true, dismissedItemId: dismissed.id, note: "The user dismissed this; nothing was created. Do not mention it again while the condition lasts." };
        const item = await store.createItem({ kind, title, body, links, actions, fingerprint });
        touched.add(item.id);
        return { ...itemRow(item), created: true };
      },
    ),
    update_item: define(
      "Change an item's kind, title, body, links, or actions (the kind follows its condition, e.g. conflicts that became failing checks).",
      z.object({ id, kind: kindSchema.optional(), title: z.string().min(1).max(200).optional(), body: z.string().max(2000).optional(), links: linksSchema.optional(), actions: z.array(actionSchema).max(4).optional() }),
      async ({ id, links, actions, ...patch }) => {
        const refs = links || actions ? await strictRefs({ links, actions }) : {};
        return change(id, Object.fromEntries(Object.entries({ ...patch, ...refs }).filter(([, value]) => value !== undefined)));
      },
    ),
    resolve_item: define("Mark an item resolved: its condition no longer holds.", z.object({ id }), ({ id }) => change(id, { status: "resolved", snoozedUntil: null })),
    snooze_item: define(
      "Hide an item for a number of minutes; it reopens afterwards.",
      z.object({ id, minutes: z.number().int().min(1).max(7 * 24 * 60) }),
      ({ id, minutes }) => change(id, { status: "snoozed", snoozedUntil: now() + minutes * 60_000 }),
    ),
    dismiss_item: define("Dismiss an item the user does not want to see again; it stays dismissed until its condition clears.", z.object({ id }), ({ id }) => change(id, { status: "dismissed", snoozedUntil: null })),
    list_items: define(
      "Items by status (default open), newest first.",
      z.object({ status: z.enum(["open", "snoozed", "resolved", "dismissed"]).optional() }),
      async ({ status = "open" }) => {
        const { rows, truncated } = capped((await store.listItems()).filter((item) => item.status === status), 50);
        return { items: rows.map(itemRow), truncated };
      },
    ),
  };
}
