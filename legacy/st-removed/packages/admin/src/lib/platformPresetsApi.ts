import type { SupabaseClient } from '@supabase/supabase-js';

export interface PlatformPreset {
  id: string;
  display_name: string;
  preset_payload: Record<string, unknown>;
  is_default: boolean;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlatformPresetVersion {
  platform_version: number;
  preset_id: string | null;
  preset_pointer: string;
  preset_display_name: string | null;
  created_by: string;
  note: string | null;
  created_at: string;
}

export interface PlatformPresetModelAssignment {
  model_id: string;
  display_name: string;
  sort_order: number;
  preset_id: string | null;
  assigned_preset_display_name: string | null;
  effective_preset_id: string | null;
  effective_preset_display_name: string | null;
  preset_source: 'model' | 'default' | null;
  preset_config_code: 'OK' | 'ASSIGNMENT_INVALID_FALLBACK' | 'NO_ENABLED_DEFAULT';
  assignment_updated_at: string | null;
  assignment_version: number;
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('平台预设接口没有返回数据');
  return data;
}

export async function listPlatformPresets(client: SupabaseClient): Promise<PlatformPreset[]> {
  const { data, error } = await client.schema('admin').rpc('list_platform_presets');
  return unwrap((data ?? []) as PlatformPreset[], error);
}

export async function listPlatformPresetVersions(
  client: SupabaseClient,
  limit = 30
): Promise<PlatformPresetVersion[]> {
  const { data, error } = await client
    .schema('admin')
    .rpc('list_platform_preset_versions', { p_limit: limit });
  return unwrap((data ?? []) as PlatformPresetVersion[], error);
}

export async function listPlatformPresetModelAssignments(
  client: SupabaseClient
): Promise<PlatformPresetModelAssignment[]> {
  const { data, error } = await client
    .schema('admin')
    .rpc('list_platform_preset_model_assignments');
  return unwrap((data ?? []) as PlatformPresetModelAssignment[], error);
}

export async function updatePlatformPresetModelAssignments(input: {
  client: SupabaseClient;
  presetId: string;
  modelIds: string[];
  expectedVersion: number;
}): Promise<number> {
  const { data, error } = await input.client
    .schema('admin')
    .rpc('update_platform_preset_model_assignments', {
      p_preset_id: input.presetId,
      p_model_ids: input.modelIds,
      p_expected_version: input.expectedVersion,
    });
  return unwrap(data as number | null, error);
}

export async function updatePlatformPresetModelAssignment(input: {
  client: SupabaseClient;
  modelId: string;
  presetId: string | null;
  expectedVersion: number;
}): Promise<number> {
  const { data, error } = await input.client
    .schema('admin')
    .rpc('update_platform_preset_model_assignment', {
      p_model_id: input.modelId,
      p_preset_id: input.presetId,
      p_expected_version: input.expectedVersion,
    });
  return unwrap(data as number | null, error);
}

export async function createPlatformPreset(input: {
  client: SupabaseClient;
  displayName: string;
  presetPayload: Record<string, unknown>;
  enabled: boolean;
  sortOrder?: number;
}): Promise<PlatformPreset> {
  const { data, error } = await input.client.schema('admin').rpc('create_platform_preset', {
    p_display_name: input.displayName,
    p_preset_payload: input.presetPayload,
    p_enabled: input.enabled,
    p_sort_order: input.sortOrder ?? null,
  });
  return unwrap(data as PlatformPreset | null, error);
}

export async function updatePlatformPresetMetadata(input: {
  client: SupabaseClient;
  presetId: string;
  displayName: string;
  sortOrder: number;
}): Promise<PlatformPreset> {
  const { data, error } = await input.client
    .schema('admin')
    .rpc('update_platform_preset_metadata', {
      p_preset_id: input.presetId,
      p_display_name: input.displayName,
      p_sort_order: input.sortOrder,
    });
  return unwrap(data as PlatformPreset | null, error);
}

export async function setPlatformPresetEnabled(
  client: SupabaseClient,
  presetId: string,
  enabled: boolean
): Promise<PlatformPreset> {
  const { data, error } = await client.schema('admin').rpc('set_platform_preset_enabled', {
    p_preset_id: presetId,
    p_enabled: enabled,
  });
  return unwrap(data as PlatformPreset | null, error);
}

export async function publishPlatformPreset(input: {
  client: SupabaseClient;
  displayName: string;
  presetPayload: Record<string, unknown>;
}): Promise<PlatformPreset> {
  const { data, error } = await input.client.schema('admin').rpc('publish_platform_preset', {
    p_display_name: input.displayName,
    p_preset_payload: input.presetPayload,
  });
  return unwrap(data as PlatformPreset | null, error);
}
