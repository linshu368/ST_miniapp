'use client';

import { useCallback, useLayoutEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BookOpen, Heart, Loader2, Star } from 'lucide-react';
import type { CharacterSummary } from '@miniapp/shared';
import { usePublicCreatorWorks } from '@/lib/api/public-creator';
import { ApiClientError } from '@/lib/api/client';
import { useTelegramBackButton } from '@/lib/telegram/hooks';
import { chatEntryPath } from '@/lib/chat-entry';
import { formatCompactCount } from '@/lib/utils';
import {
  publicCreatorBackHref,
  rememberCreatorWorksScroll,
  restoreCreatorWorksScroll,
} from '@/lib/roleplay-navigation';
import { characterRoomGradient } from '@/lib/utils/character-hue';
import { supabasePublicImageUrl } from '@/lib/supabase-image';

const CharacterDetailSheet = dynamic(
  () =>
    import('@/components/characters/character-detail-sheet').then(
      (module) => module.CharacterDetailSheet
    ),
  { ssr: false }
);

export default function PublicCreatorPage({ params }: { params: { id: string } }) {
  return <PublicCreatorSpace key={params.id} id={params.id} />;
}

function PublicCreatorSpace({ id }: { id: string }) {
  const router = useRouter();
  const works = usePublicCreatorWorks(id);
  const [selected, setSelected] = useState<CharacterSummary | null>(null);
  const [opened, setOpened] = useState(false);
  const back = useCallback(() => {
    if (selected) setSelected(null);
    else router.replace(publicCreatorBackHref(id), { scroll: false });
  }, [selected, router, id]);
  useTelegramBackButton(back);

  useLayoutEffect(() => {
    if (works.data) restoreCreatorWorksScroll(id);
  }, [id, works.data]);

  const unavailable = works.error instanceof ApiClientError && works.error.status === 404;
  const pages = unavailable ? [] : (works.data?.pages ?? []);
  const cards = Array.from(
    new Map(pages.flatMap((p) => p.characters).map((c) => [c.id, c])).values()
  );

  return (
    <main className="mx-auto min-h-dvh max-w-lg px-4 pb-[max(24px,env(safe-area-inset-bottom))] text-foreground">
      <header className="sticky top-0 z-10 -mx-4 flex items-center gap-2 border-b border-border/60 bg-background px-3 pb-1 pt-[max(4px,env(safe-area-inset-top))]">
        <button
          type="button"
          aria-label="返回"
          onClick={back}
          className="grid size-11 place-items-center rounded-full text-foreground active:bg-secondary"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </button>
        <span className="text-sm font-medium">作者空间</span>
      </header>
      {works.isPending ? (
        <p role="status" className="py-10 text-center text-sm text-muted-foreground">
          正在加载作品…
        </p>
      ) : unavailable ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          暂时无法查看这个作者空间。
        </p>
      ) : !pages.length ? (
        <div role="alert" className="py-10 text-center text-sm text-muted-foreground">
          作品暂时没加载出来
          <button
            type="button"
            className="mx-auto block min-h-11 px-4 text-primary"
            onClick={() => void works.refetch()}
          >
            重新加载
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3.5 py-6">
            <span
              aria-hidden
              className="grid size-14 shrink-0 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-2xl font-medium text-primary"
            >
              {Array.from(pages[0]?.author_name ?? '')[0] || <BookOpen className="size-6" />}
            </span>
            <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">
              {pages[0]?.author_name}
            </h1>
          </div>
          <h2 className="mb-3 border-t border-border/60 pt-4 text-sm font-medium">公开角色卡</h2>
          {cards.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              作者暂时没有公开作品。
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {cards.map((card, index) => (
                <button
                  key={card.id}
                  type="button"
                  aria-label={`查看 ${card.name} 的详情`}
                  aria-describedby={`work-counts-${card.id}`}
                  onClick={() => {
                    setSelected(card);
                    setOpened(true);
                  }}
                  className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card text-left active:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div
                    className="relative aspect-[3/4] overflow-hidden"
                    style={{ background: characterRoomGradient(card.id) }}
                  >
                    {card.avatar_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt=""
                        src={supabasePublicImageUrl(card.avatar_url, {
                          width: 360,
                          height: 480,
                          quality: 68,
                        })}
                        loading={index < 2 ? 'eager' : 'lazy'}
                        className="size-full object-cover object-top"
                      />
                    )}
                  </div>
                  <span className="block px-3 pb-2.5 pt-2">
                    <span className="block truncate text-sm font-medium">{card.name}</span>
                    <span id={`work-counts-${card.id}`} className="sr-only">
                      {card.like_count} 个赞，{card.favorite_count} 次收藏
                    </span>
                    <span
                      aria-hidden
                      className="mt-1 flex items-center gap-3 text-[11px] leading-4 tabular-nums text-muted-foreground"
                    >
                      <span className="inline-flex items-center gap-1">
                        <Heart className="size-3 shrink-0" strokeWidth={1.65} />
                        {formatCompactCount(card.like_count)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Star className="size-3 shrink-0" strokeWidth={1.65} />
                        {formatCompactCount(card.favorite_count)}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {works.hasNextPage && (
            <button
              type="button"
              disabled={works.isFetching}
              onClick={() => void works.fetchNextPage()}
              className="mx-auto mt-4 flex min-h-11 items-center gap-2 px-5 text-sm text-primary"
            >
              {works.isFetchingNextPage && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {works.isFetchNextPageError
                ? '未能加载，点此重试'
                : works.isFetchingNextPage
                  ? '正在加载…'
                  : '查看更多作品'}
            </button>
          )}
        </>
      )}
      {opened && (
        <CharacterDetailSheet
          characterId={selected?.id ?? null}
          summary={selected ?? undefined}
          onClose={() => setSelected(null)}
          onEnter={(characterId, sessionId) => {
            rememberCreatorWorksScroll(id);
            router.push(chatEntryPath(characterId, { sessionId, source: `creator.${id}` }));
          }}
        />
      )}
    </main>
  );
}
