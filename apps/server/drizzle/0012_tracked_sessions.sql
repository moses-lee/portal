CREATE TABLE "tracked_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"tracked_at" bigint NOT NULL,
	"tracked_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracked_sessions" ADD CONSTRAINT "tracked_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The session item kinds are retired: tracked sessions show those states live. Close the ones still
-- showing, once, so the strip stops listing stale cards.
UPDATE "orchestrator_items"
SET "status" = 'resolved',
    "updated_at" = (extract(epoch from now()) * 1000)::bigint,
    "snoozed_until" = NULL,
    "body" = jsonb_set(jsonb_set(jsonb_set("body", '{status}', '"resolved"'), '{updatedAt}', to_jsonb((extract(epoch from now()) * 1000)::bigint)), '{snoozedUntil}', 'null')
WHERE "status" IN ('open', 'snoozed')
  AND "body"->>'kind' IN ('session_finished', 'session_stopped', 'session_waiting', 'session_hung', 'session_offline');
