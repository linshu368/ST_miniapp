import { randomUUID } from 'node:crypto';
import type { RelayProvider } from '@miniapp/shared';
import { prisma } from '../../lib/db.js';
import { createLogger } from '../../lib/logger.js';
import { RelayProviderError } from '../../infrastructure/relay-provider-client.js';
import { readRelayProviderPolicy, relayConversion } from '../../platform/relay-provider-policy.js';
import { lookupRelayInvoice, type InvoiceLookup } from './relay-invoices.js';

interface ClaimedCall {
  id: string;
  attempt_id: string | null;
  provider: RelayProvider;
  request_id: string | null;
  model: string;
  provider_account_ref: string | null;
  dispatched_at: Date;
  attempts: number;
}
const log = createLogger('generation');

async function claim(token: string): Promise<ClaimedCall[]> {
  // One statement owns both the lock and lease; multiple backend replicas cannot claim the same call.
  return prisma.$queryRaw<ClaimedCall[]>`
    WITH exhausted AS (
      UPDATE ops.llm_cost_jobs j SET status = 'unavailable', lease_token = NULL, lease_until = NULL, updated_at = now()
      FROM ops.llm_calls l WHERE j.call_id=l.id AND j.kind='call_cost' AND j.status='pending'
        AND l.provider IN ('packy','onexmodel') AND (j.lease_until IS NULL OR j.lease_until <= now())
        AND (j.attempts>=8 OR l.dispatched_at < now()-interval '24 hours') RETURNING j.call_id
    ), closed AS (
      UPDATE ops.llm_calls l SET cost_source=COALESCE(l.cost_source,'unavailable'),updated_at=now()
      FROM exhausted e WHERE l.id=e.call_id RETURNING l.id
    ), due AS (
      SELECT j.call_id FROM ops.llm_cost_jobs j JOIN ops.llm_calls l ON l.id = j.call_id
      WHERE j.kind = 'call_cost' AND j.status = 'pending' AND l.provider IN ('packy', 'onexmodel')
        AND (j.next_retry_at IS NULL OR j.next_retry_at <= now())
        AND (j.lease_until IS NULL OR j.lease_until <= now())
        AND j.attempts < 8 AND l.dispatched_at >= now()-interval '24 hours'
        AND NOT EXISTS (SELECT 1 FROM ops.llm_cost_jobs active_job JOIN ops.llm_calls active_call ON active_call.id=active_job.call_id
          WHERE active_call.provider=l.provider AND active_job.lease_until>now())
        AND j.call_id=(SELECT candidate.call_id FROM ops.llm_cost_jobs candidate JOIN ops.llm_calls candidate_call ON candidate_call.id=candidate.call_id
          WHERE candidate_call.provider=l.provider AND candidate.kind='call_cost' AND candidate.status='pending' AND candidate.attempts<8
            AND candidate_call.dispatched_at >= now()-interval '24 hours' AND (candidate.next_retry_at IS NULL OR candidate.next_retry_at <= now())
          ORDER BY candidate.next_retry_at NULLS FIRST,candidate.call_id LIMIT 1)
      ORDER BY j.next_retry_at NULLS FIRST, j.call_id FOR UPDATE OF j SKIP LOCKED LIMIT 2
    ), claimed AS (
      UPDATE ops.llm_cost_jobs j SET lease_token = ${token}::uuid, lease_until = now() + interval '180 seconds',
        attempts = least(j.attempts + 1, 8), updated_at = now()
      FROM due WHERE j.call_id = due.call_id RETURNING j.call_id, j.attempts
    ) SELECT l.id::text, l.attempt_id::text, l.provider, l.request_id, l.model, l.provider_account_ref, l.dispatched_at, c.attempts
      FROM claimed c JOIN ops.llm_calls l ON l.id = c.call_id`;
}

