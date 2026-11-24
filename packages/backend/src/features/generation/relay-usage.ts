import { RelayUsageSnapshotSchema } from '@miniapp/shared';
import { isRelayRecord } from '../../infrastructure/relay-provider-client.js';

export const relayTokenCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const relayIdentity = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !/[\u0000-\u001f]/.test(value)
    ? value
    : null;

/** Cache/reasoning counters are subsets; they are never added to prompt/completion totals. */
export function relayUsageSnapshot(value: unknown) {
  const usage = isRelayRecord(value) ? value : {};
  const prompt = isRelayRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completion = isRelayRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : {};
  return RelayUsageSnapshotSchema.parse({
    schema_version: 1,
    usage: {
      prompt_tokens: relayTokenCount(usage.prompt_tokens),
      completion_tokens: relayTokenCount(usage.completion_tokens),
      cached_tokens: relayTokenCount(prompt.cached_tokens),
      reasoning_tokens: relayTokenCount(completion.reasoning_tokens),
    },
    billing_detail: { match: 'pending', quota: null, conversion_version: null },
  });
}
