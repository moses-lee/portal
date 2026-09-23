CREATE TABLE "session_events" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" bigint NOT NULL,
	"body" jsonb NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"ordinal" bigserial NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"cwd" text NOT NULL,
	"project_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_active_at" bigint NOT NULL,
	"title" text,
	"upstream_id" text NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;