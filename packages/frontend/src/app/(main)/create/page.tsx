'use client';

import { RefreshCw } from 'lucide-react';
import { PlazaGalleryHeader } from '@/components/image-plaza/plaza-gallery-header';
import { PlazaGalleryContent } from '@/components/image-plaza/plaza-gallery-content';
import { usePlazaGallery } from '@/components/image-plaza/use-plaza-gallery';

export default function CreatePage() {
  const view = usePlazaGallery();
  return (
    <main
      data-app-shell="image-plaza"
      onTouchStart={view.handleTouchStart}
      onTouchMove={view.handleTouchMove}
      onTouchEnd={view.handleTouchEnd}
      className="mx-auto min-h-[calc(100dvh-var(--app-nav-space))] w-full max-w-screen-xl overscroll-y-contain bg-background text-foreground"
    >
      {view.pullDistance > 0 || view.isPullRefreshing ? (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-2 text-[11px] font-bold shadow-xl backdrop-blur-xl transition-transform"
          style={{
            transform: `translate(-50%, ${view.isPullRefreshing ? 0 : view.pullDistance / 3}px)`,
          }}
        >
          <RefreshCw className={`size-3.5 ${view.isPullRefreshing ? 'animate-spin' : ''}`} />
          {view.isPullRefreshing ? '正在刷新' : view.pullDistance >= 64 ? '松开刷新' : '下拉刷新'}
        </div>
      ) : null}
      <PlazaGalleryHeader view={view} />
      <PlazaGalleryContent view={view} />
      {view.createConversation.isError ? (
        <p className="fixed bottom-[calc(var(--app-nav-space)+1rem)] left-1/2 z-50 -translate-x-1/2 rounded-full bg-destructive px-4 py-2 text-xs font-bold text-destructive-foreground">
          创建会话失败，请重试
        </p>
      ) : null}
    </main>
  );
}
