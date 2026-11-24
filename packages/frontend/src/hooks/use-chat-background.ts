'use client';

import { useEffect, useState } from 'react';

import {
  COVER_IMAGE,
  effectiveBackground,
  resolvedLight,
  UNKNOWN_TONE,
  type ImageTone,
} from '@/lib/appearance/chat-background';
import { loadImage, measureTone } from '@/lib/appearance/image-tone';
import { supabasePublicImageUrl } from '@/lib/supabase-image';
import { useChatBackgroundStore } from '@/stores/chat-background-store';

/** 当前只有夜间；昼夜切换上线后改为读主题。 */
const APPEARANCE = 'night';

/** 封面铺满整屏，比列表缩略图大一档。 */
export function coverBackgroundUrl(source: string): string {
  return supabasePublicImageUrl(source, { width: 810, height: 1080, quality: 70 });
}

export interface ActiveBackground {
  url: string;
  light: number;
  tone: ImageTone;
}

/** 封面是跨域图，亮度要单独按 CORS 读一次；读不到就按未知处理，不影响显示。 */
function useCoverTone(url: string | null): ImageTone {
  const [measured, setMeasured] = useState<{ url: string; tone: ImageTone } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    loadImage(url, 'anonymous')
      .then((image) => {
        const tone = measureTone(image);
        if (!cancelled) setMeasured({ url, tone });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [url]);
  return measured && measured.url === url ? measured.tone : UNKNOWN_TONE;
}

/** 这张卡现在该显示的背景；没设、图片还没读到、或已被删掉时为 null。 */
export function useActiveBackground(
  characterId: string,
  coverSource: string | null
): ActiveBackground | null {
  const prefs = useChatBackgroundStore((state) => state.prefs);
  const images = useChatBackgroundStore((state) => state.images);
  const background = effectiveBackground(prefs, characterId);
  const usesCover = background?.img === COVER_IMAGE;
  const coverUrl = usesCover && coverSource ? coverBackgroundUrl(coverSource) : null;
  const coverTone = useCoverTone(coverUrl);
  if (!background) return null;
  const own = usesCover ? null : images?.find((image) => image.id === background.img);
  const url = usesCover ? coverUrl : own?.url;
  if (!url) return null;
  const tone: ImageTone = own ?? coverTone;
  return { url, tone, light: resolvedLight(background, APPEARANCE, tone) };
}

export { APPEARANCE as CHAT_APPEARANCE };
