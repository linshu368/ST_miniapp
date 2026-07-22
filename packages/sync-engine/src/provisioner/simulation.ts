import { schemaClient } from '../lib/supabase.js';
import { config } from '../lib/config.js';
import { mergeSettings } from './merger.js';
import { resolveProvisionModel } from './model-resolution.js';
import { ensureStUser } from './st-user.js';
import {
  writeCharacterById,
  writePresets,
  writeSettings,
  writeSimulationSecrets,
} from './writer.js';
import type { ApiConfigRow, PlatformSettingsRow, PresetRow } from './fetcher.js';

interface SimulationCharacterRow {
  id: string;
  name: string;
  card_hash: string;
  is_test: boolean;
  enabled: boolean;
}

interface SimulationPresetRow extends PresetRow {
  updated_at?: string;
}

export interface SimulationProvisionInput {
  conversationId: string;
  stHandle: string;
  characterId: string;
  requestedModelId?: string | null;
  requestedPresetId?: string | null;
  force?: boolean;
}

export interface SimulationProvisionResult {
  characterName: string;
  cardHash: string;
  effectiveModelId: string;
  effectiveOpenRouterModel: string;
  presetId: string | null;
  presetVersion: string | null;
  stUserCreated: boolean;
}

export async function provisionSimulationConversation(
  input: SimulationProvisionInput
): Promise<SimulationProvisionResult> {
  const [
    characterResult,
    presetsResult,
    platformSettingsResult,
    apiConfigResult,
    fallbackConfigResult,
    llmCatalogResult,
    llmModelTiersResult,
  ] = await Promise.all([
    schemaClient('miniapp')
      .from('characters')
      .select('id,name,card_hash,is_test,enabled')
      .eq('id', input.characterId)
      .single(),
    schemaClient('st_platform')
      .from('platform_presets')
      .select('id,display_name,preset_payload,is_default,updated_at')
      .eq('enabled', true)
      .order('sort_order', { ascending: true }),
    schemaClient('st_platform')
      .from('platform_settings')
      .select('platform_version,settings_jsonb,writable_paths')
      .order('platform_version', { ascending: false })
      .limit(1)
      .single(),
    schemaClient('st_platform')
      .from('platform_api_configs')
      .select('id,config_payload,is_default')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle(),
    schemaClient('miniapp')
      .from('runtime_config')
      .select('value')
      .eq('key', 'system_fallback_character_id')
      .maybeSingle(),
    schemaClient('miniapp')
      .from('runtime_config')
      .select('value')
      .eq('key', 'llm_model_catalog')
      .maybeSingle(),
    schemaClient('miniapp')
      .from('runtime_config')
      .select('value')
      .eq('key', 'llm_model_tiers')
      .maybeSingle(),
  ]);

  if (characterResult.error || !characterResult.data) {
    throw new Error(`simulation character not found: ${input.characterId}`);
  }
  const character = characterResult.data as SimulationCharacterRow;
  if (!character.is_test || character.enabled || !character.card_hash) {
    throw new Error('simulation endpoint only accepts disabled test cards with card_hash');
  }
  if (presetsResult.error || !presetsResult.data) {
    throw new Error(`failed to load platform presets: ${presetsResult.error?.message}`);
  }
  if (platformSettingsResult.error || !platformSettingsResult.data) {
    throw new Error(`failed to load platform settings: ${platformSettingsResult.error?.message}`);
  }

  const presets = presetsResult.data as SimulationPresetRow[];
  const requestedPreset = input.requestedPresetId
    ? presets.find((preset) => preset.id === input.requestedPresetId)
    : null;
  if (input.requestedPresetId && !requestedPreset) {
    throw new Error(`enabled preset not found: ${input.requestedPresetId}`);
  }

  const platformSettings = structuredClone(platformSettingsResult.data as PlatformSettingsRow);
  if (requestedPreset) {
    const root = platformSettings.settings_jsonb;
    const oai =
      root.oai_settings && typeof root.oai_settings === 'object'
        ? (root.oai_settings as Record<string, unknown>)
        : {};
    root.oai_settings = oai;
    oai.preset_settings_openai = `platform_${requestedPreset.id}`;
  }

  const catalog = (llmCatalogResult.data as { value?: unknown } | null)?.value;
  const modelResolution = resolveProvisionModel({
    catalog,
    selectedModelId: input.requestedModelId,
    legacyTiers: (llmModelTiersResult.data as { value?: unknown } | null)?.value,
  });
  if (!modelResolution.openrouterModelId) {
    throw new Error('no enabled model is available for simulation');
  }

  const catalogValue = catalog as
    | {
        default_model_id?: string;
        tiers?: Array<{ models?: Array<{ id?: string; openrouter_model_id?: string }> }>;
      }
    | undefined;
  const flatModels = catalogValue?.tiers?.flatMap((tier) => tier.models ?? []) ?? [];
  const effectiveCatalogModel = flatModels.find(
    (model) => model.openrouter_model_id === modelResolution.openrouterModelId
  );
  const effectiveModelId =
    effectiveCatalogModel?.id ??
    input.requestedModelId ??
    catalogValue?.default_model_id ??
    modelResolution.openrouterModelId;

  const stUser = await ensureStUser({
    handle: input.stHandle,
    displayName: input.stHandle,
  });
  const characterStatus = await writeCharacterById(
    input.stHandle,
    input.characterId,
    input.force ?? false
  );
  if (characterStatus === 'missing') {
    throw new Error(`character PNG missing from storage: ${input.characterId}`);
  }

  writePresets(input.stHandle, presets, input.force ?? false);
  const merged = mergeSettings(
    platformSettings,
    null,
    presets,
    [input.characterId],
    (fallbackConfigResult.data as { value?: string } | null)?.value,
    config.LLM_PROXY_URL,
    { name: 'Simulation User', avatarFile: null },
    modelResolution.openrouterModelId
  );
  writeSettings(input.stHandle, merged);
  writeSimulationSecrets(
    input.stHandle,
    (apiConfigResult.data as ApiConfigRow | null) ?? null,
    input.conversationId
  );

  const appliedPreset =
    presets.find((preset) => preset.id === merged.appliedPresetId) ?? requestedPreset;

  return {
    characterName: character.name,
    cardHash: character.card_hash,
    effectiveModelId,
    effectiveOpenRouterModel: modelResolution.openrouterModelId,
    presetId: appliedPreset?.id ?? null,
    presetVersion: appliedPreset?.updated_at ?? null,
    stUserCreated: stUser.created,
  };
}
