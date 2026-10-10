import { Prisma } from '@prisma/client';
import type { AlertEvaluation } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import type { SafeAlertCard } from './safe-card.js';
import { isNewer, transitionFor, type AlertTransition, type IncidentRow } from './semantics.js';
export { isNewer, transitionFor, type AlertTransition, type IncidentRow } from './semantics.js';
export type PersistResult = { kind: 'accepted'; notificationKey?: string } | { kind: 'duplicate' };

export interface AlertPersistence {
  persist(input: {
    evaluation: AlertEvaluation;
    cards: Record<AlertTransition, SafeAlertCard>;
    /** false 时仍更新事故，但不写飞书 outbox。缺省保持投递。 */
    notify?: boolean;
  }): Promise<PersistResult>;
}

function notificationKey(evaluation: AlertEvaluation, transition: AlertTransition): string {
  return `${evaluation.fingerprint}:${transition}:${evaluation.evaluation_id}`;
}

/**
 * A single Prisma transaction holds the fingerprint row lock while it updates the incident and
 * inserts the outbox row. No Feishu call is made here, so a provider outage cannot hold a DB lock.
 */
export class PrismaAlertPersistence implements AlertPersistence {
  async persist(input: {
    evaluation: AlertEvaluation;
    cards: Record<AlertTransition, SafeAlertCard>;
    notify?: boolean;
  }): Promise<PersistResult> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRaw<IncidentRow[]>(Prisma.sql`
        SELECT id, state, severity, last_window_ended_at, last_observed_at, latest_evaluation_id
        FROM app_core.alert_incidents
        WHERE fingerprint = ${input.evaluation.fingerprint}
        FOR UPDATE
      `);
      const row = existing[0];

      if (!row) {
        if (input.evaluation.state === 'healthy') return { kind: 'duplicate' };
        const inserted = await tx.$queryRaw<Array<{ id: bigint }>>(Prisma.sql`
          INSERT INTO app_core.alert_incidents (
            fingerprint, state, severity, confidence, location, title, summary, recommended_action,
            latest_evaluation_id, latest_producer_run_id, first_firing_at, last_firing_at,
            last_observed_at, last_window_ended_at, metrics, samples
          ) VALUES (
            ${input.evaluation.fingerprint}, 'open', ${input.evaluation.severity}, ${input.evaluation.confidence},
            ${JSON.stringify(input.evaluation.location)}::jsonb, ${input.evaluation.title}, ${input.evaluation.summary},
            ${input.evaluation.recommended_action ?? null}, ${input.evaluation.evaluation_id}::uuid,
            ${input.evaluation.producer_run_id}::uuid, ${input.evaluation.observed_at}::timestamptz,
            ${input.evaluation.observed_at}::timestamptz, ${input.evaluation.observed_at}::timestamptz,
            ${input.evaluation.window_ended_at}::timestamptz, ${JSON.stringify(input.evaluation.metrics)}::jsonb,
            ${JSON.stringify(input.evaluation.samples)}::jsonb
          ) RETURNING id
        `);
        const key = await this.enqueue(tx, input, inserted[0]!.id, 'firing', input.cards.firing);
        return key ? { kind: 'accepted', notificationKey: key } : { kind: 'accepted' };
      }

      if (
        row.latest_evaluation_id === input.evaluation.evaluation_id ||
        !isNewer(row, input.evaluation)
      ) {
        return { kind: 'duplicate' };
      }
      const transition = transitionFor(row, input.evaluation);
      const state = input.evaluation.state === 'healthy' ? 'recovered' : 'open';
      await tx.$executeRaw(Prisma.sql`
        UPDATE app_core.alert_incidents SET
          state = ${state}, severity = ${input.evaluation.severity}, confidence = ${input.evaluation.confidence},
          location = ${JSON.stringify(input.evaluation.location)}::jsonb, title = ${input.evaluation.title},
          summary = ${input.evaluation.summary}, recommended_action = ${input.evaluation.recommended_action ?? null},
          latest_evaluation_id = ${input.evaluation.evaluation_id}::uuid,
          latest_producer_run_id = ${input.evaluation.producer_run_id}::uuid,
          first_firing_at = CASE WHEN ${state} = 'open' AND first_firing_at IS NULL THEN ${input.evaluation.observed_at}::timestamptz ELSE first_firing_at END,
          last_firing_at = CASE WHEN ${state} = 'open' THEN ${input.evaluation.observed_at}::timestamptz ELSE last_firing_at END,
          last_healthy_at = CASE WHEN ${state} = 'recovered' THEN ${input.evaluation.observed_at}::timestamptz ELSE last_healthy_at END,
          last_observed_at = ${input.evaluation.observed_at}::timestamptz,
          last_window_ended_at = ${input.evaluation.window_ended_at}::timestamptz,
          metrics = ${JSON.stringify(input.evaluation.metrics)}::jsonb,
          samples = ${JSON.stringify(input.evaluation.samples)}::jsonb,
          updated_at = now()
        WHERE id = ${row.id}
      `);
      if (!transition) return { kind: 'accepted' };
      const key = await this.enqueue(tx, input, row.id, transition, input.cards[transition]);
      return key ? { kind: 'accepted', notificationKey: key } : { kind: 'accepted' };
    });
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    input: { evaluation: AlertEvaluation; notify?: boolean },
    incidentId: bigint,
    transition: AlertTransition,
    card: SafeAlertCard
  ): Promise<string | null> {
    if (input.notify === false) return null;
    const key = notificationKey(input.evaluation, transition);
    await this.insertOutbox(tx, incidentId, key, transition, card);
    return key;
  }

  private async insertOutbox(
    tx: Prisma.TransactionClient,
    incidentId: bigint,
    key: string,
    transition: AlertTransition,
    card: SafeAlertCard
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO app_core.alert_delivery_attempts (
        incident_id, channel, notification_key, transition, state, payload, next_attempt_at
      ) VALUES (${incidentId}, 'feishu', ${key}, ${transition}, 'pending', ${JSON.stringify(card)}::jsonb, now())
      ON CONFLICT (notification_key) DO NOTHING
    `);
  }
}
