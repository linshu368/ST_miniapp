-- domain: experience
-- Prerequisites: image_plaza_v2, seed_catalog, feed_like_order. Manual workflow only.
-- Atomic one-time initialization, including liked works; new works retain NULL.
-- Reruns deliberately fail on the existing column, even if the initial catalog was empty.
-- Roll back application readers first; retain this additive column/data until separately reviewed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE experience.image_plaza_works IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF (SELECT count(*) FROM (
    SELECT 1 FROM experience.image_plaza_works WHERE deleted_at IS NULL LIMIT 100001
  ) AS candidates) > 100000 THEN
    RAISE EXCEPTION 'initial feed catalog exceeds reviewed capacity; stop and review';
  END IF;
END;
$$;

ALTER TABLE experience.image_plaza_works
  ADD COLUMN initial_feed_order bigint,
  ADD CONSTRAINT image_plaza_works_initial_feed_order_positive CHECK (initial_feed_order > 0),
  ADD CONSTRAINT image_plaza_works_initial_feed_order_unique UNIQUE (initial_feed_order);

WITH model_ranks AS (
  SELECT id, model_name,
    row_number() OVER (
      PARTITION BY model_name
      ORDER BY source_heat DESC NULLS LAST, published_at DESC, id DESC
    ) AS model_rank
  FROM experience.image_plaza_works
  WHERE deleted_at IS NULL
), initial_order AS (
  SELECT id, row_number() OVER (
    ORDER BY model_rank, model_name COLLATE "C", id DESC
  ) AS ordinal
  FROM model_ranks
)
UPDATE experience.image_plaza_works AS work
SET initial_feed_order = initial_order.ordinal
FROM initial_order
WHERE work.id = initial_order.id;

CREATE INDEX image_plaza_works_zero_feed_idx
  ON experience.image_plaza_works(initial_feed_order ASC NULLS LAST, published_at DESC, id DESC)
  WHERE deleted_at IS NULL AND like_count = 0;
CREATE INDEX image_plaza_works_latest_feed_idx
  ON experience.image_plaza_works(published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN experience.image_plaza_works.initial_feed_order IS
  'One-time model-interleaved initial catalog order; used only at zero likes. Never renumber; new works NULL.';
-- Existing table RLS/ACL and like/share/import write paths remain unchanged.
NOTIFY pgrst, 'reload schema';
COMMIT;