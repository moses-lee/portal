CREATE INDEX "orchestrator_items_status_idx" ON "orchestrator_items" USING btree ("status","created_at");--> statement-breakpoint
-- Items the retired hourly tick raised (sessions and pull requests) before the quiet refresh of
-- 2026-09-25 replaced it: nothing resolves them any more, so they stay "open" for ever. Close them.
UPDATE "orchestrator_items"
SET "status" = 'resolved',
    "updated_at" = (extract(epoch from now()) * 1000)::bigint,
    "body" = jsonb_set(jsonb_set("body", '{status}', '"resolved"'), '{updatedAt}', to_jsonb((extract(epoch from now()) * 1000)::bigint))
WHERE "status" IN ('open', 'snoozed')
  AND "body"->>'kind' IN ('session_finished', 'session_offline', 'session_stopped', 'session_waiting', 'session_hung',
                          'pr_merged', 'pr_closed', 'pr_conflicts', 'pr_checks_failing', 'pr_changes_requested', 'pr_review_requested',
                          'folder_missing')
  AND "created_at" < (extract(epoch from timestamptz '2026-09-26 00:00:00+00') * 1000)::bigint
  AND NOT ("body"->'links' ? 'intentId');
