'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { useActiveBackground } from '@/hooks/use-chat-background';
import { plateOpacity, veilOpacity } from '@/lib/appearance/chat-background';
import { useEntryEnrichReady } from '@/lib/entry-phase';
import { cn } from '@/lib/utils';
import { useChatBackgroundStore } from '@/stores/chat-background-store';
import { replyScale, useReplySizeStore } from '@/stores/reply-size-store';

/**
 * 背景层要按整屏高度铺：安卓弹键盘时整个视口变矮，跟着缩的话图片会跳一下。
 * 记住当前宽度下见过的最大高度，转屏（宽度变了）再重新算。
 */
function useFullViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    let width = window.innerWidth;
    let tallest = window.innerHeight;
    const sync = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = window.innerHeight;
      } else {
        tallest = Math.max(tallest, window.innerHeight);
      }
      setHeight(tallest);
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  return height;
}

function BackgroundLayer({ url }: { url: string }) {
  const height = useFullViewportHeight();
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url) return null;
  return (
    <div
      aria-hidden
      data-testid="chat-background"
      className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-dvh overflow-hidden"
      style={height ? { height } : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        decoding="async"
        draggable={false}
        onLoad={() => setLoadedUrl(url)}
        onError={() => setFailedUrl(url)}
        className={cn(
          'size-full object-cover object-[50%_30%] transition-opacity duration-150 motion-reduce:transition-none',
          loadedUrl === url ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div className="absolute inset-0 bg-background opacity-[var(--chat-bg-veil)]" />
    </div>
  );
}

/**
 * 聊天页的外壳：承载背景、采光和字号，里面的部件只通过 CSS 变量和 data-bg 感知，
 * 不需要逐个接收参数；调滑杆时也只有这一层更新。
 */
export function ChatSurface({
  characterId,
  coverSource,
  userScope,
  viewportHeight,
  children,
}: {
  characterId: string;
  coverSource: string | null;
  userScope: string;
  viewportHeight: number | null;
  children: ReactNode;
}) {
  // 背景和本机图片都等页面就绪后再读，不占进页的关键路径。
  const enrichReady = useEntryEnrichReady();
  const hydrate = useChatBackgroundStore((state) => state.hydrate);
  const hydrateReplySize = useReplySizeStore((state) => state.hydrate);
  useEffect(() => hydrateReplySize(), [hydrateReplySize]);
  useEffect(() => {
    if (enrichReady) hydrate(userScope);
  }, [enrichReady, hydrate, userScope]);

  const level = useReplySizeStore((state) => state.level);
  const scale = replyScale(level);
  const background = useActiveBackground(characterId, coverSource);
  const style: CSSProperties & Record<`--${string}`, string | number> = {
    // 高度跟着可视视口走而不是写死 100dvh：iOS 弹键盘时后者不变，
    // 整页会被顶上去，sticky 顶栏就跑出屏幕了
    height: viewportHeight ? `${viewportHeight}px` : '100dvh',
    '--reply-scale': scale,
  };
  if (background) {
    style['--chat-bg-veil'] = veilOpacity(background.light);
    style['--chat-bg-plate'] = plateOpacity(
      background.light,
      background.appearance,
      background.tone
    );
  }

  return (
    <div
      data-chat-surface
      data-bg={background ? 'on' : undefined}
      data-reply-small={scale < 1 ? '' : undefined}
      className="group/chat relative isolate flex flex-col bg-background text-foreground"
      style={style}
    >
      {background ? <BackgroundLayer url={background.url} /> : null}
      {children}
    </div>
  );
}
