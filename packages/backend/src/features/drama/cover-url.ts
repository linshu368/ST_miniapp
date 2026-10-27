// 短剧封面的公开地址。drama-covers 是公开桶（见 telegram-video-archive/PIPELINE.md），
// 不像播放地址那样需要签名，纯本地拼接，不发请求。

import { getSupabaseClient } from '../../lib/supabase.js';

const BUCKET = 'drama-covers';

export function buildCoverUrl(coverPath: string): string {
  return getSupabaseClient().storage.from(BUCKET).getPublicUrl(coverPath).data.publicUrl;
}
