-- domain: experience. MANUAL finite backfill, not a schema-ledger migration.
-- Confirm target/capacity/approval first. psql -X -v ON_ERROR_STOP=1 -f this-file.
-- No outer transaction. Each of 100 batches has a separate 3s statement/500ms
-- lock budget and at most 100 IDs. Rerun explicitly to revisit skipped locks or
-- interrupted ranges. Checkpoint exists only in this connection; rerun safely
-- rescans missing/invalid projections. No prompt/identity is printed or exported.
\set ON_ERROR_STOP on
CREATE TEMP TABLE chat_display_backfill_cursor AS
SELECT NULL::uuid AS after_id,
  (SELECT id FROM experience.chat_history ORDER BY id DESC LIMIT 1) AS upper_id,
  0::integer AS attempted,0::integer AS completed,true AS active;
SELECT $batch$
BEGIN;
SET LOCAL statement_timeout='3s';
SET LOCAL lock_timeout='500ms';
WITH candidates AS MATERIALIZED (
  SELECT h.id FROM experience.chat_history h
  JOIN chat_display_backfill_cursor c ON c.active
  LEFT JOIN experience.chat_history_display_metadata m ON m.history_id=h.id
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND m.projection_version IS DISTINCT FROM 1
    AND (c.after_id IS NULL OR h.id>c.after_id) AND h.id<=c.upper_id
  ORDER BY h.id LIMIT 100
), selected AS MATERIALIZED (SELECT array_agg(id ORDER BY id) AS ids FROM candidates),
written AS MATERIALIZED (
  SELECT ids,CASE WHEN ids IS NULL THEN 0 ELSE experience.backfill_chat_history_display(ids) END AS n FROM selected
)
UPDATE chat_display_backfill_cursor c SET after_id=COALESCE(w.ids[cardinality(w.ids)],c.after_id),
  attempted=c.attempted+COALESCE(cardinality(w.ids),0),completed=c.completed+w.n,active=w.ids IS NOT NULL
FROM written w;
COMMIT;
$batch$ FROM generate_series(1,100)
\gexec
SELECT attempted,completed,attempted-completed AS skipped FROM chat_display_backfill_cursor;
DROP TABLE chat_display_backfill_cursor;
