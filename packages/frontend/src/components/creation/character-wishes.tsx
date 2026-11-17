'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Heart,
  LoaderCircle,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import {
  CHARACTER_WISH_MAX_LENGTH,
  CreateCharacterWishSchema,
  type CharacterWish,
  type CharacterWishCard,
  type CharacterWishQuery,
} from '@miniapp/shared';
import { cn } from '@/lib/utils';
import { chatEntryPath } from '@/lib/chat-entry';
import { useTelegramBackButton } from '@/lib/telegram/hooks';
import { useMemoryDraft } from '@/hooks/use-memory-draft';
import { useCreatorCharactersQuery } from '@/lib/api/creator-characters';
import { usePageReady } from '@/lib/perf/page-ready';
import {
  useCharacterWishQuery,
  useCharacterWishesQuery,
  useCreateCharacterWishMutation,
  useRespondCharacterWishMutation,
  useSupportCharacterWishMutation,
  useWithdrawCharacterWishMutation,
} from '@/lib/api/character-wishes';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

const CharacterDetailSheet = dynamic(() =>
  import('@/components/characters/character-detail-sheet').then(
    (module) => module.CharacterDetailSheet
  )
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WISH_SORTS = [
  { id: 'newest', label: '最新心愿' },
  { id: 'popular', label: '最多人想玩' },
] as const;
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
const PRIMARY = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-50 ${FOCUS}`;
const SECONDARY = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm text-foreground/85 disabled:opacity-50 ${FOCUS}`;
const ROOT = 'mx-auto min-h-full w-full max-w-lg px-4 pb-[max(24px,env(safe-area-inset-bottom))]';

function fromPath(from: string | null): string {
  if (from === 'creator-data') return '/creation/data';
  if (from === 'creation') return '/creation?tab=created';
  return '/characters';
}
function listParams(search: URLSearchParams | ReturnType<typeof useSearchParams>) {
  const params = new URLSearchParams();
  const from = search.get('from');
  if (from && ['characters', 'creator-data', 'creation'].includes(from)) params.set('from', from);
  if (search.get('scope') === 'mine') params.set('scope', 'mine');
  if (search.get('sort') === 'popular') params.set('sort', 'popular');
  const page = Number(search.get('page'));
  if (Number.isInteger(page) && page > 1 && page <= 10000) params.set('page', String(page));
  return params;
}
function pathWithQuery(path: string, params: URLSearchParams) {
  const query = params.toString();
  return `${path}${query ? `?${query}` : ''}`;
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
    : '';
}
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.name !== 'ZodError' ? error.message : fallback;
}

