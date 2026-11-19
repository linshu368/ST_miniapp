'use client';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useCharacterWishesQuery } from '@/lib/api/character-wishes';
import { usePageReady } from '@/lib/perf/page-ready';
import { useTelegramBackButton } from '@/lib/telegram/hooks';
import { cn } from '@/lib/utils';
import { type CharacterWish, type CharacterWishQuery } from '@miniapp/shared';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { WishComposer } from './character-wish-composer';
import {
  ErrorState,
  FOCUS,
  Header,
  Loading,
  ROOT,
  SECONDARY,
  SupportButton,
  WISH_SORTS,
  WishIdentity,
  fromPath,
  listParams,
  pathWithQuery,
} from './character-wishes-shared';
function useWishesList() {
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
  return {
    router,
    search,
    scope,
    sort,
    page,
    query,
    compose,
    setCompose,
    sortOpen,
    setSortOpen,
    backHref,
    params,
    updateQuery,
    closeComposer,
    totalPages,
  };
}
type WishesListModel = ReturnType<typeof useWishesList>;
export function CharacterWishesPage() {
  const model = useWishesList();
  const { router, search, scope, page, compose, setCompose, backHref, closeComposer } = model;
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
      <WishesListFilters model={model} />
      <WishesListResults model={model} />
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

function WishesListFilters({ model }: { model: WishesListModel }) {
  const { scope, sort, page, query, sortOpen, setSortOpen, updateQuery } = model;
  return (
    <>
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
    </>
  );
}
function WishesListResults({ model }: { model: WishesListModel }) {
  const { scope, page, query, setCompose, params, updateQuery, totalPages } = model;
  return (
    <>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState text="心愿墙暂时没能加载，稍后再试试。" retry={() => void query.refetch()} />
      ) : query.data.items.length ? (
        <>
          <div className="space-y-3 py-4" aria-busy={query.isPlaceholderData}>
            {query.data.items.map((wish) => (
              <WishListCard key={wish.id} wish={wish} params={params} />
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
    </>
  );
}
function WishListCard({ wish, params }: { wish: CharacterWish; params: URLSearchParams }) {
  return (
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
  );
}
