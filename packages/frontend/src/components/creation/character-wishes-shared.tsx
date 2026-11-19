'use client';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useSupportCharacterWishMutation } from '@/lib/api/character-wishes';
import { cn } from '@/lib/utils';
import { type CharacterWish, type CharacterWishCard } from '@miniapp/shared';
import { ArrowLeft, ChevronRight, Heart, LoaderCircle, Sparkles, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WISH_SORTS = [
  { id: 'newest', label: '最新心愿' },
  { id: 'popular', label: '最多人想玩' },
] as const;
export const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
export const PRIMARY = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50 ${FOCUS}`;
export const SECONDARY = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm text-foreground/85 disabled:opacity-50 ${FOCUS}`;
export const ROOT =
  'mx-auto min-h-full w-full max-w-lg px-4 pb-[max(24px,env(safe-area-inset-bottom))]';

export function fromPath(from: string | null): string {
  if (from === 'creator-data') return '/creation/data';
  if (from === 'creation') return '/creation?tab=created';
  return '/characters';
}
export function listParams(search: URLSearchParams | ReturnType<typeof useSearchParams>) {
  const params = new URLSearchParams();
  const from = search.get('from');
  if (from && ['characters', 'creator-data', 'creation'].includes(from)) params.set('from', from);
  if (search.get('scope') === 'mine') params.set('scope', 'mine');
  if (search.get('sort') === 'popular') params.set('sort', 'popular');
  const page = Number(search.get('page'));
  if (Number.isInteger(page) && page > 1 && page <= 10000) params.set('page', String(page));
  return params;
}
export function pathWithQuery(path: string, params: URLSearchParams) {
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}`;
}
export function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
    : '';
}
export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.name !== 'ZodError' ? error.message : fallback;
}

export function Header({
  title,
  backHref,
  children,
}: {
  title: string;
  backHref: string;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 -mx-4 flex h-[calc(4rem+env(safe-area-inset-top))] items-center gap-2 border-b border-border/50 bg-background/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <Link
        href={backHref}
        aria-label="返回"
        className={`flex size-11 shrink-0 items-center justify-center rounded-full ${FOCUS}`}
      >
        <ArrowLeft className="size-5" />
      </Link>
      <h1 className="flex-1 text-[17px] font-semibold tracking-wide">{title}</h1>
      {children}
    </header>
  );
}
export function Loading() {
  return (
    <div
      role="status"
      className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <LoaderCircle className="size-4 animate-spin" />
      正在加载…
    </div>
  );
}
export function ErrorState({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div role="alert" className="py-14 text-center">
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
      <button type="button" onClick={retry} className="mt-3 min-h-11 px-5 text-sm text-primary">
        重新加载
      </button>
    </div>
  );
}
export function WishIdentity({ wish }: { wish: CharacterWish }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex size-7 items-center justify-center rounded-full bg-muted/60 text-foreground/50">
        <Sparkles className="size-3.5" />
      </span>
      <span>{wish.is_mine ? '我的心愿' : '匿名心愿'}</span>
      <time dateTime={wish.created_at} className="ml-auto text-[11px] text-muted-foreground/70">
        {dateLabel(wish.created_at)}
      </time>
    </div>
  );
}
export function SupportButton({ wish }: { wish: CharacterWish }) {
  const mutation = useSupportCharacterWishMutation();
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-pressed={wish.supported}
        aria-label={
          wish.is_mine ? `${wish.wanted_count} 人想玩` : wish.supported ? '取消期待' : '我也想玩'
        }
        disabled={wish.is_mine || mutation.isPending}
        onClick={() => mutation.mutate({ id: wish.id, supported: !wish.supported })}
        className={cn(
          'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs transition-colors disabled:cursor-default',
          FOCUS,
          wish.supported ? 'bg-primary/10 text-primary' : 'bg-muted/60 text-foreground/75',
          wish.is_mine && 'bg-transparent px-0 text-muted-foreground'
        )}
      >
        {mutation.isPending ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Heart className={cn('size-3.5', wish.supported && 'fill-current')} />
        )}
        {wish.is_mine ? `${wish.wanted_count} 人想玩` : wish.supported ? '一起期待' : '我也想玩'}
        {!wish.is_mine ? (
          <span aria-hidden className="ml-0.5 tabular-nums opacity-70">
            {wish.wanted_count}
          </span>
        ) : null}
      </button>
      {mutation.isError ? (
        <p role="alert" className="mt-1 max-w-56 text-xs text-destructive">
          {errorMessage(mutation.error, '暂时没有成功，请再试一次。')}
        </p>
      ) : null}
    </div>
  );
}

export function WishSheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const [viewport, setViewport] = useState<{ height: number; bottom: number }>();
  useEffect(() => {
    if (!open) return;
    const view = window.visualViewport;
    const update = () =>
      setViewport({
        height: Math.max(200, (view?.height ?? window.innerHeight) - 12),
        bottom: Math.max(
          0,
          window.innerHeight - (view?.height ?? window.innerHeight) - (view?.offsetTop ?? 0)
        ),
      });
    update();
    view?.addEventListener('resize', update);
    view?.addEventListener('scroll', update);
    return () => {
      view?.removeEventListener('resize', update);
      view?.removeEventListener('scroll', update);
    };
  }, [open]);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        style={viewport ? { maxHeight: viewport.height, bottom: viewport.bottom } : undefined}
        className="mx-auto flex max-h-[90dvh] max-w-lg flex-col overflow-hidden rounded-t-3xl border-border/60 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3"
      >
        <div
          aria-hidden
          className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/20"
        />
        <div className="flex shrink-0 items-center gap-3">
          <SheetTitle className="flex-1 text-lg font-semibold">{title}</SheetTitle>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={`flex size-11 items-center justify-center rounded-full ${FOCUS}`}
          >
            <X className="size-5 text-muted-foreground" />
          </button>
        </div>
        <SheetDescription className="mb-4 shrink-0 text-xs leading-6">
          {description}
        </SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

export function ResponseCard({ card, onClick }: { card: CharacterWishCard; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl py-3 text-left ${FOCUS}`}
    >
      <div className="relative h-20 w-[60px] shrink-0 overflow-hidden rounded-xl bg-muted">
        {card.cover_url ? (
          <Image
            src={card.cover_url}
            alt=""
            fill
            sizes="60px"
            className="object-cover"
            unoptimized
          />
        ) : (
          <Sparkles className="absolute inset-0 m-auto size-5 text-muted-foreground" />
        )}
      </div>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-sm font-medium">{card.name}</span>
        <span className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {card.description}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
