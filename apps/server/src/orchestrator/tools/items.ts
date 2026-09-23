import { z } from "zod";
import { httpError } from "../ops.ts";
import type { Item, ItemKind } from "../types.ts";
import { type ToolContext, capped, define } from "./context.ts";

const id = z.string().min(1);

export const itemKinds = [
  "session_finished", "session_waiting", "session_offline", "pr_checks_failing", "pr_changes_requested", "pr_conflicts",
  "pr_review_requested", "pr_merged", "pr_closed", "worktree_merged", "worktree_dirty", "folder_missing", "watch_update", "intent_update",
  "approval_needed", "custom",
] as const satisfies readonly ItemKind[];

export const pullRefSchema = z.object({ repo: z.string().min(1), number: z.number().int().positive(), url: z.string().min(1) });

const linksSchema = z.object({
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  pull: pullRefSchema.optional(),
  watchId: z.string().optional(),
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

/** "<kind>:<key>": a digest kind or the per-PR "pr" prefix, then a key without whitespace. */
const FINGERPRINT = /^[a-z_]+:\S+$/;

const listSchema = z.enum(["needs_you", "ideas"]);
const kindSchema = z.enum(itemKinds);

function itemRow(item: Item) {
  return { id: item.id, list: item.list, kind: item.kind, title: item.title, status: item.status, fingerprint: item.fingerprint, updatedAt: item.updatedAt };
}

export function itemTools({ store, touched, now }: ToolContext) {
  async function change(id: string, patch: Parameters<typeof store.updateItem>[1]) {
    const item = await store.updateItem(id, patch);
    touched.add(item.id);
    return itemRow(item);
  }
  return {
    create_item: define(
      "Create an action item for the user. fingerprint is the digest's, verbatim (\"<kind>:<key>\", e.g. pr:owner/name#7); when an open item already carries it, that item is updated instead of duplicated.",
      z.object({
        list: listSchema, kind: kindSchema, title: z.string().min(1).max(200), body: z.string().max(2000),
        links: linksSchema.optional(), actions: z.array(actionSchema).max(4).optional(), fingerprint: z.string().min(3),
      }),
      async ({ list, kind, title, body, links = {}, actions = [], fingerprint }) => {
        if (!FINGERPRINT.test(fingerprint)) throw httpError('fingerprint must look like "<kind>:<key>" without spaces; copy it from the digest.', 400);
        const existing = await store.findItemByFingerprint(fingerprint);
        if (existing) {
          const row = await change(existing.id, { list, title, body, links, actions });
          return { ...row, updated: true, note: "An item with this fingerprint already existed; it was updated instead of creating a duplicate." };
        }
        const item = await store.createItem({ list, kind, title, body, links, actions, fingerprint });
        touched.add(item.id);
        return { ...itemRow(item), created: true };
      },
    ),
    update_item: define(
      "Change an item's title, body, list, links, or actions.",
      z.object({ id, title: z.string().min(1).max(200).optional(), body: z.string().max(2000).optional(), list: listSchema.optional(), links: linksSchema.optional(), actions: z.array(actionSchema).max(4).optional() }),
      async ({ id, ...patch }) => change(id, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))),
    ),
    resolve_item: define("Mark an item resolved: its condition no longer holds.", z.object({ id }), ({ id }) => change(id, { status: "resolved", snoozedUntil: null })),
    snooze_item: define(
      "Hide an item for a number of minutes; it reopens afterwards.",
      z.object({ id, minutes: z.number().int().min(1).max(7 * 24 * 60) }),
      ({ id, minutes }) => change(id, { status: "snoozed", snoozedUntil: now() + minutes * 60_000 }),
    ),
    dismiss_item: define("Dismiss an item the user does not want to see again.", z.object({ id }), ({ id }) => change(id, { status: "dismissed", snoozedUntil: null })),
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
