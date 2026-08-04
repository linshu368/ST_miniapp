import {
  ModelCatalogSchema,
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  resolveRuntimeCatalogModel,
} from '@miniapp/shared';

interface LegacyTier {
  modelName?: unknown;
  isDefault?: unknown;
}

export interface ProvisionModelResolution {
  modelId: string | null;
  openrouterModelId: string | null;
  strictCatalogInvalid: boolean;
}

export function resolveProvisionModel(input: {
  catalog: unknown;
  selectedModelId?: string | null;
  legacyTiers: unknown;
}): ProvisionModelResolution {
  const strictCatalog = ModelCatalogSchema.safeParse(input.catalog);
  const strictCatalogInvalid = input.catalog !== null && input.catalog !== undefined;
  if (strictCatalog.success) {
    const selectedId = resolveEffectiveSelectedModelId(strictCatalog.data, input.selectedModelId);
    return {
      modelId: selectedId,
      openrouterModelId: resolveEnabledCatalogModel(strictCatalog.data, selectedId)
        .openrouter_model_id,
      strictCatalogInvalid: false,
    };
  }

  const compatibleSelection = resolveRuntimeCatalogModel(
    input.catalog,
    input.selectedModelId,
    false
  );
  if (compatibleSelection) {
    return {
      modelId: compatibleSelection.id,
      openrouterModelId: compatibleSelection.openrouter_model_id,
      strictCatalogInvalid,
    };
  }

  if (Array.isArray(input.legacyTiers)) {
    const legacyDefault = (input.legacyTiers as LegacyTier[]).find(
      (tier) => tier.isDefault === true && typeof tier.modelName === 'string'
    );
    if (typeof legacyDefault?.modelName === 'string') {
      return {
        modelId: null,
        openrouterModelId: legacyDefault.modelName,
        strictCatalogInvalid,
      };
    }
  }

  const compatibleDefault = resolveRuntimeCatalogModel(input.catalog, null, true);
  return {
    modelId: compatibleDefault?.id ?? null,
    openrouterModelId: compatibleDefault?.openrouter_model_id ?? null,
    strictCatalogInvalid,
  };
}
