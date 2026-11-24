import { randomUUID } from 'node:crypto';
import type { AlertEvaluation, RelayProvider } from '@miniapp/shared';
import type { Logger } from '../../lib/logger.js';
import { config } from '../../platform/config.js';
import { getRelayBalance } from '../../platform/relay-provider-balance.js';
import { readRelayProviderPolicy } from '../../platform/relay-provider-policy.js';
import type { AlertPublisher } from '../alerting/publisher.js';

function evaluation(
  provider: RelayProvider,
  quota: number,
  threshold: number,
  firing: boolean,
  now: Date
): AlertEvaluation {
  const environment =
    config.nodeEnv === 'production'
      ? 'production'
      : config.nodeEnv === 'test'
        ? 'test'
        : 'development';
  const at = now.toISOString();
  const rule = `${provider}-balance-low`;
  return {
    schema_version: 1,
    evaluation_id: randomUUID(),
    producer_run_id: randomUUID(),
    domain: 'generation',
    service: 'llm_generation',
    environment,
    rule_id: rule,
    rule_version: '1',
    rule_group: rule,
    fingerprint: `${environment}:generation:${provider}:balance_low`,
    state: firing ? 'firing' : 'healthy',
    severity: 'P1',
    location: { kind: 'dependency', component: provider },
    confidence: 'confirmed',
    observed_at: at,
    window_started_at: at,
    window_ended_at: at,
    title: firing ? `${provider} 平台额度低于阈值` : `${provider} 平台额度恢复`,
    summary: `${provider} 原生额度${firing ? '低于' : '达到'}已发布阈值；额度不等同于美元。`,
    metrics: [
      { name: 'balance_quota', value: quota, unit: 'count' },
      { name: 'threshold_quota', value: threshold, unit: 'count' },
    ],
    samples: [{ kind: 'provider', reference: provider }],
    recommended_action: '在供应商控制台核对账户余额及已发布额度策略。',
  };
}

/** Reuses the monitor's session lease and Publisher/outbox fingerprint, never the user billing path. */
export class RelayBalanceMonitor {
  private healthyPasses = 0;
  private policyIdentity = '';
  constructor(
    private readonly provider: RelayProvider,
    private readonly publisher: Pick<AlertPublisher, 'publish'>,
    private readonly log: Pick<Logger, 'sys' | 'biz'>
  ) {}

  async runOnce(
    now = new Date()
  ): Promise<{ outcome: 'ok' | 'skipped' | 'probe_failed'; published: number }> {
    try {
      const policy = await readRelayProviderPolicy(this.provider);
      const identity = JSON.stringify([policy.monitor_enabled, policy.low_balance_quota]);
      if (identity !== this.policyIdentity) {
        this.healthyPasses = 0;
        this.policyIdentity = identity;
      }
      if (!policy.monitor_enabled || policy.low_balance_quota === null) {
        this.healthyPasses = 0;
        return { outcome: 'skipped', published: 0 };
      }
      const balance = await getRelayBalance(this.provider, true);
      if (balance.status !== 'ok' || balance.native_balance === null) {
        this.healthyPasses = 0;
        return {
          outcome: balance.status === 'not_configured' ? 'skipped' : 'probe_failed',
          published: 0,
        };
      }
      const firing = balance.native_balance < policy.low_balance_quota;
      this.healthyPasses = firing ? 0 : this.healthyPasses + 1;
      if (!firing && this.healthyPasses < 2) return { outcome: 'ok', published: 0 };
      const result = await this.publisher.publish(
        evaluation(this.provider, balance.native_balance, policy.low_balance_quota, firing, now),
        { notify: true }
      );
      return { outcome: 'ok', published: result.kind === 'accepted' ? 1 : 0 };
    } catch (err) {
      this.healthyPasses = 0;
      this.log.sys.warn(
        {
          event: 'provider.balance_probe_completed',
          provider: this.provider,
          outcome: 'failed',
          err,
        },
        '供应商余额监控失败；不发布健康结果'
      );
      return { outcome: 'probe_failed', published: 0 };
    }
  }
}
