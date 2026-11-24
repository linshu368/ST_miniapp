import {
  ProviderModelDirectorySchema,
  type ProviderModelDirectory,
  type ProviderModelSummary,
  type RelayProvider,
} from '@miniapp/shared';
import { getLlmProviderRuntimeConfig, getRelayManagementConfig } from './runtime-config.js';
import {
  isRelayRecord,
  relayGet,
  RelayProviderError,
} from '../infrastructure/relay-provider-client.js';
import type { ProviderDirectoryClientOptions } from './model-provider-directory.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('provider');

/** A public catalog proves endpoint capability, never authorization. IDs must also be in /v1/models. */
function chatCapable(model: Record<string, unknown>): boolean {
  const architecture = isRelayRecord(model.architecture) ? model.architecture : null;
  if (architecture && Array.isArray(architecture.output_modalities))
    return (
      architecture.output_modalities.includes('text') &&
      Array.isArray(architecture.input_modalities) &&
      architecture.input_modalities.includes('text')
    );
  if (Array.isArray(model.supported_endpoint_types))
    return model.supported_endpoint_types.includes('openai');
  return model.type === 'text' || model.type === 'chat';
}

export function mapRelayModels(
  provider: RelayProvider,
  authorized: unknown,
  pricing: unknown
): ProviderModelSummary[] {
  if (!isRelayRecord(authorized) || authorized.success === false || !Array.isArray(authorized.data))
    throw new RelayProviderError('invalid_body');
  const publicModels = isRelayRecord(pricing) && Array.isArray(pricing.data) ? pricing.data : [];
  const metadata = new Map(
    publicModels
      .filter(isRelayRecord)
      .filter((row) => typeof row.model_name === 'string')
      .map((row) => [row.model_name as string, row])
  );
  const result = new Map<string, ProviderModelSummary>();
  for (const model of authorized.data) {
    if (
      !isRelayRecord(model) ||
      typeof model.id !== 'string' ||
      !model.id.trim() ||
      model.id.length > 512
    )
      continue;
    const details = metadata.get(model.id);
    if (!chatCapable(model) && (!details || !chatCapable(details))) continue;
    // Never reinterpret quota ratios or a displayed "$" as real USD pricing.
    result.set(model.id, {
      provider,
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      description: typeof model.description === 'string' ? model.description : null,
      context_length:
        typeof model.context_length === 'number' &&
        Number.isSafeInteger(model.context_length) &&
        model.context_length >= 0
          ? model.context_length
          : null,
      prompt_usd_per_token: null,
      completion_usd_per_token: null,
      status: 'available',
      raw_status_label: null,
    });
  }
  return [...result.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

export class RelayProviderDirectoryClient {
  private cached: ProviderModelDirectory | null = null;
  private cachedAt = 0;
  private inFlight: Promise<ProviderModelDirectory> | null = null;
  constructor(
    readonly provider: RelayProvider,
    private readonly options: ProviderDirectoryClientOptions = {}
  ) {}

  async getModels(options: { forceRefresh?: boolean } = {}): Promise<ProviderModelDirectory> {
    const now = this.options.now ?? Date.now;
    if (
      !options.forceRefresh &&
      this.cached &&
      now() - this.cachedAt < (this.options.cacheTtlMs ?? 900_000)
    )
      return this.cached;
    const started = performance.now();
    this.inFlight ??= this.refresh()
      .then((directory) => {
        log.biz.info(
          {
            event: 'provider.directory.completed',
            provider: this.provider,
            outcome: 'succeeded',
            count: directory.models.length,
            duration_ms: performance.now() - started,
          },
          '供应商授权文本模型目录刷新完成'
        );
        return directory;
      })
      .finally(() => {
        this.inFlight = null;
      });
    try {
      return await this.inFlight;
    } catch (err) {
      log.sys.warn(
        {
          event: 'provider.directory.completed',
          provider: this.provider,
          outcome: this.cached ? 'degraded' : 'failed',
          err,
          duration_ms: performance.now() - started,
        },
        '供应商目录刷新失败'
      );
      if (this.cached) return { ...this.cached, stale: true };
      throw err;
    }
  }

  private async refresh(): Promise<ProviderModelDirectory> {
    const runtime = getLlmProviderRuntimeConfig(this.provider);
    const apiKey = this.options.apiKey ?? runtime.apiKey;
    if (!apiKey) throw new RelayProviderError('missing_credentials');
    const endpoint = this.options.endpoint ?? `${runtime.baseUrl}/models`;
    let metadataOrigin = new URL(endpoint).origin;
    try {
      metadataOrigin = getRelayManagementConfig(this.provider).baseUrl || metadataOrigin;
    } catch {
      /* Inference remains independent from invalid management credentials. */
    }
    const [authorized, pricing] = await Promise.all([
      relayGet({
        provider: this.provider,
        url: endpoint,
        headers: { Authorization: `Bearer ${apiKey}` },
        operation: 'provider.models',
        timeoutMs: this.options.timeoutMs ?? 8_000,
        attempts: 1,
        fetchImpl: this.options.fetchImpl,
      }),
      // Metadata is optional. Failure cannot manufacture models or prices.
      relayGet({
        provider: this.provider,
        url: `${metadataOrigin}/api/pricing`,
        headers: {},
        operation: 'provider.models',
        timeoutMs: this.options.timeoutMs ?? 8_000,
        attempts: 1,
        fetchImpl: this.options.fetchImpl,
      }).catch(() => null),
    ]);
    const now = this.options.now ?? Date.now;
    const directory = ProviderModelDirectorySchema.parse({
      provider: this.provider,
      models: mapRelayModels(this.provider, authorized, pricing),
      fetched_at: new Date(now()).toISOString(),
      stale: false,
    });
    this.cached = directory;
    this.cachedAt = now();
    return directory;
  }
}
