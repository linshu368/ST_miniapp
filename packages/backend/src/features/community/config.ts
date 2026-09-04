import { fetchRuntimeConfigEntries } from '../../platform/runtime-config.js';

const CONFIG_KEYS = [
  'miniapp_official_community_enabled',
  'miniapp_official_community_chat_id',
  'miniapp_official_community_url',
  'miniapp_official_community_fallback_handle',
  'miniapp_official_community_reward_credits',
  'miniapp_official_community_reward_started_at',
  'miniapp_official_community_copy',
] as const;

export interface OfficialCommunityConfig {
  enabled: boolean;
  chatId: string;
  url: string;
  handle: string;
  rewardCredits: number;
  startedAt: string | null;
  title: string;
  description: string;
}

export async function readOfficialCommunityConfig(): Promise<OfficialCommunityConfig> {
  const entries = await fetchRuntimeConfigEntries(CONFIG_KEYS);
  const read = (key: (typeof CONFIG_KEYS)[number]) => entries.get(key)?.value;
  const copyValue = read('miniapp_official_community_copy');
  const copy = isRecord(copyValue) ? copyValue : {};
  const rawCredits = Number(read('miniapp_official_community_reward_credits'));
  const rawStartedAt = text(read('miniapp_official_community_reward_started_at'));
  return {
    enabled: read('miniapp_official_community_enabled') === true,
    chatId: text(read('miniapp_official_community_chat_id')) ?? '',
    url: text(read('miniapp_official_community_url')) ?? 'https://t.me/MijingAI_Official',
    handle: text(read('miniapp_official_community_fallback_handle')) ?? '@MijingAI_Official',
    rewardCredits: Number.isSafeInteger(rawCredits) && rawCredits > 0 ? rawCredits : 500,
    startedAt: rawStartedAt && !Number.isNaN(Date.parse(rawStartedAt)) ? rawStartedAt : null,
    title: text(copy.title) ?? '加入官方社群',
    description:
      text(copy.description) ??
      '即将为你打开官方纸飞机社群。系统确认已实际入群并完成账户 ID 匹配后，将自动发放 500 星尘。',
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
