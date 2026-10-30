'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { ArrowUpRight, ChevronRight, ImagePlus, Star, UserRoundPen } from 'lucide-react';

import { CharacterCard } from '@/components/characters/character-card';
import {
  CharacterDetailSheet,
  type CharacterDetailTab,
} from '@/components/characters/character-detail-sheet';
import { CreatedCharacters } from './created-characters';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useFavoritesQuery } from '@/lib/api/favorites';
import { useCharacterSocialsQuery } from '@/lib/api/character-social';
import { chatEntryPath } from '@/lib/chat-entry';
import { cn } from '@/lib/utils';

export function CreationHub() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = searchParams.get('tab') === 'created' ? 'created' : 'favorites';
  const [benefitsOpen, setBenefitsOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; tab: CharacterDetailTab } | null>(null);
  const favorites = useFavoritesQuery();
  const cards = favorites.data?.characters ?? [];
  useCharacterSocialsQuery(
    cards.map((card) => card.id),
    tab === 'favorites'
  );
  const openCharacter = useCallback((id: string) => setPreview({ id, tab: 'intro' }), []);
  const openComments = useCallback((id: string) => setPreview({ id, tab: 'comments' }), []);

  return (
    <main className="mx-auto min-h-[70svh] w-full max-w-lg px-4 pb-7 pt-[calc(1.25rem+env(safe-area-inset-top))] sm:px-5">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">创作</h1>
      </header>

      <section aria-label="创作入口" className="space-y-3">
        <article className="relative overflow-hidden rounded-[22px] border border-primary/25 bg-gradient-to-br from-accent via-card to-card p-5">
          <div
            className="pointer-events-none absolute -right-10 -top-16 size-48 rounded-full bg-primary/5"
            aria-hidden
          />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
                <UserRoundPen className="size-5 text-primary" strokeWidth={1.5} aria-hidden />
                创作角色卡
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                写下想法，AI 帮你完善角色
              </p>
            </div>
            <button
              type="button"
              onClick={() => setBenefitsOpen(true)}
              className="-mr-2 -mt-2 inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg px-2 text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              创作权益
              <ChevronRight className="size-3" aria-hidden />
            </button>
          </div>

          <div className="relative my-5 grid grid-cols-2 divide-x divide-primary/15">
            <div className="pr-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">他人使用消耗星尘</p>
              <p className="mt-1 flex items-baseline gap-1.5 text-primary">
                <strong className="text-[30px] font-semibold leading-tight tracking-[-0.045em] min-[360px]:text-[34px]">
                  40<span className="ml-0.5 text-xl">%</span>
                </strong>
                <span className="whitespace-nowrap text-[11px]">奖励给你</span>
              </p>
            </div>
            <div className="pl-4">
              <p className="text-[11px] leading-relaxed text-muted-foreground">使用自己的角色</p>
              <p className="mt-1 flex items-baseline gap-1.5 text-primary">
                <strong className="text-[30px] font-semibold leading-tight tracking-[-0.045em] min-[360px]:text-[34px]">
                  8<span className="ml-1 text-xl">折</span>
                </strong>
                <span className="whitespace-nowrap text-[11px]">全部模型</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => router.push('/creation/characters/new')}
            className="relative flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors active:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          >
            开始创作角色
            <ArrowUpRight className="size-4" strokeWidth={1.8} aria-hidden />
          </button>
        </article>

        <Link
          href="/create"
          prefetch={false}
          className="flex min-h-[66px] items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 transition-colors active:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary">
            <ImagePlus className="size-5 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block text-[13px] font-medium text-foreground">图片与视频</strong>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">AI 生成与作品广场</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
      </section>

      <section aria-labelledby="creation-space-title" className="mt-7">
        <h2
          id="creation-space-title"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          我的空间
        </h2>
        <nav aria-label="空间分类" className="mb-5 mt-2 flex gap-6 border-b border-border/60">
          {(
            [
              { key: 'favorites', label: '收藏' },
              { key: 'created', label: '我的创作' },
            ] as const
          ).map((item) => (
            <Link
              key={item.key}
              href={`/creation?tab=${item.key}`}
              replace
              scroll={false}
              prefetch={false}
              aria-current={tab === item.key ? 'page' : undefined}
              className={cn(
                'relative flex min-h-12 items-center py-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === item.key ? 'font-semibold text-primary' : 'text-muted-foreground'
              )}
            >
              {item.label}
              {tab === item.key && (
                <span
                  className="absolute inset-x-0 bottom-[-1px] h-0.5 rounded-full bg-primary"
                  aria-hidden
                />
              )}
            </Link>
          ))}
        </nav>

        {tab === 'favorites' ? (
          <div aria-label="收藏的角色">
            {favorites.isPending ? (
              <div className="grid grid-cols-2 gap-3" role="status" aria-label="正在读取收藏">
                {[0, 1, 2, 3].map((key) => (
                  <div
                    key={key}
                    className="aspect-[3/4] animate-pulse rounded-2xl bg-white/[0.035] motion-reduce:animate-none"
                  />
                ))}
              </div>
            ) : favorites.isError ? (
              <div className="rounded-2xl border border-border/70 px-5 py-10 text-center">
                <p className="text-sm text-foreground" role="alert">
                  暂时没能加载收藏
                </p>
                <button
                  type="button"
                  onClick={() => void favorites.refetch()}
                  disabled={favorites.isFetching}
                  className="mt-4 min-h-11 rounded-xl border border-border px-5 text-sm text-primary disabled:opacity-50"
                >
                  {favorites.isFetching ? '重试中…' : '重新加载'}
                </button>
              </div>
            ) : cards.length ? (
              <div className="grid grid-cols-2 items-start gap-3">
                {cards.map((character, index) => (
                  <CharacterCard
                    key={character.id}
                    character={character}
                    onSelect={openCharacter}
                    onComments={openComments}
                    priority={index < 2}
                  />
                ))}
              </div>
            ) : (
              <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
                <Star className="mb-4 size-8 text-muted-foreground" strokeWidth={1.35} aria-hidden />
                <h3 className="text-sm font-medium text-foreground">喜欢的角色，收藏在这里</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  找到喜欢的角色，下次就能直接回来。
                </p>
                <Link
                  href="/characters"
                  className="mt-5 flex min-h-11 items-center rounded-xl border border-border bg-secondary/50 px-5 text-xs text-primary"
                >
                  去发现角色
                </Link>
              </div>
            )}
          </div>
        ) : (
          <CreatedCharacters />
        )}
      </section>

      <CharacterDetailSheet
        characterId={preview?.id ?? null}
        summary={cards.find((card) => card.id === preview?.id)}
        initialTab={preview?.tab}
        onClose={() => setPreview(null)}
        onEnter={(id, sessionId) => router.push(chatEntryPath(id, { sessionId, source: 'space' }))}
      />
      <Sheet open={benefitsOpen} onOpenChange={setBenefitsOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-w-lg rounded-t-3xl border-border bg-popover px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-7"
        >
          <SheetTitle className="text-lg text-foreground">角色创作权益</SheetTitle>
          <SheetDescription className="mt-2 text-xs leading-6 text-muted-foreground">
            属于角色创作者的两项回报
          </SheetDescription>
          <div className="my-6 space-y-5">
            <section>
              <h3 className="text-sm font-medium text-primary">他人使用，获得 40% 星尘奖励</h3>
              <p className="mt-2 text-[13px] leading-7 text-muted-foreground">
                其他用户使用你的角色卡并消耗星尘，你可获得该次实际消耗的 40% 作为专项星尘奖励。
              </p>
              <p className="mt-2 rounded-xl bg-white/[0.035] px-3 py-2 text-xs leading-6 text-foreground/80">
                例如：他人消耗 100 星尘，你获得 40 星尘。
              </p>
            </section>
            <section className="border-t border-border/60 pt-5">
              <h3 className="text-sm font-medium text-primary">使用自己的角色 8 折</h3>
              <p className="mt-2 text-[13px] leading-7 text-muted-foreground">
                使用自己创作的角色卡聊天，全部模型享受 8 折优惠。与 VIP 优惠取更低价格，不叠加。
              </p>
            </section>
          </div>
          <button
            type="button"
            onClick={() => setBenefitsOpen(false)}
            className="min-h-12 w-full rounded-xl border border-border bg-primary/10 text-sm text-primary"
          >
            知道了
          </button>
        </SheetContent>
      </Sheet>
    </main>
  );
}
