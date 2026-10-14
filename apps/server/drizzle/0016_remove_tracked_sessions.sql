DROP TABLE "tracked_sessions";
--> statement-breakpoint
UPDATE "world_snapshots"
SET "body" = jsonb_set("body", '{world}', ("body" -> 'world') - 'tracked')
WHERE ("body" -> 'world') ? 'tracked';
--> statement-breakpoint
UPDATE "settings"
SET "body" = jsonb_set("body", '{sessions}', ("body" -> 'sessions') - 'tracked')
WHERE "key" = 'overrides' AND ("body" -> 'sessions') ? 'tracked';
