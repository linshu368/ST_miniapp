import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminEnvironment } from './environment';
import { getAdminApiUrl } from './environment';
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
  text_value: string | null;
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
  text_value?: string | null;
  description: string | null;
  source_draft_id: string | null;
  rollback_of_release_id: string | null;
  released_by_name: string | null;
  released_at: string;
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

export interface CharacterLayoutRelease {
  id: string;
  layout_version: number;
  release_kind: 'baseline' | 'publish' | 'rollback';
  source_draft_id: string | null;
  rollback_target_release_id: string | null;
  rollback_target_version: number | null;
  listed_ids: string[];
  delisted_ids: string[];
  deleted_ids: string[];
  listed_count: number;
  delisted_count: number;
  deleted_count: number;
  released_by_email: string | null;
  released_by_name: string | null;
  released_at: string;
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

export async function saveDraft(input: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  key: ManagedConfigKey;
  value: unknown;
  textValue?: string | null;
  description: string;
}): Promise<ConfigDraft> {
  const usesTextValue = input.textValue !== undefined;
  const { data, error } = await input.client.schema('admin').rpc('upsert_config_draft', {
    p_environment: input.environment,
    p_config_key: input.key,
    p_value: usesTextValue ? null : input.value,
    p_text_value: usesTextValue ? input.textValue : null,
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

export async function createCharacter(
  client: SupabaseClient,
  input: {
    name: string;
    description: string;
    avatarUrl: string;
    tags: string[];
    creator: string;
    firstMes: string;
    creatorNotes: string;
    personality: string;
    scenario: string;
    systemPrompt: string;
    mesExample: string;
  }
): Promise<CharacterCard> {
  const { data, error } = await client.schema('admin').rpc('create_character', {
    p_name: input.name,
    p_description: input.description,
    p_avatar_url: input.avatarUrl,
    p_tags: input.tags,
    p_creator: input.creator,
    p_first_mes: input.firstMes,
    p_creator_notes: input.creatorNotes,
    p_personality: input.personality,
    p_scenario: input.scenario,
    p_system_prompt: input.systemPrompt,
    p_mes_example: input.mesExample,
  });
  return unwrap(data as CharacterCard | null, error);
}

export async function uploadCharacterAvatar(
  client: SupabaseClient,
  environment: AdminEnvironment,
  characterId: string,
  file: File
): Promise<string> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('登录状态已失效，请重新登录');

  const pngBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('头像文件读取失败'));
    reader.onload = () => {
      const value = String(reader.result ?? '');
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
  const response = await fetch(
    `${getAdminApiUrl(environment)}/api/admin/character-assets/${encodeURIComponent(characterId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pngBase64 }),
    }
  );
  const body = (await response.json()) as { avatarUrl?: string; message?: string };
  if (!response.ok || !body.avatarUrl) {
    throw new Error(body.message || '角色头像上传失败');
  }
  return body.avatarUrl;
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

export async function listCharacterLayoutReleases(
  client: SupabaseClient,
  limit = 30
): Promise<CharacterLayoutRelease[]> {
  const { data, error } = await client
    .schema('admin')
    .rpc('list_character_layout_releases', { p_limit: limit });
  return unwrap((data ?? []) as CharacterLayoutRelease[], error);
}

export async function deleteCharacterLayoutRelease(
  client: SupabaseClient,
  releaseId: string
): Promise<void> {
  const { error } = await client
    .schema('admin')
    .rpc('delete_character_layout_release', { p_release_id: releaseId });
  if (error) throw error;
}

export async function rollbackCharacterLayoutRelease(
  client: SupabaseClient,
  releaseId: string,
  expectedLayoutVersion: number
): Promise<number> {
  const { data, error } = await client.schema('admin').rpc('rollback_character_layout_release', {
    p_release_id: releaseId,
    p_expected_layout_version: expectedLayoutVersion,
  });
  return unwrap(data as number | null, error);
}
