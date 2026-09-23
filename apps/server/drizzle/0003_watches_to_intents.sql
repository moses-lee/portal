-- Watches become intents, tick reports become runs of the tick job (phase 2, step 2). The mapping
-- matches src/orchestrator/jobs/legacy.ts, which the legacy importer uses: an intent keeps its
-- watch's id (items link it by id), an active one gets a check job every ten minutes, and items'
-- links.watchId becomes links.intentId. The next migration drops orchestrator_watches and
-- orchestrator_ticks.
INSERT INTO "intents" ("id", "text", "trigger", "action", "notes", "scope", "status", "expires_at", "fire_budget", "fires", "cooldown_ms", "last_fired_at", "last_checked_at", "thread_id", "created_at", "updated_at")
SELECT
  w."id",
  coalesce(nullif(trim(w."body"->>'intent'), ''), '(no description)'),
  'Something the notes are waiting for has happened: the user is needed, or the request is fulfilled.',
  'Tell the user what changed and what they need to do; close the intent once the request is fulfilled.',
  coalesce(w."body"->>'notes', ''),
  jsonb_build_object(
    'projectIds', coalesce(w."body"->'links'->'projectIds', '[]'::jsonb),
    'sessionIds', coalesce(w."body"->'links'->'sessionIds', '[]'::jsonb),
    'pulls', coalesce(w."body"->'links'->'pulls', '[]'::jsonb),
    'repos', coalesce((
      SELECT jsonb_agg(r."repo" ORDER BY r."first")
      FROM (
        SELECT p."value"->>'repo' AS "repo", min(p."ordinality") AS "first"
        FROM jsonb_array_elements(coalesce(w."body"->'links'->'pulls', '[]'::jsonb)) WITH ORDINALITY AS p("value", "ordinality")
        WHERE p."value"->>'repo' IS NOT NULL
        GROUP BY 1
      ) AS r
    ), '[]'::jsonb),
    'people', '[]'::jsonb,
    'taskTypes', '[]'::jsonb
  ),
  CASE w."status" WHEN 'active' THEN 'active' WHEN 'done' THEN 'done' ELSE 'cancelled' END,
  NULL, NULL, 0, 0, NULL, w."last_checked_at", NULL, w."created_at", w."updated_at"
FROM "orchestrator_watches" AS w
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "jobs" ("id", "kind", "title", "schedule", "payload", "status", "next_run_at", "last_run_at", "last_run_id", "intent_id", "thread_id", "created_by", "failures", "locked_until", "created_at", "updated_at")
SELECT
  'chk-' || w."id",
  'intent_check',
  'Check: ' || CASE WHEN length(t."text") > 100 THEN left(t."text", 99) || '…' ELSE t."text" END,
  '{"type":"every","everyMs":600000}'::jsonb,
  jsonb_build_object('intentId', w."id"),
  'active',
  (extract(epoch FROM now()) * 1000)::bigint + 600000,
  w."last_checked_at",
  NULL, w."id", NULL, 'system', 0, NULL,
  (extract(epoch FROM now()) * 1000)::bigint,
  (extract(epoch FROM now()) * 1000)::bigint
FROM "orchestrator_watches" AS w
CROSS JOIN LATERAL (SELECT regexp_replace(coalesce(nullif(trim(w."body"->>'intent'), ''), '(no description)'), '\s+', ' ', 'g') AS "text") AS t
WHERE w."status" = 'active'
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "orchestrator_items"
SET "body" = (CASE
    WHEN ("body"->'links') ? 'watchId'
      THEN jsonb_set("body", '{links}', (("body"->'links') - 'watchId') || jsonb_build_object('intentId', coalesce("body"->'links'->'intentId', "body"->'links'->'watchId')))
    ELSE "body"
  END) || (CASE WHEN ("body"->>'kind') = 'watch_update' THEN '{"kind":"intent_update"}'::jsonb ELSE '{}'::jsonb END)
WHERE ("body"->'links') ? 'watchId' OR ("body"->>'kind') = 'watch_update';
--> statement-breakpoint
INSERT INTO "job_runs" ("id", "job_id", "kind", "thread_id", "parent_run_id", "status", "trigger", "started_at", "finished_at", "model", "usage", "log", "result", "summary", "error")
SELECT
  t."id", 'tick', 'tick', NULL, NULL,
  CASE WHEN f."failed" THEN 'failed' ELSE 'succeeded' END,
  CASE WHEN t."body"->>'reason' = 'manual' THEN 'manual' ELSE 'schedule' END,
  t."started_at", t."finished_at", NULL,
  CASE WHEN jsonb_typeof(t."body"->'usage') = 'object' THEN t."body"->'usage' ELSE NULL END,
  CASE WHEN jsonb_typeof(t."body"->'log') = 'array' THEN t."body"->'log' ELSE '[]'::jsonb END,
  t."body",
  CASE
    WHEN f."failed" THEN 'Failed: ' || (t."body"->>'error')
    WHEN (t."body"->>'modelInvoked')::boolean THEN coalesce(t."body"->>'changes', '0') || ' change(s) considered'
    ELSE 'Nothing changed.'
  END,
  CASE WHEN f."failed" THEN t."body"->>'error' ELSE NULL END
FROM "orchestrator_ticks" AS t
CROSS JOIN LATERAL (SELECT (t."body"->>'error') IS NOT NULL AND (t."body"->>'error') NOT IN ('not ready', 'busy') AS "failed") AS f
ON CONFLICT ("id") DO NOTHING;
