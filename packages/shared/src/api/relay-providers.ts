import { z } from 'zod';

export const RelayProviderSchema = z.enum(['packy', 'onexmodel']);
export type RelayProvider = z.infer<typeof RelayProviderSchema>;
export const LLM_RELAY_PROVIDER_CONFIG_KEY = 'llm_relay_provider_config' as const;

/** Quota is a platform unit. USD conversion requires an explicitly published, versioned basis. */
export const RelayProviderPolicySchema = z
  .object({
    quota_per_unit: z.number().finite().positive().nullable().default(null),
    cny_per_unit: z.number().finite().positive().nullable().default(null),
    usd_per_cny: z.number().finite().positive().nullable().default(null),
    conversion_version: z.string().trim().min(1).max(64).nullable().default(null),
    conversion_source: z.string().trim().min(1).max(256).nullable().default(null),
    monitor_enabled: z.boolean().default(false),
    low_balance_quota: z.number().finite().nonnegative().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.monitor_enabled && value.low_balance_quota === null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['low_balance_quota'],
        message: 'Required when monitoring is enabled',
      });
    if (
      value.usd_per_cny !== null &&
      [
        value.quota_per_unit,
        value.cny_per_unit,
        value.conversion_version,
        value.conversion_source,
      ].some((v) => v === null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usd_per_cny'],
        message: 'Conversion requires units, version and source',
      });
  });
export type RelayProviderPolicy = z.infer<typeof RelayProviderPolicySchema>;
export const LlmRelayProviderConfigSchema = z
  .object({
    packy: RelayProviderPolicySchema,
    onexmodel: RelayProviderPolicySchema,
  })
  .strict();
export type LlmRelayProviderConfig = z.infer<typeof LlmRelayProviderConfigSchema>;
export const DEFAULT_LLM_RELAY_PROVIDER_CONFIG: LlmRelayProviderConfig = {
  packy: RelayProviderPolicySchema.parse({}),
  onexmodel: RelayProviderPolicySchema.parse({}),
};

export const ProviderBalanceSchema = z
  .object({
    provider: RelayProviderSchema,
    status: z.enum(['ok', 'not_configured', 'failed']),
    fetched_at: z.string().datetime(),
    native_balance: z.number().finite().nonnegative().nullable(),
    native_unit: z.literal('quota'),
    balance_cny: z.number().finite().nonnegative().nullable(),
    balance_usd: z.number().finite().nonnegative().nullable(),
    conversion_version: z.string().max(64).nullable(),
    error_code: z
      .enum([
        'missing_credentials',
        'invalid_config',
        'auth_failed',
        'rate_limited',
        'timeout',
        'upstream',
        'invalid_body',
      ])
      .nullable(),
  })
  .strict();
export type ProviderBalance = z.infer<typeof ProviderBalanceSchema>;

/** Bounded allowlist for relay usage observations, never a supplier response/body archive. */
export const RelayUsageSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().nullable(),
        completion_tokens: z.number().int().nonnegative().nullable(),
        cached_tokens: z.number().int().nonnegative().nullable(),
        reasoning_tokens: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    billing_detail: z
      .object({
        match: z.enum(['pending', 'matched', 'unavailable', 'ambiguous', 'conflict']),
        quota: z.number().finite().nonnegative().nullable(),
        conversion_version: z.string().max(64).nullable(),
      })
      .strict(),
  })
  .strict();
