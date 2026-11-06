import {
  LLM_PROVIDER_CAPABILITIES,
  LlmModelProviderSchema,
  ProviderModelDirectorySchema,
  type LlmModelProvider,
  type OpenRouterModelDirectory,
  type ProviderModelDirectory,
  type ProviderModelSummary,
} from '@miniapp/shared';
import { OpenRouterModelsClient, openRouterModelsClient } from './openrouter-models.js';
import { getLlmProviderRuntimeConfig } from './runtime-config.js';
import { veniceFetch } from './venice-http.js';

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface ProviderDirectoryClientOptions {
  endpoint?: string;
  apiKey?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface VeniceModelRecord {
  id: string;
  type?: string;
  status?: string | null;
  model_spec?: {
    name?: string;
    description?: string | null;
    availableContextTokens?: number | null;
    pricing?: {
      input?: { usd?: string | number };
      output?: { usd?: string | number };
    };
  };
}

interface SurplusModelRecord {
  id: string;
  name?: string;
  description?: string | null;
  contextLength?: number | null;
  promptPrice: number;
  completionPrice: number;
  supportsChatText: boolean;
  status?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readText(value);
}

function readNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readUsdPrice(value: unknown): number | null {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function readRequiredUsdPrice(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  return readUsdPrice(value);
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(readText);
  return values.every((item): item is string => item !== undefined) ? values : null;
}

function parseVeniceModelsResponse(value: unknown): VeniceModelRecord[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Venice models response is not a data array');
  }

  return value.data.flatMap<VeniceModelRecord>((item) => {
    if (!isRecord(item)) return [];
    const id = readText(item.id);
    if (!id) return [];
    const modelSpec = isRecord(item.model_spec) ? item.model_spec : null;
    const pricing = modelSpec && isRecord(modelSpec.pricing) ? modelSpec.pricing : null;
    const input = pricing && isRecord(pricing.input) ? pricing.input : null;
    const output = pricing && isRecord(pricing.output) ? pricing.output : null;
    return [
      {
        id,
        type: readText(item.type),
        status: readNullableText(item.status),
        model_spec: modelSpec
          ? {
              name: readText(modelSpec.name),
              description: readNullableText(modelSpec.description),
              availableContextTokens: readNonNegativeInteger(modelSpec.availableContextTokens),
              pricing: {
                input: input ? { usd: input.usd as string | number | undefined } : undefined,
                output: output ? { usd: output.usd as string | number | undefined } : undefined,
              },
            }
          : undefined,
      },
    ];
  });
}

function parseSurplusModelsResponse(value: unknown): SurplusModelRecord[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Surplus models response is not a data array');
  }

  return value.data.flatMap<SurplusModelRecord>((item) => {
    if (!isRecord(item)) return [];
    const id = readText(item.id);
    const pricing = isRecord(item.pricing) ? item.pricing : null;
    const architecture = isRecord(item.architecture) ? item.architecture : null;
    const inputModalities = readStringArray(architecture?.input_modalities);
    const outputModalities = readStringArray(architecture?.output_modalities);
    const promptPrice = readRequiredUsdPrice(pricing?.prompt);
    const completionPrice = readRequiredUsdPrice(pricing?.completion);
    if (
      !id ||
      promptPrice === null ||
      completionPrice === null ||
      !inputModalities ||
      !outputModalities
    )
      return [];
    return [
      {
        id,
        name: readText(item.name),
        description: readNullableText(item.description),
        contextLength: readNonNegativeInteger(item.context_length),
        promptPrice,
        completionPrice,
        supportsChatText: inputModalities.includes('text') && outputModalities.includes('text'),
        status: readNullableText(item.status),
      },
    ];
  });
}

function mapOpenRouterDirectory(directory: OpenRouterModelDirectory): ProviderModelDirectory {
  return ProviderModelDirectorySchema.parse({
    provider: 'openrouter',
    models: directory.models.map<ProviderModelSummary>((model) => ({
      provider: 'openrouter',
      id: model.id,
      name: model.name,
      description: model.description,
      context_length: model.context_length,
      prompt_usd_per_token: model.prompt_usd_per_token,
      completion_usd_per_token: model.completion_usd_per_token,
      status: model.expiration_date ? 'expired' : 'available',
      raw_status_label: model.expiration_date ? `expires ${model.expiration_date}` : null,
    })),
    fetched_at: directory.fetched_at,
    stale: directory.stale,
  });
}

export class OpenRouterProviderDirectoryClient {
  constructor(private readonly client: OpenRouterModelsClient = openRouterModelsClient) {}

  async getModels(options: { forceRefresh?: boolean } = {}): Promise<ProviderModelDirectory> {
    return mapOpenRouterDirectory(await this.client.getModels(options));
  }
}

export class VeniceProviderDirectoryClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: ProviderModelDirectory | null = null;
  private cachedAt = 0;
  private inFlight: Promise<ProviderModelDirectory> | null = null;

  constructor(options: ProviderDirectoryClientOptions = {}) {
    const runtime = getLlmProviderRuntimeConfig('venice');
    const upstreamBaseUrl = runtime.baseUrl.replace(/\/+$/, '');
    this.endpoint =
      options.endpoint ??
      `${upstreamBaseUrl}${LLM_PROVIDER_CAPABILITIES.venice.modelsPath}?type=text`;
    this.apiKey = options.apiKey ?? runtime.apiKey;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? veniceFetch;
    this.now = options.now ?? Date.now;
  }

  async getModels(options: { forceRefresh?: boolean } = {}): Promise<ProviderModelDirectory> {
    if (!options.forceRefresh && this.cached && this.now() - this.cachedAt < this.cacheTtlMs) {
      return this.cached;
    }

    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }

    try {
      return await this.inFlight;
    } catch (error) {
      if (this.cached) return { ...this.cached, stale: true };
      throw error;
    }
  }

  private async refresh(): Promise<ProviderModelDirectory> {
    if (!this.apiKey) throw new Error('VENICE_API_KEY is required to sync Venice models');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Venice models request failed with HTTP ${response.status}`);
      }

      const raw = parseVeniceModelsResponse(await response.json());
      const models = raw
        .filter((model) => model.type === undefined || model.type === 'text')
        .flatMap<ProviderModelSummary>((model) => {
          const promptPrice = readUsdPrice(model.model_spec?.pricing?.input?.usd);
          const completionPrice = readUsdPrice(model.model_spec?.pricing?.output?.usd);
          if (promptPrice === null || completionPrice === null) return [];

          const statusLabel = model.status?.trim() || null;
          const status = statusLabel?.toLowerCase() === 'offline' ? 'unavailable' : 'available';
          return [
            {
              provider: 'venice',
              id: model.id,
              name: model.model_spec?.name ?? model.id,
              description: model.model_spec?.description ?? null,
              context_length: model.model_spec?.availableContextTokens ?? null,
              prompt_usd_per_token: promptPrice,
              completion_usd_per_token: completionPrice,
              status,
              raw_status_label: statusLabel,
            },
          ];
        })
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        );

      if (models.length === 0) throw new Error('Venice returned no valid text models');

      const directory = ProviderModelDirectorySchema.parse({
        provider: 'venice',
        models,
        fetched_at: new Date(this.now()).toISOString(),
        stale: false,
      });
      this.cached = directory;
      this.cachedAt = this.now();
      return directory;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class SurplusProviderDirectoryClient {
  private readonly endpoint: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: ProviderModelDirectory | null = null;
  private cachedAt = 0;
  private inFlight: Promise<ProviderModelDirectory> | null = null;

  constructor(options: Omit<ProviderDirectoryClientOptions, 'apiKey'> = {}) {
    const runtime = getLlmProviderRuntimeConfig('surplus');
    const upstreamBaseUrl = runtime.baseUrl.replace(/\/+$/, '');
    this.endpoint =
      options.endpoint ?? `${upstreamBaseUrl}${LLM_PROVIDER_CAPABILITIES.surplus.modelsPath}`;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getModels(options: { forceRefresh?: boolean } = {}): Promise<ProviderModelDirectory> {
    if (!options.forceRefresh && this.cached && this.now() - this.cachedAt < this.cacheTtlMs) {
      return this.cached;
    }

    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }

    try {
      return await this.inFlight;
    } catch (error) {
      if (this.cached) return { ...this.cached, stale: true };
      throw error;
    }
  }

  private async refresh(): Promise<ProviderModelDirectory> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Surplus models request failed with HTTP ${response.status}`);
      }

      const models = parseSurplusModelsResponse(await response.json())
        .filter((model) => model.supportsChatText)
        .map<ProviderModelSummary>((model) => {
          const statusLabel = model.status?.trim() || null;
          const unavailable =
            statusLabel !== null &&
            ['offline', 'unavailable', 'paused', 'delisted'].includes(statusLabel.toLowerCase());
          return {
            provider: 'surplus',
            id: model.id,
            name: model.name ?? model.id,
            description: model.description ?? null,
            context_length: model.contextLength ?? null,
            prompt_usd_per_token: model.promptPrice,
            completion_usd_per_token: model.completionPrice,
            status: unavailable ? 'unavailable' : 'available',
            raw_status_label: statusLabel,
          };
        })
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        );

      if (models.length === 0)
        throw new Error('Surplus Intelligence returned no valid text models');

      const directory = ProviderModelDirectorySchema.parse({
        provider: 'surplus',
        models,
        fetched_at: new Date(this.now()).toISOString(),
        stale: false,
      });
      this.cached = directory;
      this.cachedAt = this.now();
      return directory;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const providerDirectoryClients: Record<
  LlmModelProvider,
  { getModels(options?: { forceRefresh?: boolean }): Promise<ProviderModelDirectory> }
> = {
  openrouter: new OpenRouterProviderDirectoryClient(),
  venice: new VeniceProviderDirectoryClient(),
  surplus: new SurplusProviderDirectoryClient(),
};

export async function getProviderModelDirectory(
  provider: LlmModelProvider,
  options: { forceRefresh?: boolean } = {}
): Promise<ProviderModelDirectory> {
  const parsedProvider = LlmModelProviderSchema.parse(provider);
  return providerDirectoryClients[parsedProvider].getModels(options);
}
