ALTER TABLE "intents" ADD COLUMN "source" jsonb DEFAULT '{"type":"poll"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "events" jsonb DEFAULT '{"pending":[],"handled":[],"seen":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "renewals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "intents" SET "source" = '{"type":"review"}'::jsonb
WHERE "id" IN (SELECT "intent_id" FROM "jobs" WHERE "kind" = 'intent_check' AND "intent_id" IS NOT NULL AND "payload" ? 'review');
--> statement-breakpoint
UPDATE "intents" SET "source" = '{"type":"pull"}'::jsonb
WHERE "id" IN (SELECT "intent_id" FROM "jobs" WHERE "kind" = 'intent_check' AND "intent_id" IS NOT NULL AND "payload" ? 'pull');
