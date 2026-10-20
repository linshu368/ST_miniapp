-- domain: experience
-- Production DROP guard (2026-10-20) blocked on 6 chat turns stuck in 'streaming' since
-- 2026-10-02..15, 4 of them still holding a reserved free-quota round. Close exactly these turns
-- the way ConversationHistoryRepository.recoverStaleStreaming does: release the reservation
-- (no round consumed), then mark the turn interrupted. No charge, dedup, wallet or settled_at
-- is written; none of the turns has billing rows, a generation ID, a snapshot or provider detail.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $closure$
DECLARE
  ids uuid[] := ARRAY[
    'bee9f225-346e-46dc-896d-8bf09a56b3d6','158eef2a-a442-425c-b613-2ec77b4bd766',
    '9c4aeaa3-2ca0-4016-b343-8b1667fc1673','269e7617-0176-4e6e-a894-fbff63a56fc2',
    '68f31aad-eeb8-4d95-8b2b-f26744d20633','48f41aef-daac-4cee-809c-ecd5a7b7ead5']::uuid[];
  found integer; r record; updated integer;
BEGIN
  SELECT count(*) INTO found FROM experience.chat_history WHERE id=ANY(ids);
  IF found=0 THEN
    RAISE NOTICE 'Abandoned streaming closure skipped: target turns do not exist in this environment';
    RETURN;
  END IF;
  IF found<>cardinality(ids) THEN
    RAISE EXCEPTION 'Abandoned streaming closure found % of % reviewed turns', found, cardinality(ids);
  END IF;
  -- Lock before judging so a live writer cannot finish a turn between the check and the update.
  PERFORM 1 FROM experience.chat_history WHERE id=ANY(ids) ORDER BY id FOR UPDATE;

  -- Already-closed turns are skipped, which makes a re-run a no-op. Any evidence that the call
  -- reached a provider or the ledger means it needs manual classification, not a blind close.
  IF EXISTS (SELECT 1 FROM experience.chat_history h
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id=h.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id=h.id
    LEFT JOIN billing.llm_usage_charges c ON c.charge_key=h.llm_charge_id
    LEFT JOIN billing.llm_usage_charge_dedup d ON d.charge_key=h.llm_charge_id
    WHERE h.id=ANY(ids) AND h.status='streaming' AND (
      h.created_at>now()-interval '24 hours'
      OR h.llm_generation_id IS NOT NULL OR h.llm_billing_snapshot IS NOT NULL
      OR h.llm_billing_settled_at IS NOT NULL
      OR o.chat_history_id IS NOT NULL OR v.chat_history_id IS NOT NULL
      OR c.charge_key IS NOT NULL OR d.charge_key IS NOT NULL))
    THEN RAISE EXCEPTION 'Abandoned streaming turn has billing/provider evidence; classify manually'; END IF;

  FOR r IN SELECT h.llm_charge_id, h.user_id, q.status AS quota_status, q.user_id AS quota_user
    FROM experience.chat_history h
    LEFT JOIN billing.character_free_chat_quota_decisions q ON q.charge_key=h.llm_charge_id
    WHERE h.id=ANY(ids) AND h.status='streaming' ORDER BY h.id
  LOOP
    IF r.quota_status IS NOT NULL AND r.quota_user IS DISTINCT FROM r.user_id
      THEN RAISE EXCEPTION 'Abandoned streaming quota belongs to another user'; END IF;
    -- finalize(false) is the product's own release: reserved_rounds-1, used_rounds unchanged.
    IF r.quota_status='reserved' THEN
      PERFORM billing.finalize_character_free_chat_round(r.llm_charge_id, false);
    END IF;
  END LOOP;

  -- A cancelled turn keeps its reason (generate.ts maps it to stream_interrupted); a turn with no
  -- reason gets 'timeout', matching stale-stream recovery.
  UPDATE experience.chat_history
  SET status='stream_interrupted', llm_finish_reason=coalesce(llm_finish_reason,'timeout')
  WHERE id=ANY(ids) AND status='streaming';
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF EXISTS (SELECT 1 FROM experience.chat_history h
    JOIN billing.character_free_chat_quota_decisions q ON q.charge_key=h.llm_charge_id
    WHERE h.id=ANY(ids) AND q.status='reserved')
    THEN RAISE EXCEPTION 'Abandoned streaming quota still reserved'; END IF;
  RAISE NOTICE 'Abandoned streaming closure interrupted % turns', updated;
END $closure$;
COMMIT;
-- Forward-fix only: re-opening a turn or re-reserving a round is not supported. Re-running is a no-op.
