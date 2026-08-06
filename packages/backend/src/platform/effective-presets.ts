import {
  EffectivePresetSummarySchema,
  toSafePresetPayload,
  type EffectivePresetSummary,
} from '@miniapp/shared';
import { getSupabaseClient } from '../lib/supabase.js';

interface EffectivePresetRpcRow {
  assignment_version: number | string;
  effective_preset_id: string | null;
  effective_preset_pointer: string | null;
  preset_payload: unknown;
  preset_source: 'model' | 'default' | null;
  config_code: 'OK' | 'ASSIGNMENT_INVALID_FALLBACK' | 'NO_ENABLED_DEFAULT';
  degraded: boolean;
}

export interface ResolvedEffectivePreset {
  summary: EffectivePresetSummary;
  presetPayload: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function resolveEffectivePresetForModel(
  modelId: string,
  includePayload = false
): Promise<ResolvedEffectivePreset> {
  const { data, error } = await getSupabaseClient()
    .schema('st_platform' as 'public')
    .rpc('resolve_effective_preset_for_model', {
      p_model_id: modelId,
      p_include_payload: includePayload,
    });

  if (error) {
    throw new Error(`failed to resolve effective preset: ${error.message}`);
  }

  const row = (data as unknown as EffectivePresetRpcRow[] | null)?.[0];
  if (!row) {
    throw new Error('effective preset resolver returned no state row');
  }

  const summary = EffectivePresetSummarySchema.parse({
    effective_preset_id: row.effective_preset_id,
    effective_preset_pointer: row.effective_preset_pointer,
    preset_assignments_version: Number(row.assignment_version),
    preset_source: row.preset_source,
    preset_config_code: row.config_code,
    preset_degraded: row.degraded,
  });

  if (!includePayload || summary.effective_preset_id === null) {
    return { summary, presetPayload: null };
  }
  if (!isRecord(row.preset_payload)) {
    throw new Error(`effective preset ${summary.effective_preset_id} has an invalid payload`);
  }

  const safePayload = toSafePresetPayload(row.preset_payload);
  if (Object.keys(safePayload).length === 0) {
    throw new Error(`effective preset ${summary.effective_preset_id} has no applicable fields`);
  }

  return { summary, presetPayload: safePayload };
}
