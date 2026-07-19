import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminEnvironment } from './environment';
import type { ManagedConfigKey } from './configSchemas';

export interface AdminUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: 'owner' | 'operator' | 'viewer';
  can_access_test: boolean;
  can_access_prod: boolean;
}

export interface ManagedConfig {
  key: ManagedConfigKey;
  value: unknown;
  description: string | null;
  version: number;
  updated_at: string;
  text_value: string | null;
}

export interface ConfigDraft {
  id: string;
  environment: AdminEnvironment;
  config_key: ManagedConfigKey;
  value: unknown;
  description: string | null;
  base_version: number;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface ConfigRelease {
  id: string;
  environment: AdminEnvironment;
  config_key: ManagedConfigKey;
  runtime_version: number;
  value: unknown;
  description: string | null;
  source_draft_id: string | null;
  rollback_of_release_id: string | null;
  released_by_name: string | null;
  released_at: string;
}

export interface AuditLog {
  id: string;
  actor_email: string;
  actor_name: string | null;
  environment: AdminEnvironment;
  action: string;
  record_id: string;
  before_value?: unknown;
  after_value?: unknown;
  created_at: string;
}

export interface CharacterCard {
  id: string;
  name: string;
  description: string;
  avatar_url: string;
  tags: unknown;
  creator: string;
  first_mes: string;
  creator_notes: string;
  enabled: boolean;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CharacterLayoutValue {
  listed_ids: string[];
  delisted_ids: string[];
  deleted_ids: string[];
}

export interface CharacterLayoutDraft extends CharacterLayoutValue {
  id: string;
  base_layout_version: number;
  updated_at: string;
}

export interface CharacterLayoutSnapshot {
  layout_version: number;
  published: CharacterLayoutValue;
  draft: CharacterLayoutDraft | null;
}

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('后台接口没有返回数据');
  return data;
}

export async function getCurrentAdmin(client: SupabaseClient, userId: string): Promise<AdminUser> {
  const { data, error } = await client
    .schema('admin')
    .from('admin_users')
    .select('user_id,email,display_name,role,can_access_test,can_access_prod')
    .eq('user_id', userId)
    .single();
  return unwrap(data as AdminUser | null, error);
}

export async function setOperatorName(
  client: SupabaseClient,
  displayName: string
): Promise<AdminUser> {
  const { data, error } = await client
    .schema('admin')
    .rpc('set_operator_name', { p_display_name: displayName });
  return unwrap(data as AdminUser | null, error);
}

export async function getManagedConfigs(client: SupabaseClient): Promise<ManagedConfig[]> {
  const { data, error } = await client.schema('admin').rpc('get_managed_configs');
  return unwrap((data ?? []) as ManagedConfig[], error);
}

export async function getDrafts(
  client: SupabaseClient,
  environment: AdminEnvironment
): Promise<ConfigDraft[]> {
  const { data, error } = await client
    .schema('admin')
    .from('config_drafts')
    .select('*')
    .eq('environment', environment)
    .order('updated_at', { ascending: false })
    .limit(100);
  return unwrap((data ?? []) as ConfigDraft[], error);
}

export async function getReleases(
  client: SupabaseClient,
  environment: AdminEnvironment
): Promise<ConfigRelease[]> {
  const { data, error } = await client
    .schema('admin')
    .from('config_releases')
    .select('*')
    .eq('environment', environment)
    .order('released_at', { ascending: false })
    .limit(100);
  return unwrap((data ?? []) as ConfigRelease[], error);
}

export async function getAuditLogs(
  client: SupabaseClient,
  environment: AdminEnvironment
): Promise<AuditLog[]> {
  const { data, error } = await client
    .schema('admin')
    .from('audit_logs')
    .select('id,actor_email,actor_name,environment,action,record_id,created_at')
    .eq('environment', environment)
    .order('created_at', { ascending: false })
    .limit(100);
  return unwrap((data ?? []) as AuditLog[], error);
}

export async function saveDraft(input: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  key: ManagedConfigKey;
  value: unknown;
  description: string;
}): Promise<ConfigDraft> {
  const { data, error } = await input.client.schema('admin').rpc('upsert_config_draft', {
    p_environment: input.environment,
    p_config_key: input.key,
    p_value: input.value,
    p_text_value: null,
    p_description: input.description,
  });
  return unwrap(data as ConfigDraft | null, error);
}

