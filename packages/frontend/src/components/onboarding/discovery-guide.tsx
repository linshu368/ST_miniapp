'use client';

import Link from 'next/link';
import { ArrowUpRight, MessagesSquare, Sparkles, X } from 'lucide-react';
import { useGuideInputBusy, useOnboarding } from '@/hooks/use-onboarding';

export function DiscoveryGuide({ conversations = false }: { conversations?: boolean }) {
  const { active, progress, update } = useOnboarding();
  const inputBusy = useGuideInputBusy();
  if (!active || !progress || inputBusy) return null;
  const returning = progress.replied && !progress.returned;
  if (!returning && (progress.started || conversations)) return null;
  return (
    <aside
      aria-label="新手引导"
      className="mx-4 mb-2 mt-3 rounded-2xl border border-primary/15 bg-primary/[0.045] sm:mx-6"
    >
      <div className="flex items-start gap-2.5 pl-3.5">
        {returning ? (
          <MessagesSquare className="mt-4 size-4 shrink-0 text-primary" aria-hidden />
        ) : (
          <Sparkles className="mt-4 size-4 shrink-0 text-primary" aria-hidden />
        )}
        <div className="min-w-0 flex-1 py-3">
          <p className="text-[13px] font-medium text-foreground">
            {returning ? '刚才的故事，会一直留在这里' : '先找一个让你好奇的角色'}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {returning
              ? '在「对话」里接着聊，新分支也会单独保存。'
              : '点开角色，接一句话，故事就开始了。'}
          </p>
          {returning ? (
            <Link
              href="/chats"
              onClick={() => update({ returned: true })}
              className="-mb-1 mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-primary"
            >
              {conversations ? '知道了，继续探索' : '去看我的对话'}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => update(returning ? { returned: true } : { skipped: true })}
          aria-label={returning ? '收起对话提示' : '跳过新手引导'}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </aside>
  );
}
