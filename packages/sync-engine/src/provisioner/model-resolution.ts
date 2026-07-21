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
        openrouterModelId: legacyDefault.modelName,
        strictCatalogInvalid,
      };
    }
  }

  return {
    openrouterModelId:
      resolveRuntimeCatalogModel(input.catalog, null, true)?.openrouter_model_id ?? null,
    strictCatalogInvalid,
  };
}