export async function publishDraft(
  client: SupabaseClient,
  draftId: string
): Promise<ConfigRelease> {
  const { data, error } = await client
    .schema('admin')
    .rpc('publish_config_draft', { p_draft_id: draftId });
  return unwrap(data as ConfigRelease | null, error);
}

export async function discardDraft(client: SupabaseClient, draftId: string): Promise<void> {
  const { data, error } = await client
    .schema('admin')
    .rpc('discard_config_draft', { p_draft_id: draftId });
  const discarded = unwrap(data as boolean | null, error);
  if (!discarded) throw new Error('草稿未能放弃');
}

export async function rollbackRelease(
  client: SupabaseClient,
  releaseId: string
): Promise<ConfigRelease> {
  const { data, error } = await client
    .schema('admin')
    .rpc('rollback_config_release', { p_release_id: releaseId });
  return unwrap(data as ConfigRelease | null, error);
}

export async function getCharacters(client: SupabaseClient): Promise<CharacterCard[]> {
  const { data, error } = await client.schema('admin').rpc('get_characters');
  return unwrap((data ?? []) as CharacterCard[], error);
}

export async function setCharacterEnabled(
  client: SupabaseClient,
  characterId: string,
  enabled: boolean
): Promise<void> {
  const { data, error } = await client.schema('admin').rpc('set_character_enabled', {
    p_character_id: characterId,
    p_enabled: enabled,
  });
  if (!unwrap(data as boolean | null, error)) throw new Error('角色上下架失败');
}

export async function reorderCharacters(
  client: SupabaseClient,
  characterIds: string[]
): Promise<void> {
  const { data, error } = await client.schema('admin').rpc('reorder_characters', {
    p_character_ids: characterIds,
  });
  if (!unwrap(data as boolean | null, error)) throw new Error('角色排序失败');
}

export async function archiveCharacter(client: SupabaseClient, characterId: string): Promise<void> {
  const { data, error } = await client.schema('admin').rpc('archive_character', {
    p_character_id: characterId,
  });
  if (!unwrap(data as boolean | null, error)) throw new Error('角色归档失败');
}

export async function getCharacterLayout(client: SupabaseClient): Promise<CharacterLayoutSnapshot> {
  const { data, error } = await client.schema('admin').rpc('get_character_layout');
  return unwrap(data as CharacterLayoutSnapshot | null, error);
}

export async function saveCharacterLayoutDraft(
  client: SupabaseClient,
  layout: CharacterLayoutValue,
  baseLayoutVersion: number
): Promise<CharacterLayoutDraft> {
  const { data, error } = await client.schema('admin').rpc('save_character_layout_draft', {
    p_listed_ids: layout.listed_ids,
    p_delisted_ids: layout.delisted_ids,
    p_deleted_ids: layout.deleted_ids,
    p_base_layout_version: baseLayoutVersion,
  });
  return unwrap(data as CharacterLayoutDraft | null, error);
}

export async function discardCharacterLayoutDraft(
  client: SupabaseClient,
  draftId: string
): Promise<void> {
  const { data, error } = await client
    .schema('admin')
    .rpc('discard_character_layout_draft', { p_draft_id: draftId });
  if (!unwrap(data as boolean | null, error)) throw new Error('角色布局草稿未能放弃');
}

export async function publishCharacterLayoutDraft(
  client: SupabaseClient,
  draftId: string
): Promise<number> {
  const { data, error } = await client
    .schema('admin')
    .rpc('publish_character_layout_draft', { p_draft_id: draftId });
  return unwrap(data as number | null, error);
}
