-- domain: app_core
--
-- Forward-fix for 20261010_payment_alerting_foundation.sql. The notification outbox references
-- its incident root; Publisher recovery and incident-retention paths need this covering FK index.
-- Do not rewrite the ledgered foundation migration.
--
-- Rollback: retain the index unless an explain-backed forward migration proves it unnecessary.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.alert_delivery_attempts') IS NULL
     OR to_regclass('app_core.alert_incidents') IS NULL THEN
    RAISE EXCEPTION '20261010 alert delivery incident index preflight: foundation tables missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS con
    WHERE con.conrelid = 'app_core.alert_delivery_attempts'::regclass
      AND con.contype = 'f'
      AND con.confrelid = 'app_core.alert_incidents'::regclass
      AND con.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'app_core.alert_delivery_attempts'::regclass
            AND attname = 'incident_id'
            AND NOT attisdropped
        )
      ]
  ) THEN
    RAISE EXCEPTION '20261010 alert delivery incident index preflight: expected incident FK missing';
  END IF;
END
$preflight$;

CREATE INDEX idx_alert_delivery_attempts_incident_id
  ON app_core.alert_delivery_attempts (incident_id);

COMMENT ON INDEX app_core.idx_alert_delivery_attempts_incident_id IS
  '覆盖 alert_delivery_attempts.incident_id 外键，支撑事故关联的通知恢复与保留清理。';

DO $postflight$
BEGIN
  IF to_regclass('app_core.idx_alert_delivery_attempts_incident_id') IS NULL THEN
    RAISE EXCEPTION '20261010 alert delivery incident index postflight: index missing';
  END IF;
END
$postflight$;

COMMIT;
