-- The Ideas list is gone: only Needs-you items are shown. An open or snoozed idea is resolved, and
-- no item keeps a list, in its column or in its body (see itemFromLegacy in src/orchestrator/jobs/legacy.ts).
UPDATE "orchestrator_items"
SET "status" = 'resolved', "snoozed_until" = NULL,
  "body" = jsonb_set(jsonb_set("body", '{status}', '"resolved"'), '{snoozedUntil}', 'null')
WHERE "list" = 'ideas' AND "status" IN ('open', 'snoozed');
--> statement-breakpoint
UPDATE "orchestrator_items" SET "body" = "body" - 'list' WHERE "body" ? 'list';
--> statement-breakpoint
ALTER TABLE "orchestrator_items" DROP COLUMN "list";
