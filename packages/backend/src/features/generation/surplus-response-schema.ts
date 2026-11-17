/** Surplus diagnostics are a protocol projection, never an arbitrary response archive. */
export type SurplusJson = null | boolean | number | string | SurplusJson[] | SurplusObject;
export interface SurplusObject {
  [key: string]: SurplusJson;
}
export type SurplusRule =
  | 'count'
  | 'duration'
  | 'finite'
  | 'code'
  | 'money'
  | 'identifier'
  | 'identity'
  | 'label'
  | 'boolean'
  | { fields: Record<string, SurplusRule> }
  | { items: SurplusRule }
  | { values: readonly string[] };

const fields = (value: Record<string, SurplusRule>): SurplusRule => ({ fields: value });
const values = (...value: string[]): SurplusRule => ({ values: value });
const tokenDetails = fields({
  cached_tokens: 'count',
  reasoning_tokens: 'count',
  audio_tokens: 'count',
  text_tokens: 'count',
  image_tokens: 'count',
  video_tokens: 'count',
  accepted_prediction_tokens: 'count',
  rejected_prediction_tokens: 'count',
  cache_creation_tokens: 'count',
  cache_read_tokens: 'count',
});

export const SURPLUS_USAGE_RULE = fields({
  prompt_tokens: 'count',
  completion_tokens: 'count',
  total_tokens: 'count',
  input_tokens: 'count',
  output_tokens: 'count',
  cached_tokens: 'count',
  reasoning_tokens: 'count',
  cache_creation_input_tokens: 'count',
  cache_read_input_tokens: 'count',
  prompt_tokens_details: tokenDetails,
  completion_tokens_details: tokenDetails,
  input_tokens_details: tokenDetails,
  output_tokens_details: tokenDetails,
  buyer_cost_micro: 'money',
  cost_micro: 'money',
});

// No current chat request carries a tool-name contract. Do not retain model-generated names/args.
const tool = fields({ index: 'count', id: 'identity', type: values('function') });
const message = fields({
  role: values('assistant', 'system', 'user', 'tool', 'function'),
  tool_calls: { items: tool },
});
const error = fields({
  code: 'code',
  type: 'label',
  param: 'identifier',
  request_id: 'identity',
  status: 'count',
});

const responseFields: Record<string, SurplusRule> = {
  id: 'identity',
  request_id: 'identity',
  generation_id: 'identity',
  object: 'label',
  created: 'count',
  created_at: 'identifier',
  completed_at: 'identifier',
  model: 'identifier',
  provider: 'identifier',
  provider_name: 'identifier',
  system_fingerprint: 'identifier',
  service_tier: 'label',
  finish_reason: 'label',
  status: 'label',
  usage: SURPLUS_USAGE_RULE,
  error,
  choices: { items: fields({ index: 'count', finish_reason: 'label', message, delta: message }) },
  route_overhead_ms: 'duration',
  first_token_ms: 'duration',
  upstream_total_ms: 'duration',
  latency_ms: 'duration',
  generation_time_ms: 'duration',
  buyer_cost_micro: 'money',
  cost_micro: 'money',
  currency: values('USD', 'USDC', 'usd', 'usdc'),
  served_by: values('marketplace', 'preferred_key', 'fallback_key'),
  marketplace_attempts: 'count',
  truncated: 'boolean',
};
export const SURPLUS_RESPONSE_RULE: SurplusRule = fields(responseFields);
export const SURPLUS_REQUEST_RECORD_RULE: SurplusRule = fields({
  ...responseFields,
  data: SURPLUS_RESPONSE_RULE,
  request: SURPLUS_RESPONSE_RULE,
});

export const SURPLUS_EXCLUDED_KEYS = new Set([
  'content',
  'text',
  'reasoning',
  'reasoning_content',
  'reasoning_details',
  'refusal',
  'arguments',
  'logprobs',
  'token',
  'bytes',
  'authorization',
  'api_key',
  'key',
  'token_id',
  'user',
  'user_id',
  'account_id',
  'wallet',
  'email',
  'prompt',
  'messages',
  'input',
  'output',
  'request',
  'response',
  'body',
  'data',
  'metadata',
  'headers',
  'tools',
  'message',
]);

export const SURPLUS_REQUEST_RULE: SurplusRule = fields({
  model: 'identifier',
  stream: 'boolean',
  temperature: 'duration',
  top_p: 'duration',
  top_k: 'count',
  max_tokens: 'count',
  max_completion_tokens: 'count',
  seed: 'count',
  frequency_penalty: 'finite',
  presence_penalty: 'finite',
  repetition_penalty: 'duration',
  reasoning_effort: values('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
  reasoning: fields({
    enabled: 'boolean',
    exclude: 'boolean',
    effort: 'label',
    max_tokens: 'count',
  }),
  stream_options: fields({ include_usage: 'boolean' }),
});

export function surplusRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeSurplusIdentifier(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    /^[a-zA-Z0-9_.:/@+\-]+$/.test(value) &&
    !/^(?:bearer|sk[-_]|inf[-_]|sb_secret[-_]|eyJ[a-zA-Z0-9_-]{10})/i.test(value)
  );
}

/** Match the dedicated identity columns/repository, rather than the broader model-id grammar. */
export function safeSurplusIdentity(value: unknown): value is string {
  return safeSurplusIdentifier(value) && /^[a-zA-Z0-9_.:-]{1,512}$/.test(value);
}

export function surplusMoney(value: unknown): string | null {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(value) ? value : null;
}

export function surplusUsd(micro: string | null): string | null {
  if (micro === null) return null;
  const amount = BigInt(micro);
  return `${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, '0')}`;
}

/** PostgreSQL jsonb::text adds spaces after structural separators; use its larger byte budget. */
export function surplusJsonbBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  let separators = 0;
  let insideString = false;
  let escaped = false;
  for (const char of serialized) {
    if (insideString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') insideString = false;
    } else if (char === '"') insideString = true;
    else if (char === ':' || char === ',') separators += 1;
  }
  return Buffer.byteLength(serialized, 'utf8') + separators + postgresExponentBytes(value);
}

function postgresExponentBytes(value: unknown): number {
  if (typeof value === 'number') {
    const original = JSON.stringify(value);
    const parts = /^(-?)([0-9]+)(?:\.([0-9]+))?e([+-]?[0-9]+)$/.exec(original);
    if (!parts) return 0;
    const [, sign = '', integer, fraction = '', exponent] = parts;
    if (integer === undefined || exponent === undefined) return 0;
    const digits = integer + fraction;
    const point = integer.length + Number(exponent);
    const expanded =
      sign.length +
      (point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1);
    return Math.max(0, expanded - original.length);
  }
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + postgresExponentBytes(item), 0);
  const record = surplusRecord(value);
  return record
    ? Object.values(record).reduce<number>((sum, item) => sum + postgresExponentBytes(item), 0)
    : 0;
}
