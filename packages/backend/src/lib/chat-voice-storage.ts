import { getSupabaseClient } from './supabase.js';

/** 桶由 migration 080 建，公开可读、仅允许 audio/mpeg */
const VOICE_BUCKET = 'miniapp-chat-voice';

export interface StoredVoice {
  path: string;
  url: string;
}

/**
 * 路径按「用户 / 消息 / 本次生成」三级：
 * 带上 audioId 而不是直接覆盖 <messageId>.mp3，是因为重新生成时旧地址可能正被播放，
 * 覆盖会让正在播的那一条中途换成新音频；而且公开桶走 CDN，同名覆盖还要跟缓存较劲。
 * 旧文件留着不清理——单条几十 KB，留着比引入一条删除路径便宜，也方便回溯。
 */
export async function storeMessageVoice(input: {
  userId: string;
  messageId: string;
  audioId: string;
  audio: Buffer;
}): Promise<StoredVoice> {
  const path = `${input.userId}/${input.messageId}/${input.audioId}.mp3`;
  const client = getSupabaseClient();

  const { error } = await client.storage.from(VOICE_BUCKET).upload(path, input.audio, {
    contentType: 'audio/mpeg',
    cacheControl: '31536000',
    upsert: true,
  });
  if (error) throw new Error(`保存语音失败：${error.message}`);

  const { data } = client.storage.from(VOICE_BUCKET).getPublicUrl(path);
  return { path, url: data.publicUrl };
}

export async function deleteMessageVoice(path: string): Promise<void> {
  const { error } = await getSupabaseClient().storage.from(VOICE_BUCKET).remove([path]);
  if (error) throw new Error(`删除语音失败：${error.message}`);
}
