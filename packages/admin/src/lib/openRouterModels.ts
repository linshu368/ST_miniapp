import {
  OpenRouterModelDirectorySchema,
  calculateDisplayPrice,
  type DisplayPricingConfig,
  type ModelCatalog,
  type OpenRouterModelDirectory,
  type OpenRouterModelSummary,
} from '@miniapp/shared';
import type { AdminEnvironment } from './environment';
import { getAdminApiUrl } from './environment';

export async function fetchOpenRouterModels(
  environment: AdminEnvironment,
  forceRefresh = false
): Promise<OpenRouterModelDirectory> {
  const query = forceRefresh ? `?refresh=1&t=${Date.now()}` : '';
  const response = await fetch(
    `${getAdminApiUrl(environment)}/api/platform/openrouter/models${query}`,
    {
      headers: { Accept: 'application/json' },
      cache: forceRefresh ? 'no-store' : 'default',
    }
  );
  if (!response.ok) {
    throw new Error(`OpenRouter 模型目录加载失败（HTTP ${response.status}）`);
  }

  const envelope = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: { message?: string };
  };
  if (!envelope.success) {
    throw new Error(envelope.error?.message || 'OpenRouter 模型目录加载失败');
  }
  return OpenRouterModelDirectorySchema.parse(envelope.data);
}

export function calculateModelDisplayPrices(
  model: OpenRouterModelSummary,
  pricing: DisplayPricingConfig
): { price_input: number; price_output: number } {
  return {
    price_input: calculateDisplayPrice(model.prompt_usd_per_token, pricing),
    price_output: calculateDisplayPrice(model.completion_usd_per_token, pricing),
  };
}

export function getOpenRouterCatalogIssues(
  catalog: ModelCatalog,
  directory: OpenRouterModelDirectory,
  now = Date.now()
): string[] {
  const upstream = new Map(directory.models.map((model) => [model.id, model]));
  const issues: string[] = [];

  for (const model of catalog.tiers.flatMap((tier) => tier.models)) {
    const upstreamModel = upstream.get(model.openrouter_model_id);
    if (!upstreamModel) {
      issues.push(`${model.display_name || model.id}：OpenRouter ID 不存在`);
      continue;
    }

    if (
      upstreamModel.expiration_date &&
      Number.isFinite(Date.parse(upstreamModel.expiration_date)) &&
      Date.parse(upstreamModel.expiration_date) <= now
    ) {
      issues.push(`${model.display_name || model.id}：OpenRouter 模型已过期`);
    }
  }

  return issues;
}
