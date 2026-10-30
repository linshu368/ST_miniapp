'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { CharacterPolishSession } from './character-editor-polish';
export type { CharacterPolishSession, CharacterPolishTarget } from './character-editor-polish';

export function CharacterEditorModal({
  title,
  onClose,
  children,
  action = '关闭',
  compact = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  action?: string;
  compact?: boolean;
}) {
  const content = useRef<HTMLDivElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const fit = useCallback(() => {
    if (!content.current) return;
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const offset = viewport?.offsetTop ?? 0;
    const visibleHeight = compact ? Math.min(740, height - 12) : height;
    content.current.style.height = `${visibleHeight}px`;
    content.current.style.top = `${offset + height - visibleHeight}px`;
  }, [compact]);
  const attachContent = useCallback(
    (element: HTMLDivElement | null) => {
      content.current = element;
      // Radix mounts the portal after the parent effect; fit when the actual surface exists.
      if (element) fit();
    },
    [fit]
  );
  useEffect(() => {
    const viewport = window.visualViewport;
    fit();
    viewport?.addEventListener('resize', fit);
    viewport?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    return () => {
      viewport?.removeEventListener('resize', fit);
      viewport?.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
    };
  }, [fit]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={attachContent}
        style={{ animation: 'none', transition: 'none' }}
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          close.current?.focus({ preventScroll: true });
        }}
        className={`top-0 flex h-[100dvh] max-h-none w-full max-w-lg translate-y-0 flex-col gap-0 overflow-hidden border-border bg-background p-0 text-foreground data-[state=open]:animate-none ${compact ? 'rounded-t-3xl sm:rounded-b-none' : 'rounded-none sm:rounded-none'}`}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5 pb-3 pt-[max(12px,env(safe-area-inset-top))]">
          <DialogTitle className="min-w-0 break-words text-base font-medium">{title}</DialogTitle>
          <button
            ref={close}
            type="button"
            className="flex min-h-11 shrink-0 items-center justify-center rounded-xl px-3 text-sm text-primary"
            aria-label={action}
            onClick={onClose}
          >
            {action === '关闭' ? <X className="size-5" /> : action}
          </button>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function CharacterFullscreenEditor({
  title,
  value,
  placeholder,
  onChange,
  onClose,
}: {
  title: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <CharacterEditorModal title={title} onClose={onClose} action="完成">
      <textarea
        aria-label={`${title}全屏编辑`}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-0 flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 text-base leading-8 text-foreground outline-none placeholder:text-muted-foreground"
      />
    </CharacterEditorModal>
  );
}

const LABELS = { opening: '开场白', background: '背景' };

export function CharacterPolishDialog({
  session,
  onClose,
  onDiscard,
  onRetry,
  onApply,
  onEdit,
}: {
  session: CharacterPolishSession;
  onClose: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onApply: () => void;
  onEdit: (value: string) => void;
}) {
  const loading = session.state === 'loading';
  return (
    <CharacterEditorModal compact title={`润色${LABELS[session.target]}`} onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 py-4">
        {session.original && (
          <details className="shrink-0 rounded-xl border border-border/60 bg-white/[0.02] px-3 py-2.5 text-xs text-muted-foreground">
            <summary className="cursor-pointer">查看原稿</summary>
            <p className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap break-words leading-7">
              {session.original}
            </p>
          </details>
        )}
        <div className="flex shrink-0 items-center justify-between gap-2">
          <p className="flex min-h-11 items-center gap-2 text-[11px] text-muted-foreground" role="status">
            {loading ? (
              <>
                <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
                {session.result ? '正在完善细节…' : '正在结合你的设定润色…'}
              </>
            ) : session.state === 'ready' ? (
              '润色完成，你也可以直接修改'
            ) : session.result.trim() ? (
              '已有内容可以编辑或采用'
            ) : (
              '原稿已保留'
            )}
          </p>
          {!loading && (
            <button
              type="button"
              className="min-h-11 shrink-0 text-[11px] text-primary"
              onClick={onRetry}
            >
              {session.state === 'error' ? '重新尝试' : '再润色一次'}
            </button>
          )}
        </div>
        {session.result ? (
          <textarea
            aria-label="润色结果"
            value={session.result}
            readOnly={loading}
            onChange={(event) => onEdit(event.target.value)}
            className="min-h-56 w-full flex-1 resize-none rounded-xl border border-input bg-card p-3 text-base leading-8 text-foreground outline-none focus:border-primary/60"
          />
        ) : (
          !session.error && (
            <div className="space-y-4 py-5" aria-hidden>
              {[100, 85, 65].map((width) => (
                <div
                  key={width}
                  style={{ width: `${width}%` }}
                  className="h-2 rounded bg-white/5 motion-safe:animate-pulse"
                />
              ))}
            </div>
          )
        )}
        {session.error && (
          <p className="mt-4 text-xs leading-7 text-destructive" role="alert">
            {session.error}
          </p>
        )}
      </div>
      <footer className="grid shrink-0 grid-cols-2 gap-3 border-t border-border/60 px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-4">
        <button
          type="button"
          className="min-h-12 rounded-xl border border-border text-sm text-foreground/80"
          onClick={onDiscard}
        >
          {loading ? '取消润色' : '暂不采用'}
        </button>
        <button
          type="button"
          className="min-h-12 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-30"
          disabled={loading || !session.result.trim()}
          onClick={onApply}
        >
          采用这一版
        </button>
      </footer>
    </CharacterEditorModal>
  );
}
