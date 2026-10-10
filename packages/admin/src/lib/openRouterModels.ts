import {
  LLM_MODEL_PROVIDER_LABELS,
  LLM_PROVIDER_CAPABILITIES,
  LlmModelProviderSchema,
  OpenRouterModelDirectorySchema,
  ProviderModelDirectorySchema,
  type LlmModelProvider,
  type ModelCatalog,
  type OpenRouterModelDirectory,
  type ProviderModelDirectory,
} from '@miniapp/shared';
import type { AdminEnvironment } from './environment';
import { getAdminApiUrl } from './environment';

export type ProviderDirectoryMap = Partial<Record<LlmModelProvider, ProviderModelDirectory>>;

async function parseEnvelope(response: Response, fallbackMessage: string): Promise<unknown> {
  const envelope = (await response.json()) as {
    success?: boolean;
    data?: unknown;
    error?: { message?: string };
  };
  if (!envelope.success) throw new Error(envelope.error?.message || fallbackMessage);
  return envelope.data;
}

export async function fetchModelProviderDirectory(
  environment: AdminEnvironment,
  provider: LlmModelProvider,
  forceRefresh = false
): Promise<ProviderModelDirectory> {
  const parsedProvider = LlmModelProviderSchema.parse(provider);
  const label = LLM_MODEL_PROVIDER_LABELS[parsedProvider];
  const query = forceRefresh ? `?refresh=1&t=${Date.now()}` : '';
  const response = await fetch(
    `${getAdminApiUrl(environment)}/api/platform/model-providers/${parsedProvider}/models${query}`,
    {
      headers: { Accept: 'application/json' },
      cache: forceRefresh ? 'no-store' : 'default',
    }
  );
  if (!response.ok) {
    throw new Error(`${label} model directory failed to load (HTTP ${response.status})`);
  }
  return ProviderModelDirectorySchema.parse(
    await parseEnvelope(response, `${label} model directory failed to load`)
  );
}

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
    throw new Error(`OpenRouter model directory failed to load (HTTP ${response.status})`);
  }
  return OpenRouterModelDirectorySchema.parse(
    await parseEnvelope(response, 'OpenRouter model directory failed to load')
  );
}

export function getCatalogProviderIssues(
  catalog: ModelCatalog,
  directories: ProviderDirectoryMap
): string[] {
  const issues: string[] = [];

  for (const model of catalog.tiers.flatMap((tier) => tier.models)) {
    const provider = model.provider ?? 'openrouter';
    const providerModelId = model.provider_model_id || model.openrouter_model_id;
    const directory = directories[provider];
    const label = LLM_PROVIDER_CAPABILITIES[provider].label;
    if (!directory) {
      issues.push(`${model.display_name || model.id}: ${label} directory is not synced`);
      continue;
    }

    const upstreamModel = directory.models.find((candidate) => candidate.id === providerModelId);
    if (!upstreamModel) {
      issues.push(`${model.display_name || model.id}: ${label} model ID does not exist`);
      continue;
    }

    if (upstreamModel.status === 'expired') {
      issues.push(`${model.display_name || model.id}: ${label} model is expired`);
    }
    if (upstreamModel.status === 'unavailable') {
      issues.push(`${model.display_name || model.id}: ${label} model is unavailable`);
    }
  }

  return issues;
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
      issues.push(`${model.display_name || model.id}: OpenRouter ID does not exist`);
      continue;
    }

    if (
      upstreamModel.expiration_date &&
      Number.isFinite(Date.parse(upstreamModel.expiration_date)) &&
      Date.parse(upstreamModel.expiration_date) <= now
    ) {
      issues.push(`${model.display_name || model.id}: OpenRouter model is expired`);
    }
  }

  return issues;
}