async function complete(
  row: ClaimedCall,
  token: string,
  result: InvoiceLookup,
  retryAfterMs = 0
): Promise<void> {
  const policy = result.status === 'matched' ? await readRelayProviderPolicy(row.provider) : null;
  const rate = policy ? relayConversion(policy).usdPerQuota : null;
  const expired = Date.now() - row.dispatched_at.getTime() >= 86_400_000 || row.attempts >= 8;
  const terminal = result.status !== 'pending' || expired;
  const retryAt = new Date(
    Date.now() +
      Math.min(3_600_000, Math.max(retryAfterMs, 60_000 * 2 ** row.attempts)) +
      Math.floor(Math.random() * 10_000)
  );
  await prisma.$transaction(
    async (tx) => {
      const owned = await tx.$executeRaw`
      UPDATE ops.llm_cost_jobs SET status = ${result.status === 'matched' ? 'complete' : terminal ? 'unavailable' : 'pending'},
        next_retry_at = ${terminal ? null : retryAt}, lease_token = NULL, lease_until = NULL, updated_at = now()
      WHERE call_id = ${row.id}::uuid AND lease_token = ${token}::uuid AND lease_until > now()`;
      if (!owned) return;
      if (result.status === 'matched') {
        const invoice = result.invoice;
        await tx.$executeRaw`
        UPDATE ops.llm_calls SET upstream_log_id = ${invoice.logId}, cost_native_amount = ${invoice.quota}::numeric,
          cost_native_unit = 'quota', cost_usd_per_native_unit = ${rate}::numeric,
          cost_usd = ${rate === null ? null : invoice.quota * rate}::numeric, cost_source = 'relay_invoice',
          prompt_tokens = COALESCE(prompt_tokens, ${invoice.promptTokens}::bigint),
          completion_tokens = COALESCE(completion_tokens, ${invoice.completionTokens}::bigint),
          raw_usage = jsonb_set(COALESCE(raw_usage, '{}'::jsonb), '{billing_detail}',
            ${JSON.stringify({ match: 'matched', quota: invoice.quota, conversion_version: policy?.conversion_version ?? null })}::jsonb), updated_at = now()
        WHERE id = ${row.id}::uuid AND provider = ${row.provider} AND provider_account_ref = ${row.provider_account_ref}
          AND (cost_source IS NULL OR cost_source = 'estimated')`;
      } else if (terminal) {
        await tx.$executeRaw`
        UPDATE ops.llm_calls SET cost_source = COALESCE(cost_source, 'unavailable'),
          raw_usage = jsonb_set(COALESCE(raw_usage, '{}'::jsonb), '{billing_detail}', ${JSON.stringify({ match: result.status === 'pending' ? 'unavailable' : result.status, quota: null, conversion_version: null })}::jsonb), updated_at = now()
        WHERE id = ${row.id}::uuid AND provider = ${row.provider}`;
      }
    },
    { timeout: 5_000 }
  );
}

export async function settleRelayCallCosts(): Promise<void> {
  const token = randomUUID();
  const rows = await claim(token);
  await Promise.all(
    rows.map(async (row) => {
      const started = performance.now();
      try {
        const result =
          row.attempts > 8 || Date.now() - row.dispatched_at.getTime() >= 86_400_000
            ? { status: 'unavailable' as const }
            : await lookupRelayInvoice({
                provider: row.provider,
                requestId: row.request_id,
                model: row.model,
                accountRef: row.provider_account_ref,
                dispatchedAt: row.dispatched_at,
              });
        await complete(row, token, result);
        log.biz.info(
          {
            event: 'llm.call_cost_lookup_completed',
            provider: row.provider,
            attemptId: row.attempt_id,
            outcome: result.status,
            job_attempt: row.attempts,
            duration_ms: performance.now() - started,
          },
          '中转平台调用费用补查结束'
        );
      } catch (err) {
        log.sys.warn(
          {
            event: 'llm.call_cost_lookup_completed',
            provider: row.provider,
            attemptId: row.attempt_id,
            outcome: 'failed',
            error_code: err instanceof RelayProviderError ? err.code : 'upstream',
            http_status: err instanceof RelayProviderError ? err.httpStatus : undefined,
            duration_ms: performance.now() - started,
            err,
          },
          '中转平台费用补查失败，不影响用户结算'
        );
        await complete(
          row,
          token,
          { status: 'pending' },
          err instanceof RelayProviderError ? err.retryAfterMs : undefined
        ).catch((writeError: unknown) =>
          log.sys.warn(
            { err: writeError, event: 'llm.call_cost_lookup_write_failed', provider: row.provider },
            '费用任务状态写入失败，等待租约过期'
          )
        );
      }
    })
  );
}
