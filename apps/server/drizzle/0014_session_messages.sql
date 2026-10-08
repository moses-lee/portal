-- The trigram opclass of the text index below. Trusted since Postgres 13, so the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "session_messages" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"first_seq" integer NOT NULL,
	"role" text NOT NULL,
	"ts" bigint NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "session_messages_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_messages_text_trgm_idx" ON "session_messages" USING gin ("text" gin_trgm_ops);