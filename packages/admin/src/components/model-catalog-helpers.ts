import { arrayMove } from '@dnd-kit/sortable';
import {
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  type LlmModelProvider,
  type ModelCatalog,
  type ModelCatalogModel,
  type ModelCatalogTierKey,
  type OpenRouterModelSummary,
  type ProviderModelDirectory,
  type ProviderModelSummary,
} from '@miniapp/shared';
export const tierOptions: Array<{ value: ModelCatalogTierKey; label: string; color: string }> = [
  { value: 'light', label: 'Light', color: '#4ade80' },
  { value: 'standard', label: 'Standard', color: '#818cf8' },
  { value: 'premium', label: 'Premium', color: '#c084fc' },
];

export type ProviderDirectoryMap = Partial<Record<LlmModelProvider, ProviderModelDirectory>>;

export function selectedCatalogAssignments(catalog: ModelCatalog): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  for (const tier of catalog.tiers) {
    for (const model of tier.models) {
      const providerModelId = modelProviderId(model).trim();
      if (!providerModelId) continue;
      const key = providerModelKey(modelProvider(model), providerModelId);
      assignments.set(key, [...(assignments.get(key) ?? []), model.id]);
    }
  }
  return assignments;
}
type ProviderFlagMap = Partial<Record<LlmModelProvider, boolean>>;
type ProviderErrorMap = Partial<Record<LlmModelProvider, string | null>>;

export function formatUsdPerMillion(value: number | null): string {
  if (value === null) return 'unknown';
  return `$${(value * 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function filterOpenRouterModels(
  models: readonly OpenRouterModelSummary[],
  searchTerm: string
): OpenRouterModelSummary[] {
  const normalizedTerm = searchTerm.trim().toLocaleLowerCase();
  if (!normalizedTerm) return [...models];
  return models.filter((model) =>
    [model.name, model.id, model.canonical_slug, model.description]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(normalizedTerm))
  );
}

export function filterProviderModels(
  models: readonly ProviderModelSummary[],
  searchTerm: string
): ProviderModelSummary[] {
  const normalizedTerm = searchTerm.trim().toLocaleLowerCase();
  if (!normalizedTerm) return [...models];
  return models.filter((model) =>
    [model.name, model.id, model.description, model.raw_status_label]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(normalizedTerm))
  );
}

export interface DuplicateOpenRouterAssignment {
  stableId: string;
  displayName: string;
  tier: ModelCatalogTierKey;
  provider: LlmModelProvider;
  providerModelId: string;
}

export function providerModelKey(provider: LlmModelProvider, providerModelId: string): string {
  return `${provider}:${providerModelId}`;
}

export function modelProvider(model: ModelCatalogModel): LlmModelProvider {
  return model.provider ?? 'openrouter';
}

export function modelProviderId(model: ModelCatalogModel): string {
  return model.provider_model_id || model.openrouter_model_id;
}

export function findDuplicateOpenRouterAssignments(
  catalog: ModelCatalog
): Record<string, DuplicateOpenRouterAssignment[]> {
  const assignments = new Map<string, DuplicateOpenRouterAssignment[]>();
  for (const tier of catalog.tiers) {
    for (const model of tier.models) {
      const provider = modelProvider(model);
      const providerModelId = modelProviderId(model).trim();
      if (!providerModelId) continue;
      const key = providerModelKey(provider, providerModelId);
      const current = assignments.get(key) ?? [];
      current.push({
        stableId: model.id,
        displayName: model.display_name,
        tier: tier.tier,
        provider,
        providerModelId,
      });
      assignments.set(key, current);
    }
  }
  return Object.fromEntries([...assignments.entries()].filter(([, models]) => models.length > 1));
}

export function copyCatalog(value: ModelCatalog): ModelCatalog {
  return structuredClone(value);
}

function newModel(index: number, timestamp = Date.now()): ModelCatalogModel {
  return {
    id: `model-${timestamp}-${index}`,
    provider: 'openrouter',
    provider_model_id: '',
    openrouter_model_id: '',
    display_name: 'New Model',
    tagline: '',
    first_token_timeout_ms: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
    enabled: true,
    sort_order: index + 1,
  };
}

export function appendDraftModel(
  catalog: ModelCatalog,
  tierIndex: number,
  timestamp = Date.now()
): ModelCatalog {
  const next = copyCatalog(catalog);
  const models = next.tiers[tierIndex]?.models;
  if (!models) return catalog;
  const model = newModel(models.length, timestamp);
  models.push(model);
  if (!next.default_model_id) next.default_model_id = model.id;
  return next;
}

export function appendDraftTier(catalog: ModelCatalog): ModelCatalog {
  const used = new Set(catalog.tiers.map((tier) => tier.tier));
  const option = tierOptions.find((item) => !used.has(item.value));
  if (!option) return catalog;
  return {
    ...catalog,
    tiers: [
      ...catalog.tiers,
      {
        tier: option.value,
        label: option.label,
        color: option.color,
        cost_hint: '',
        sort_order: catalog.tiers.length,
        models: [],
      },
    ],
  };
}

export function mergeModelUpdate(
  current: ModelCatalogModel,
  patch: Partial<ModelCatalogModel>
): ModelCatalogModel {
  return { ...current, ...patch };
}

export function normalizeCatalogSortOrder(catalog: ModelCatalog): ModelCatalog {
  return {
    ...catalog,
    tiers: catalog.tiers.map((tier, tierIndex) => ({
      ...tier,
      sort_order: tierIndex,
      models: tier.models.map((model, modelIndex) => ({
        ...model,
        sort_order: modelIndex,
      })),
    })),
  };
}

export function reorderCatalog(
  catalog: ModelCatalog,
  activeId: string,
  overId: string
): ModelCatalog {
  if (!overId || activeId === overId) return catalog;
  const next = copyCatalog(catalog);

  if (activeId.startsWith('tier:') && overId.startsWith('tier:')) {
    const oldIndex = next.tiers.findIndex((tier) => tier.tier === activeId.slice(5));
    const newIndex = next.tiers.findIndex((tier) => tier.tier === overId.slice(5));
    if (oldIndex < 0 || newIndex < 0) return catalog;
    next.tiers = arrayMove(next.tiers, oldIndex, newIndex);
    return normalizeCatalogSortOrder(next);
  }

  if (activeId.startsWith('model:') && overId.startsWith('model:')) {
    const activeModelId = activeId.slice(6);
    const overModelId = overId.slice(6);
    const sourceTier = next.tiers.find((tier) =>
      tier.models.some((model) => model.id === activeModelId)
    );
    const targetTier = next.tiers.find((tier) =>
      tier.models.some((model) => model.id === overModelId)
    );
    if (!sourceTier || !targetTier || sourceTier.tier !== targetTier.tier) return catalog;
    const sourceIndex = sourceTier.models.findIndex((model) => model.id === activeModelId);
    const targetIndex = targetTier.models.findIndex((model) => model.id === overModelId);
    const [moved] = sourceTier.models.splice(sourceIndex, 1);
    if (!moved) return catalog;
    targetTier.models.splice(targetIndex, 0, moved);
    return normalizeCatalogSortOrder(next);
  }

  return catalog;
}
