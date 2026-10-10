import { fetchRuntimeConfigEntryStrict } from '../../platform/runtime-config.js';

export const ALERTING_RUNTIME_CONFIG_KEY = 'alerting';

export interface AlertingRuntimeConfig {
  notifications_enabled: boolean;
  feishu_timeout_ms: number;
  max_attempts: number;
  min_delivery_interval_ms: number;
}

const DEFAULT_CONFIG: AlertingRuntimeConfig = {
  notifications_enabled: false,
  feishu_timeout_ms: 3_000,
  max_attempts: 3,
  min_delivery_interval_ms: 1_000,
};

/** Missing config is intentionally safe: persistence continues but notification stays off. */
export async function readAlertingRuntimeConfig(): Promise<AlertingRuntimeConfig> {
  const entry = await fetchRuntimeConfigEntryStrict(ALERTING_RUNTIME_CONFIG_KEY);
  if (!entry) return DEFAULT_CONFIG;
  return parseAlertingRuntimeConfig(entry.value);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function parseAlertingRuntimeConfig(value: unknown): AlertingRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_CONFIG;
  const config = value as Record<string, unknown>;
  return {
    notifications_enabled: config.notifications_enabled === true,
    feishu_timeout_ms: boundedInteger(
      config.feishu_timeout_ms,
      100,
      10_000,
      DEFAULT_CONFIG.feishu_timeout_ms
    ),
    max_attempts: boundedInteger(config.max_attempts, 1, 5, DEFAULT_CONFIG.max_attempts),
    min_delivery_interval_ms: boundedInteger(
      config.min_delivery_interval_ms,
      0,
      3_600_000,
      DEFAULT_CONFIG.min_delivery_interval_ms
    ),
  };
}
