CREATE TABLE "world_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"refs" jsonb NOT NULL,
	"mine" boolean DEFAULT false NOT NULL,
	"active_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "world_changes_subject_idx" ON "world_changes" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "world_changes_at_idx" ON "world_changes" USING btree ("at");