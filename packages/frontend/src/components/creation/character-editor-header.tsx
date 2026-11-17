'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useOnboarding } from '@/hooks/use-onboarding';
import { isNewcomerProgress } from '@/stores/onboarding-store';
import { cn } from '@/lib/utils';

const SAVE_LABELS = {
  idle: '草稿自动保存在本地',
  saving: '保存中…',
  saved: '草稿已保存到本地',
  error: '这份草稿没存到本机',
};

export function CharacterEditorHeader({
  editing,
  busy,
  status,
  onBack,
}: {
  editing: boolean;
  busy: boolean;
  status: keyof typeof SAVE_LABELS;
  onBack: () => void;
}) {
  return (
    <>
      <header className="flex min-h-11 items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="flex min-h-11 shrink-0 items-center gap-2 text-sm text-foreground disabled:opacity-50"
        >
          <ArrowLeft className="size-4" />
          {editing ? '编辑角色' : '创建角色'}
        </button>
        <span
          role="status"
          className={cn(
            'text-right text-[10px] leading-5 text-muted-foreground',
            status === 'error' && 'text-destructive'
          )}
        >
          {SAVE_LABELS[status]}
        </span>
      </header>
      {!editing ? <CreatorFeatureGuide /> : null}
    </>
  );
}

function locateCreatorFeature(kind: 'polish' | 'preset') {
  const target = document.querySelector(
    kind === 'polish'
      ? 'button[aria-label="AI 润色开场白"]'
      : '[aria-label="预设模板，可多选"] button'
  );
  if (!(target instanceof HTMLElement)) return;
  target.scrollIntoView({
    block: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
  target.focus({ preventScroll: true });
}

function CreatorFeatureGuide() {
  const { progress, update } = useOnboarding();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!isNewcomerProgress(progress) || progress?.creatorIntroSeen) return;
    setVisible(true);
    update({ creatorStarted: true, creatorIntroSeen: true });
  }, [progress, update]);
  if (!visible) return null;
  return (
    <aside
      aria-label="角色创作小贴士"
      className="mt-4 rounded-2xl border border-primary/15 bg-primary/[0.035]"
    >
      <div className="flex items-center justify-between pl-3.5">
        <p className="text-[13px] font-medium">这两处，可以帮你省点力</p>
        <button
          type="button"
          aria-label="收起创作小贴士"
          onClick={() => setVisible(false)}
          className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="mx-3.5 divide-y divide-border/50">
        <section className="pb-2">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Sparkles className="size-3.5 text-primary" aria-hidden />
            AI 润色
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            先写个大概，AI 帮你完善。满意了再采用。
          </p>
          <button
            type="button"
            onClick={() => locateCreatorFeature('polish')}
            className="flex min-h-11 items-center gap-1 text-xs text-primary"
          >
            看看 AI 润色
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </section>
        <section className="pb-1 pt-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <SlidersHorizontal className="size-3.5 text-primary" aria-hidden />
            预设模板
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            给角色补充扮演和回复规则。不想自己写，可以选现成模板；点「说明」先看看，可多选。
          </p>
          <button
            type="button"
            onClick={() => locateCreatorFeature('preset')}
            className="flex min-h-11 items-center gap-1 text-xs text-primary"
          >
            看看预设
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </section>
      </div>
    </aside>
  );
}
