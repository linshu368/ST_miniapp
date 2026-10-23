'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

import { useFavoriteFeedbackStore } from '@/stores/favorite-feedback-store';

/** Mounted once above routes so a disappearing favorite card cannot hide a failed save. */
export function FavoriteFeedbackNotice() {
  const notice = useFavoriteFeedbackStore((state) => state.notice);
  const dismiss = useFavoriteFeedbackStore((state) => state.dismiss);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => dismiss(notice.id), 5000);
    return () => window.clearTimeout(timer);
  }, [notice, dismiss]);

  if (!notice) return null;

  return (
    <div className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+1rem)] z-[100] flex justify-center">
      <div className="pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl border border-destructive/30 bg-card/95 py-2 pl-4 pr-2 shadow-xl backdrop-blur-xl">
        <p
          id="favorite-feedback-notice"
          role="alert"
          className="min-w-0 flex-1 text-xs leading-5 text-foreground"
        >
          {notice.message}
        </p>
        <button
          type="button"
          onClick={() => dismiss(notice.id)}
          aria-label="关闭收藏提示"
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
