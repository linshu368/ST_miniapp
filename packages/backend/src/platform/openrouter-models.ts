import {
  OpenRouterModelDirectorySchema,
  OpenRouterModelsResponseSchema,
  type OpenRouterModelDirectory,
  type OpenRouterModelSummary,
} from '@miniapp/shared';

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface OpenRouterModelsClientOptions {
  endpoint?: string;
  apiKey?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class OpenRouterModelsClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: OpenRouterModelDirectory | null = null;
  private cachedAt = 0;
  private inFlight: Promise<OpenRouterModelDirectory> | null = null;

  constructor(options: OpenRouterModelsClientOptions = {}) {
    this.endpoint = options.endpoint ?? 'https://openrouter.ai/api/v1/models';
    this.apiKey = options.apiKey ?? '';
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getModels(): Promise<OpenRouterModelDirectory> {
    if (this.cached && this.now() - this.cachedAt < this.cacheTtlMs) {
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

  private async refresh(): Promise<OpenRouterModelDirectory> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(this.endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OpenRouter models request failed with HTTP ${response.status}`);
      }

      const raw = OpenRouterModelsResponseSchema.parse(await response.json());
      const models = raw.data
        .flatMap<OpenRouterModelSummary>((model) => {
          const promptPrice = Number(model.pricing.prompt);
          const completionPrice = Number(model.pricing.completion);
          if (
            !Number.isFinite(promptPrice) ||
            promptPrice < 0 ||
            !Number.isFinite(completionPrice) ||
            completionPrice < 0
          ) {
            return [];
          }

          return [
            {
              id: model.id,
              canonical_slug: model.canonical_slug ?? null,
              name: model.name,
              description: model.description ?? null,
              context_length: model.context_length ?? null,
              prompt_usd_per_token: promptPrice,
              completion_usd_per_token: completionPrice,
              expiration_date: model.expiration_date ?? null,
            },
          ];
        })
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        );

      if (models.length === 0) throw new Error('OpenRouter returned no valid models');

      const directory = OpenRouterModelDirectorySchema.parse({
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

const upstreamBaseUrl = (process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1').replace(
  /\/+$/,
  ''
);

export const openRouterModelsClient = new OpenRouterModelsClient({
  endpoint: `${upstreamBaseUrl}/models`,
  apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
});