function Header({
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
function Loading() {
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
function ErrorState({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div role="alert" className="py-14 text-center">
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
      <button type="button" onClick={retry} className="mt-3 min-h-11 px-5 text-sm text-primary">
        重新加载
      </button>
    </div>
  );
}
function WishIdentity({ wish }: { wish: CharacterWish }) {
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
function SupportButton({ wish }: { wish: CharacterWish }) {
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

export function CharacterWishesPage() {
  const router = useRouter();
  const search = useSearchParams();
  const scope: CharacterWishQuery['scope'] = search.get('scope') === 'mine' ? 'mine' : 'public';
  const sort: CharacterWishQuery['sort'] = search.get('sort') === 'popular' ? 'popular' : 'newest';
  const rawPage = Number(search.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 && rawPage <= 10000 ? rawPage : 1;
  const query = useCharacterWishesQuery({ scope, sort, page, page_size: 12 });
  usePageReady('/wishes', query.data !== undefined, false, query.isError);
  const [compose, setCompose] = useState(search.get('compose') === '1');
  const [sortOpen, setSortOpen] = useState(false);
  const backHref = fromPath(search.get('from'));
  const params = listParams(search);
  const goBack = useCallback(() => {
    if (sortOpen) setSortOpen(false);
    else if (compose) setCompose(false);
    else router.push(backHref);
  }, [sortOpen, compose, router, backHref]);
  useTelegramBackButton(goBack);
  function updateQuery(values: Record<string, string>) {
    const next = listParams(search);
    for (const [key, value] of Object.entries(values)) next.set(key, value);
    router.replace(pathWithQuery('/wishes', next), {
      scroll: Boolean(values.page && !values.sort),
    });
  }
  function closeComposer() {
    setCompose(false);
    if (search.has('compose'))
      router.replace(pathWithQuery('/wishes', listParams(search)), { scroll: false });
  }
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 12));
  useEffect(() => {
    // A withdrawn last item can leave a remembered page beyond the new end.
    if (!query.isSuccess || query.isFetching || page <= totalPages) return;
    const next = listParams(search);
    next.set('page', String(totalPages));
    router.replace(pathWithQuery('/wishes', next), { scroll: false });
  }, [query.isSuccess, query.isFetching, page, totalPages, router, search]);
  return (
    <main className={ROOT}>
      <Header title="心愿墙" backHref={backHref}>
        <button
          type="button"
          onClick={() => setCompose(true)}
          className="mr-1 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-primary"
        >
          <Plus className="size-4" />
          许个愿
        </button>
      </Header>
      <div className="pt-6">
        <p className="text-[15px] font-medium tracking-wide">下一张想玩的角色，由你出题</p>
        <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
          所有心愿均匿名公开，不展示昵称和头像。
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between border-b border-border/60">
        <div className="flex gap-5" role="group" aria-label="心愿范围">
          {(
            [
              { id: 'public', label: '心愿墙' },
              { id: 'mine', label: '我的心愿' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={scope === tab.id}
              onClick={() => updateQuery({ scope: tab.id, page: '1' })}
              className={cn(
                'relative min-h-12 text-sm',
                FOCUS,
                scope === tab.id
                  ? 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                  : 'text-muted-foreground'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {scope === 'public' ? (
          <Sheet open={sortOpen} onOpenChange={setSortOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="心愿排序"
                className={`-mr-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground active:bg-muted/60 ${FOCUS}`}
              >
                {WISH_SORTS.find((item) => item.id === sort)!.label}
                {query.isPlaceholderData ? (
                  <LoaderCircle className="size-3.5 animate-spin" aria-label="正在排序" />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden />
                )}
              </button>
            </SheetTrigger>
            <SheetContent
              side="bottom"
              className="mx-auto max-w-lg rounded-t-3xl border-border/60 px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-3"
            >
              <div
                aria-hidden
                className="mx-auto mb-3 h-1 w-9 rounded-full bg-muted-foreground/20"
              />
              <div className="flex items-center justify-between">
                <SheetTitle className="text-base font-semibold">排序方式</SheetTitle>
                <button
                  type="button"
                  aria-label="关闭排序"
                  onClick={() => setSortOpen(false)}
                  className={`grid size-11 place-items-center rounded-full text-muted-foreground ${FOCUS}`}
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>
              <SheetDescription className="sr-only">选择心愿的排列方式</SheetDescription>
              <div role="radiogroup" aria-label="心愿排序方式" className="mt-3 space-y-1">
                {WISH_SORTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={sort === item.id}
                    onClick={() => {
                      setSortOpen(false);
                      if (item.id !== sort) updateQuery({ sort: item.id, page: '1' });
                    }}
                    className={cn(
                      'flex min-h-14 w-full items-center justify-between rounded-xl px-4 text-sm transition-colors active:bg-muted',
                      FOCUS,
                      sort === item.id
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'text-foreground/85'
                    )}
                  >
                    {item.label}
                    {sort === item.id ? <Check className="size-[18px]" aria-hidden /> : null}
                  </button>
                ))}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
      </div>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState text="心愿墙暂时没能加载，稍后再试试。" retry={() => void query.refetch()} />
      ) : query.data.items.length ? (
        <>
          <div className="space-y-3 py-4" aria-busy={query.isPlaceholderData}>
            {query.data.items.map((wish) => (
              <article
                key={wish.id}
                className="rounded-2xl border border-border/70 bg-card/70 px-4 pb-2 pt-4"
              >
                <WishIdentity wish={wish} />
                <Link
                  href={pathWithQuery(`/wishes/${wish.id}`, params)}
                  className={`my-3 block rounded-lg ${FOCUS}`}
                >
                  <p
                    className="ph-no-capture line-clamp-4 whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground/90"
                    data-sentry-mask
                  >
                    {wish.body}
                  </p>
                </Link>
                <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-2">
                  <SupportButton wish={wish} />
                  <Link
                    href={pathWithQuery(`/wishes/${wish.id}`, params)}
                    className="ml-auto inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground"
                  >
                    {wish.response_count > 0 ? (
                      <>
                        <span className="text-primary">{wish.response_count} 个作品回应</span>
                        <ChevronRight className="size-3.5" />
                      </>
                    ) : (
                      <>
                        看看心愿
                        <ChevronRight className="size-3.5" />
                      </>
                    )}
                  </Link>
                </div>
              </article>
            ))}
          </div>
          {totalPages > 1 ? (
            <nav aria-label="心愿翻页" className="flex items-center justify-center gap-5 py-4">
              <button
                type="button"
                aria-label="上一页"
                disabled={page <= 1}
                onClick={() => updateQuery({ page: String(page - 1) })}
                className={`${SECONDARY} disabled:opacity-30`}
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                aria-label="下一页"
                disabled={page >= totalPages}
                onClick={() => updateQuery({ page: String(page + 1) })}
                className={`${SECONDARY} disabled:opacity-30`}
              >
                <ChevronRight className="size-4" />
              </button>
            </nav>
          ) : null}
        </>
      ) : (
        <div className="px-5 py-16 text-center">
          <Sparkles className="mx-auto size-7 text-primary/70" />
          <p className="mt-4 text-sm font-medium">
            {scope === 'mine' ? '还没有留下心愿' : '第一份灵感，等你留下'}
          </p>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            {scope === 'mine'
              ? '想玩的人物、关系或故事，都可以说说。'
              : '不用写完整设定，一句话也可以成为故事的开始。'}
          </p>
          <button type="button" onClick={() => setCompose(true)} className={`${SECONDARY} mt-5`}>
            许个愿
          </button>
        </div>
      )}
      <WishComposer
        open={compose}
        onClose={closeComposer}
        onCreated={(id) => {
          closeComposer();
          const next = listParams(search);
          next.set('scope', 'mine');
          next.delete('page');
          router.push(pathWithQuery(`/wishes/${id}`, next));
        }}
      />
    </main>
  );
}

function WishSheet({
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

function WishComposer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const draft = useMemoryDraft('character-wish');
  const [error, setError] = useState('');
  const mutation = useCreateCharacterWishMutation();
  const request = useRef<{ id: string; body: string; visibility: 'public' }>();
  async function submit() {
    if (mutation.isPending || !draft.value.trim()) return;
    const body = draft.value.trim();
    if (!request.current || request.current.body !== body)
      request.current = { id: crypto.randomUUID(), body, visibility: 'public' };
    const parsed = CreateCharacterWishSchema.safeParse(request.current);
    if (!parsed.success) {
      setError('心愿最多 500 字，请稍微精简一下。');
      return;
    }
    const submitted = draft.value;
    setError('');
    try {
      const result = await mutation.mutateAsync(parsed.data);
      draft.clearIfUnchanged(submitted);
      request.current = undefined;
      onCreated(result.wish.id);
    } catch (failure) {
      setError(errorMessage(failure, '没能提交，内容已保留，请重试。'));
    }
  }
  return (
    <WishSheet
      open={open}
      onClose={mutation.isPending ? () => {} : onClose}
      title="许个愿"
      description="你想遇见什么样的角色，或经历怎样的故事？"
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        <label htmlFor="wish-body" className="sr-only">
          你想玩什么样的角色
        </label>
        <textarea
          id="wish-body"
          aria-describedby="wish-public-notice"
          value={draft.value}
          onChange={(event) => draft.setValue(event.target.value)}
          maxLength={CHARACTER_WISH_MAX_LENGTH}
          disabled={mutation.isPending}
          rows={5}
          placeholder="比如：想和一个反差御姐做瑟瑟的事情。"
          className="ph-no-capture block w-full resize-none rounded-2xl border border-input bg-background/60 px-4 py-3 text-base leading-7 outline-none placeholder:text-[13px] placeholder:text-muted-foreground/70 focus:border-primary/50"
          data-sentry-mask
        />
        <div className="mt-2 text-right text-[11px] tabular-nums text-muted-foreground">
          {draft.value.length} / {CHARACTER_WISH_MAX_LENGTH}
        </div>
        <p
          id="wish-public-notice"
          className="mt-3 flex items-start gap-2 text-xs leading-6 text-muted-foreground"
        >
          <Globe2 className="mt-1 size-4 shrink-0 text-primary/80" aria-hidden />
          <span>心愿将匿名公开，不展示昵称和头像，所有人都能看到。</span>
        </p>
      </div>
      {error ? (
        <p role="alert" className="mt-2 shrink-0 text-xs leading-5 text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!draft.value.trim() || mutation.isPending}
        onClick={() => void submit()}
        className={`${PRIMARY} mt-3 w-full shrink-0`}
      >
        {mutation.isPending ? (
          <>
            <LoaderCircle className="size-4 animate-spin" />
            正在提交…
          </>
        ) : (
          '提交心愿'
        )}
      </button>
    </WishSheet>
  );
}

export function CharacterWishDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const validId = UUID.test(id);
  const query = useCharacterWishQuery(validId ? id : undefined);
  usePageReady('/wishes/:id', query.data !== undefined, false, !validId || query.isError);
  const withdraw = useWithdrawCharacterWishMutation();
  const response = useRespondCharacterWishMutation();
  const [picker, setPicker] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [entering, setEntering] = useState(false);
  const params = listParams(search);
  const backHref = pathWithQuery('/wishes', params);
  const retryCard = search.get('respond');
  const recoveryCard = retryCard && UUID.test(retryCard) ? retryCard : null;
  const wish = query.data?.wish;
  const goBack = useCallback(() => {
    if (selectedCard) {
      setSelectedCard(null);
      setEntering(false);
    } else if (picker) setPicker(false);
    else if (confirmWithdraw) setConfirmWithdraw(false);
    else router.push(backHref);
  }, [selectedCard, picker, confirmWithdraw, router, backHref]);
  useTelegramBackButton(goBack);
  async function retryResponse() {
    if (!recoveryCard || response.isPending || !query.isSuccess) return;
    setNotice('');
    try {
      await response.mutateAsync({ id, characterId: recoveryCard });
      router.replace(pathWithQuery(`/wishes/${id}`, listParams(search)), { scroll: false });
      setNotice('已回应，想玩这个角色的人会收到消息。');
    } catch (error) {
      setNotice(errorMessage(error, '暂时没能关联，请再试一次。'));
    }
  }
  async function doWithdraw() {
    if (withdraw.isPending) return;
    try {
      await withdraw.mutateAsync(id);
      router.replace(backHref);
    } catch {
      /* The dialog keeps the error and retry action visible. */
    }
  }
  return (
    <main className={ROOT}>
      <Header title="心愿详情" backHref={backHref} />
      {recoveryCard ? (
        <div role="status" className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <p className="text-sm leading-6">角色已发布，暂未关联到心愿</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-5">
            {query.isSuccess ? (
              <button
                type="button"
                disabled={response.isPending}
                onClick={() => void retryResponse()}
                className="inline-flex min-h-11 items-center gap-2 text-sm text-primary"
              >
                {response.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                重新回应
                <ArrowRight className="size-4" />
              </button>
            ) : null}
            <Link
              href="/creation?tab=created"
              className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground"
            >
              查看我的角色
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 text-xs leading-6 text-primary">
          {notice}
        </p>
      ) : null}
      {!validId ? (
        <div className="py-16 text-center text-sm text-muted-foreground">这个心愿暂时看不了</div>
      ) : query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState
          text={errorMessage(query.error, '这个心愿暂时看不了，可能已经被撤回了。')}
          retry={() => void query.refetch()}
        />
      ) : wish ? (
        <>
          <section className="pt-6" aria-label="心愿内容">
            <WishIdentity wish={wish} />
            <p
              className="ph-no-capture mt-4 whitespace-pre-wrap break-words text-base leading-8 text-foreground/90"
              data-sentry-mask
            >
              {wish.body}
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <SupportButton wish={wish} />
              {wish.is_mine ? (
                <button
                  type="button"
                  onClick={() => setConfirmWithdraw(true)}
                  className="ml-auto min-h-11 px-2 text-xs text-muted-foreground"
                >
                  撤回心愿
                </button>
              ) : null}
            </div>
          </section>
          <section className="mt-6 border-t border-border/60 pt-5" aria-labelledby="wish-responses">
            <h2 id="wish-responses" className="flex items-center gap-2 text-sm font-medium">
              为这个心愿创作的角色
              {query.data.cards.length ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {query.data.cards.length}
                </span>
              ) : null}
            </h2>
            {query.data.cards.length ? (
              <div className="mt-3 divide-y divide-border/50">
                {query.data.cards.map((card) => (
                  <ResponseCard
                    key={card.id}
                    card={card}
                    onClick={() => {
                      setDetailsLoaded(true);
                      setSelectedCard(card.id);
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="py-5 text-sm leading-7 text-muted-foreground">
                还没有作品回应，留一点期待。
              </p>
            )}
          </section>
          <section
            className="mt-4 rounded-2xl border border-border/70 bg-card px-4 pb-3 pt-4"
            aria-label="回应心愿"
          >
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary/80" />
              <h2 className="text-sm font-medium">这个想法，你能写出来吗？</h2>
            </div>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              用你的作品回应，让等着玩的人遇见它。
            </p>
            <Link href={`/creation/characters/new?wish=${id}`} className={`${PRIMARY} mt-4 w-full`}>
              以此创作
              <ArrowRight className="size-4" />
            </Link>
            <button
              type="button"
              onClick={() => setPicker(true)}
              className="mt-1 min-h-11 w-full text-xs text-muted-foreground"
            >
              用已有作品回应
            </button>
          </section>
        </>
      ) : null}
      {picker ? (
        <RespondPicker
          wishId={id}
          existingIds={query.data?.cards.map((card) => card.id) ?? []}
          onClose={() => setPicker(false)}
          onDone={() => {
            setPicker(false);
            setNotice('已回应，想玩这个角色的人会收到消息。');
          }}
        />
      ) : null}
      <WishSheet
        open={confirmWithdraw}
        onClose={withdraw.isPending ? () => {} : () => setConfirmWithdraw(false)}
        title="撤回这个心愿？"
        description="撤回后将不再展示，已经创作出的角色不受影响。"
      >
        {withdraw.isError ? (
          <p role="alert" className="mb-3 text-xs text-destructive">
            {errorMessage(withdraw.error, '暂时没有成功，请再试一次。')}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={withdraw.isPending}
            onClick={() => setConfirmWithdraw(false)}
            className={SECONDARY}
          >
            再想想
          </button>
          <button
            type="button"
            disabled={withdraw.isPending}
            onClick={() => void doWithdraw()}
            className={PRIMARY}
          >
            {withdraw.isPending ? '正在撤回…' : '确认撤回'}
          </button>
        </div>
      </WishSheet>
      {detailsLoaded ? (
        <CharacterDetailSheet
          characterId={selectedCard}
          entering={entering}
          onClose={() => {
            setSelectedCard(null);
            setEntering(false);
          }}
          onEnter={(characterId, sessionId) => {
            if (entering) return;
            setEntering(true);
            router.push(chatEntryPath(characterId, { sessionId, source: 'discover' }));
          }}
        />
      ) : null}
    </main>
  );
}
function ResponseCard({ card, onClick }: { card: CharacterWishCard; onClick: () => void }) {
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
function RespondPicker({
  wishId,
  existingIds,
  onClose,
  onDone,
}: {
  wishId: string;
  existingIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const query = useCreatorCharactersQuery();
  const response = useRespondCharacterWishMutation();
  const [selected, setSelected] = useState<string | null>(null);
  const cards =
    query.data?.characters.filter(
      (card) =>
        card.state === 'ready' &&
        card.visibility === 'public' &&
        card.approved_revision !== null &&
        !existingIds.includes(card.id)
    ) ?? [];
  return (
    <WishSheet
      open
      onClose={response.isPending ? () => {} : onClose}
      title="选择回应作品"
      description="选择一张已经公开、适合这个心愿的角色卡。"
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState text="作品暂时没能加载" retry={() => void query.refetch()} />
        ) : cards.length ? (
          <div className="space-y-2">
            {cards.map((card) => (
              <button
                type="button"
                key={card.id}
                disabled={response.isPending}
                aria-pressed={selected === card.id}
                onClick={() => setSelected(card.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border p-3 text-left',
                  FOCUS,
                  selected === card.id ? 'border-primary/50 bg-primary/5' : 'border-border/60'
                )}
              >
                <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                  {card.cover_url ? (
                    <Image
                      src={card.cover_url}
                      alt=""
                      fill
                      sizes="48px"
                      className="object-cover"
                      unoptimized
                    />
                  ) : null}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 text-sm font-medium">{card.name}</span>
                  <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {card.description}
                  </span>
                </span>
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border',
                    selected === card.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {selected === card.id ? <Check className="size-3" /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="py-7 text-center">
            <p className="text-sm text-muted-foreground">暂时没有可以回应的公开作品</p>
            <Link href={`/creation/characters/new?wish=${wishId}`} className={`${SECONDARY} mt-4`}>
              以此创作
              <ArrowRight className="size-4" />
            </Link>
          </div>
        )}
      </div>
      {response.isError ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-destructive">
          {errorMessage(response.error, '暂时没有回应成功，请重试。')}
        </p>
      ) : null}
      {cards.length ? (
        <button
          type="button"
          disabled={!selected || response.isPending}
          onClick={() => {
            if (selected)
              response.mutate({ id: wishId, characterId: selected }, { onSuccess: onDone });
          }}
          className={`${PRIMARY} mt-4 w-full shrink-0`}
        >
          {response.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              正在回应…
            </>
          ) : (
            '确认回应'
          )}
        </button>
      ) : null}
    </WishSheet>
  );
}
