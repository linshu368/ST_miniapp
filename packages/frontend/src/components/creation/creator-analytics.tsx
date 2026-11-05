'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageCircle,
  Star,
  ThumbsUp,
  Users,
  X,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  CREATOR_ANALYTICS_PERIODS as ANALYTICS_PERIODS,
  type CreatorAnalyticsPeriod as AnalyticsPeriod,
  type CreatorAnalyticsCard,
  type CreatorAnalyticsWork,
  type CreatorAnalyticsReward,
  type CreatorAnalyticsFeedback,
} from '@miniapp/shared';
import { useCreatorAnalyticsQuery } from '@/lib/api/creator-analytics';
import { usePageReady } from '@/lib/perf/page-ready';

const displayDate = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
type ListPanel = 'works' | 'rewards' | 'feedback';
type Panel = 'characters' | ListPanel | null;
const SUMMARY_SIZE = 3;
const PAGE_SIZE = 4;
const SORT_OPTIONS = [
  { id: 'players', label: '使用人数' },
  { id: 'earned', label: '获得星尘' },
  { id: 'newest', label: '最近创作' },
] as const;
type Sort = (typeof SORT_OPTIONS)[number]['id'];

export function CreatorAnalytics({ preview = false }: { preview?: boolean }) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('all');
  const [cardId, setCardId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('players');
  const [sortOpen, setSortOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [pages, setPages] = useState<Record<Exclude<Panel, null>, number>>({
    works: 1,
    rewards: 1,
    feedback: 1,
    characters: 1,
  });
  const panelScroll = useRef<HTMLDivElement>(null);
  const workOrigin = useRef<{
    page: number;
    scroll: number;
    period: AnalyticsPeriod;
    sort: Sort;
  } | null>(null);
  const restoreWorkScroll = useRef<number | null>(null);
  const scope = { period, character_id: cardId ?? undefined, sort };
  const overviewQuery = useCreatorAnalyticsQuery({ ...scope, section: 'overview' });
  const overview = overviewQuery.data?.section === 'overview' ? overviewQuery.data : undefined;
  const selected = overview?.selected;
  const failed = overviewQuery.isError;
  const data = overview
    ? { ...overview.summary, rewards: overview.rewards, feedback: overview.feedback }
    : undefined;
  usePageReady('/creation/data', Boolean(data), false, failed);
  const cards = overview?.works ?? [];
  const periodLabel = ANALYTICS_PERIODS.find((item) => item.id === period)!.label;
  const currentPage = panel ? pages[panel] : 1;
  const listQuery = useCreatorAnalyticsQuery(
    {
      ...scope,
      character_id: panel === 'characters' ? undefined : scope.character_id,
      section: panel ?? 'works',
      page: currentPage,
      page_size: panel === 'characters' ? 8 : PAGE_SIZE,
      as_of: overview?.as_of,
    },
    Boolean(panel && overview)
  );
  const listData = listQuery.data;
  const total =
    listData && listData.section !== 'overview'
      ? listData.total
      : panel === 'works'
        ? (overview?.works_total ?? 0)
        : panel === 'rewards'
          ? (overview?.rewards_total ?? 0)
          : panel === 'characters'
            ? (overview?.card_count ?? 0)
            : (overview?.feedback_total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / (panel === 'characters' ? 8 : PAGE_SIZE)));
  const listWorks = listData?.section === 'works' ? listData.items : [];
  const listRewards = listData?.section === 'rewards' ? listData.items : [];
  const listFeedback = listData?.section === 'feedback' ? listData.items : [];
  const listCharacters = listData?.section === 'characters' ? listData.items : [];
  function changePage(page: number) {
    if (!panel) return;
    setPages((previous) => ({ ...previous, [panel]: page }));
    panelScroll.current?.scrollTo({ top: 0 });
  }
  function resetPages() {
    setPages({ works: 1, rewards: 1, feedback: 1, characters: 1 });
  }

  useEffect(() => {
    if (panel && listQuery.isSuccess && currentPage > pageCount) {
      setPages((previous) => ({ ...previous, [panel]: pageCount }));
    }
    if (panel === 'works' && listQuery.isSuccess && restoreWorkScroll.current !== null) {
      panelScroll.current?.scrollTo({ top: restoreWorkScroll.current });
      restoreWorkScroll.current = null;
    }
  }, [panel, currentPage, pageCount, listQuery.isSuccess]);

  function chooseCard(id: string | null) {
    if (id && panel === 'works' && cardId === null) {
      workOrigin.current = {
        page: currentPage,
        scroll: panelScroll.current?.scrollTop ?? 0,
        period,
        sort,
      };
    } else if (id) workOrigin.current = null;
    const origin = workOrigin.current;
    if (id === null && origin?.period === period && origin.sort === sort) {
      setPages({ works: origin.page, rewards: 1, feedback: 1, characters: 1 });
      restoreWorkScroll.current = origin.scroll;
    } else resetPages();
    setCardId(id);
    setPanel(null);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function cover(card: CreatorAnalyticsCard, className: string) {
    return card.cover_url ? (
      <img
        src={card.cover_url}
        alt=""
        className={cn('shrink-0 rounded-lg bg-secondary object-cover', className)}
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground',
          className
        )}
      >
        <Users className="size-5" />
      </span>
    );
  }

  const rewardRows = (rows: CreatorAnalyticsReward[]) =>
    rows.map((reward) => (
      <div
        key={reward.id}
        className="flex min-h-[68px] items-center justify-between gap-3 border-b border-border/40 py-3 last:border-0"
      >
        <div className="min-w-0">
          <p className="truncate text-[13px] text-foreground">{reward.name}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {displayDate(reward.occurred_at)} · {reward.amount < 0 ? '奖励调整' : '使用奖励'}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 text-base font-medium tabular-nums',
            reward.amount > 0 ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {reward.amount > 0 ? '+' : '−'}
          {number(Math.abs(reward.amount))}
        </span>
      </div>
    ));

  const feedbackRows = (rows: CreatorAnalyticsFeedback[], compact = false) =>
    rows.map((item) => (
      <article
        key={item.id}
        className="border-b border-border/40 py-4 first:pt-1 last:border-0 last:pb-0"
      >
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>{item.author}</span>
          <span>{displayDate(item.created_at)}</span>
        </div>
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/90',
            compact && 'line-clamp-3'
          )}
        >
          {item.body}
        </p>
        <button
          onClick={() => chooseCard(item.character_id)}
          className="-ml-1 mt-1 inline-flex min-h-11 max-w-full items-center gap-1 px-1 text-xs text-primary/80"
        >
          <span className="truncate">{item.name}</span>
          <ChevronRight className="size-3 shrink-0" aria-hidden />
        </button>
      </article>
    ));

  const cardRows = (rows: CreatorAnalyticsWork[]) =>
    rows.map((card) => (
      <button
        key={card.id}
        onClick={() => chooseCard(card.id)}
        aria-label={`查看${card.name}的数据`}
        className="flex min-h-[116px] w-full items-center gap-3 py-4 text-left"
      >
        {cover(card, 'h-[76px] w-[56px]')}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-medium">{card.name}</h3>
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {card.state === 'draft' ? '草稿' : card.visibility === 'private' ? '私密' : '公开'}
          </p>
          <div className="mt-2.5 grid grid-cols-3 gap-1">
            {[
              { label: '使用人数', value: card.stats.players },
              { label: '对话轮数', value: card.stats.rounds },
              { label: '获得星尘', value: card.stats.earned },
            ].map((item) => (
              <div key={item.label}>
                <p
                  className={cn(
                    'text-sm font-medium tabular-nums',
                    item.label === '获得星尘' && item.value > 0 && 'text-primary'
                  )}
                >
                  {number(item.value)}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </button>
    ));

  return (
    <main className="mx-auto w-full max-w-lg px-5 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-[calc(.5rem+env(safe-area-inset-top))]">
      <header className="-mx-2 mb-3 flex items-center justify-between gap-3">
        <Link
          href="/creation?tab=created"
          prefetch={false}
          aria-label="返回我的创作"
          className="inline-flex min-h-12 items-center gap-2 rounded-xl px-2"
        >
          <ArrowLeft className="size-5 text-muted-foreground" strokeWidth={1.7} aria-hidden />
          <h1 className="text-xl font-semibold tracking-tight">创作数据</h1>
        </Link>
        {preview ? (
          <span className="mr-2 rounded-md border border-border/70 px-2 py-1 text-[10px] text-muted-foreground">
            示例数据
          </span>
        ) : null}
      </header>

      {failed ? (
        <div
          role="alert"
          className="rounded-2xl border border-border bg-card px-5 py-12 text-center"
        >
          <p className="text-sm">暂时没能读取创作数据</p>
          <button
            onClick={() => void overviewQuery.refetch()}
            className="mt-5 min-h-11 rounded-xl bg-primary px-6 text-sm font-medium text-primary-foreground"
          >
            重新加载
          </button>
        </div>
      ) : !data ? (
        <div
          role="status"
          className="rounded-2xl bg-card px-5 py-16 text-center text-sm text-muted-foreground"
        >
          正在读取创作数据…
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-2">
            <button
              onClick={() => setPanel('characters')}
              aria-label="选择角色"
              className="-ml-2 inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium"
            >
              <span className="max-w-[140px] truncate min-[360px]:max-w-[180px]">
                {selected?.name ?? '全部角色'}
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
            {selected ? (
              <button
                onClick={() => chooseCard(null)}
                className="min-h-11 shrink-0 px-1 text-xs text-primary"
              >
                查看总览
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {overview?.card_count ?? 0} 个角色
              </span>
            )}
          </div>

          <div
            role="group"
            aria-label="统计时间"
            className="mb-5 grid grid-cols-3 rounded-xl bg-secondary/60 p-1"
          >
            {ANALYTICS_PERIODS.map((item) => (
              <button
                key={item.id}
                aria-pressed={period === item.id}
                onClick={() => {
                  setPeriod(item.id);
                  resetPages();
                }}
                className={cn(
                  'min-h-11 rounded-lg text-xs transition-colors',
                  period === item.id
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <section
            aria-label="创作总览"
            className="relative overflow-hidden rounded-[22px] border border-primary/20 bg-gradient-to-br from-accent via-card to-card p-5"
          >
            <div
              className="pointer-events-none absolute -right-12 -top-20 size-52 rounded-full bg-primary/[0.035]"
              aria-hidden
            />
            <div className="relative flex items-center justify-between gap-3">
              <h2 className="text-xs text-muted-foreground">{periodLabel}获得星尘</h2>
              <button
                onClick={() => setPanel('rewards')}
                className="-my-3 -mr-2 inline-flex min-h-11 items-center gap-0.5 px-2 text-[11px] text-primary/85"
              >
                奖励明细
                <ChevronRight className="size-3" aria-hidden />
              </button>
            </div>
            <p
              aria-label="获得星尘"
              className="relative mt-3 text-[44px] font-semibold leading-none tracking-[-.04em] text-primary tabular-nums"
            >
              {number(data.earned)}
            </p>
            <p className="relative mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>专项星尘</span>
              <span className="text-border">·</span>
              <span>
                今日{' '}
                <span className="text-primary">
                  {data.todayEarned >= 0 ? '+' : ''}
                  {number(data.todayEarned)}
                </span>
              </span>
            </p>
            <div className="relative mt-6 grid grid-cols-2 divide-x divide-primary/15 border-t border-primary/10 pt-4">
              <div>
                <p className="text-[11px] text-muted-foreground">使用人数</p>
                <p
                  aria-label="使用人数"
                  className="mt-1 text-2xl font-semibold tracking-tight tabular-nums"
                >
                  {number(data.players)}
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">人</span>
                </p>
              </div>
              <div className="pl-6">
                <p className="text-[11px] text-muted-foreground">对话轮数</p>
                <p
                  aria-label="对话轮数"
                  className="mt-1 text-2xl font-semibold tracking-tight tabular-nums"
                >
                  {number(data.rounds)}
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">轮</span>
                </p>
              </div>
            </div>
          </section>

          <section aria-labelledby="creator-engagement" className="mt-7">
            <h2 id="creator-engagement" className="text-base font-semibold">
              互动表现
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {[
                { label: '聊满10轮', value: data.deepPlayers },
                { label: '跨天回来玩', value: data.returningPlayers },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-2xl border border-border/65 bg-card/70 px-4 py-4"
                >
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="mt-2 text-[23px] font-semibold tabular-nums">
                    {number(item.value)}
                    <span className="ml-1 text-[11px] font-normal text-muted-foreground">人</span>
                  </p>
                  <div
                    role="img"
                    aria-label={`${item.label}${item.value}人，共${data.players}位玩家`}
                    className="mt-3 h-1 overflow-hidden rounded-full bg-secondary"
                  >
                    <div
                      className="h-full rounded-full bg-primary/65"
                      style={{ width: `${data.players ? (item.value / data.players) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-3 divide-x divide-border/60 py-1">
              {[
                { label: '当前获赞', value: data.likes, Icon: ThumbsUp },
                { label: '当前收藏', value: data.favorites, Icon: Star },
                { label: '公开评论', value: data.comments, Icon: MessageCircle },
              ].map(({ label, value, Icon }) => (
                <div key={label} className="text-center">
                  <p className="text-[15px] font-medium tabular-nums">{number(value)}</p>
                  <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Icon className="size-3" aria-hidden />
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="creator-works" className="mt-8">
            <div className="mb-1 flex min-h-11 items-center justify-between gap-3">
              <h2 id="creator-works" className="text-base font-semibold">
                {selected ? '角色表现' : '作品表现'}
              </h2>
              <div className="flex items-center gap-2">
                {!selected && cards.length > 0 ? (
                  <Sheet open={sortOpen} onOpenChange={setSortOpen}>
                    <SheetTrigger asChild>
                      <button
                        aria-label="作品排序"
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1.5 text-xs text-muted-foreground active:text-foreground"
                      >
                        {SORT_OPTIONS.find((item) => item.id === sort)!.label}
                        {overviewQuery.isPlaceholderData ? (
                          <Loader2 aria-label="正在排序" className="size-3.5 animate-spin" />
                        ) : (
                          <ChevronDown className="size-3.5" aria-hidden />
                        )}
                      </button>
                    </SheetTrigger>
                    <SheetContent
                      side="bottom"
                      className="mx-auto max-w-lg rounded-t-3xl border-border bg-popover px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-6"
                    >
                      <SheetTitle className="text-base font-semibold">作品排序</SheetTitle>
                      <SheetDescription className="sr-only">选择作品的排列方式</SheetDescription>
                      <button
                        aria-label="关闭排序"
                        onClick={() => setSortOpen(false)}
                        className="absolute right-3 top-3 grid size-11 place-items-center rounded-full text-muted-foreground active:bg-secondary"
                      >
                        <X className="size-[18px]" aria-hidden />
                      </button>
                      <div className="mt-4 space-y-1" role="group" aria-label="排序方式">
                        {SORT_OPTIONS.map((item) => (
                          <button
                            key={item.id}
                            aria-pressed={sort === item.id}
                            onClick={() => {
                              setSortOpen(false);
                              if (item.id === sort) return;
                              setSort(item.id);
                              setPages((previous) => ({ ...previous, works: 1 }));
                            }}
                            className={cn(
                              'flex min-h-14 w-full items-center justify-between rounded-xl px-4 text-sm transition-colors active:bg-secondary',
                              sort === item.id
                                ? 'bg-primary/10 font-medium text-primary'
                                : 'text-foreground/85'
                            )}
                          >
                            {item.label}
                            {sort === item.id ? (
                              <Check className="size-[18px]" aria-hidden />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </SheetContent>
                  </Sheet>
                ) : null}
                {!selected && (overview?.works_total ?? 0) > SUMMARY_SIZE ? (
                  <button
                    aria-label="查看全部作品"
                    onClick={() => setPanel('works')}
                    className="inline-flex min-h-11 items-center gap-0.5 pl-1 text-xs text-muted-foreground"
                  >
                    全部
                    <ChevronRight className="size-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
            {cards.length ? (
              <div className="divide-y divide-border/50">
                {cardRows(cards.slice(0, SUMMARY_SIZE))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border px-5 py-9 text-center">
                <Users
                  className="mx-auto mb-3 size-6 text-muted-foreground"
                  strokeWidth={1.4}
                  aria-hidden
                />
                <p className="text-sm text-foreground">第一位玩家，从你的第一个角色开始</p>
                <Link
                  href="/creation/characters/new"
                  className="mt-4 inline-flex min-h-11 items-center gap-1 text-sm text-primary"
                >
                  创作角色
                  <ChevronRight className="size-4" aria-hidden />
                </Link>
              </div>
            )}
          </section>

          <Link
            href="/wishes?from=creator-data"
            className="mt-5 flex min-h-16 items-center justify-between gap-3 rounded-2xl border border-primary/15 bg-primary/[0.05] px-4 py-3 active:bg-primary/10"
          >
            <span>
              <span className="block text-sm font-medium text-foreground">看看玩家想玩什么</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                去心愿墙找下一个创作灵感
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-primary" aria-hidden />
          </Link>

          <section
            aria-labelledby="creator-rewards"
            className="mt-7 border-t border-border/60 pt-5"
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 id="creator-rewards" className="text-base font-semibold">
                奖励记录
              </h2>
              <button
                aria-label="查看全部奖励"
                onClick={() => setPanel('rewards')}
                className="-mr-2 inline-flex min-h-11 items-center gap-0.5 px-2 text-xs text-muted-foreground"
              >
                全部
                <ChevronRight className="size-3" aria-hidden />
              </button>
            </div>
            {data.rewards.length ? (
              rewardRows(data.rewards.slice(0, SUMMARY_SIZE))
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {period === 'all' ? '暂无奖励记录' : '这段时间暂无奖励记录'}
              </p>
            )}
          </section>

          <section
            aria-labelledby="creator-feedback"
            className="mt-7 border-t border-border/60 pt-5"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 id="creator-feedback" className="text-base font-semibold">
                玩家反馈
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {overview?.feedback_total ?? 0}
                </span>
              </h2>
              <button
                aria-label="查看全部反馈"
                onClick={() => setPanel('feedback')}
                className="-mr-2 inline-flex min-h-11 items-center gap-0.5 px-2 text-xs text-muted-foreground"
              >
                全部
                <ChevronRight className="size-3" aria-hidden />
              </button>
            </div>
            {data.feedback.length ? (
              feedbackRows(data.feedback.slice(0, SUMMARY_SIZE), true)
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {period === 'all' ? '还没有公开评论' : '这段时间暂无公开评论'}
              </p>
            )}
          </section>
        </>
      )}

      <Sheet
        open={panel !== null}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
      >
        <SheetContent
          side="bottom"
          className={cn(
            'mx-auto flex max-h-[85svh] max-w-lg flex-col overflow-hidden rounded-t-3xl border-border bg-popover px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-6',
            pageCount > 1 && 'h-[85svh]'
          )}
        >
          <SheetTitle className="text-lg">
            {panel === 'characters'
              ? '选择角色'
              : panel === 'works'
                ? '全部作品'
                : panel === 'rewards'
                  ? '奖励明细'
                  : '玩家反馈'}
          </SheetTitle>
          <button
            type="button"
            aria-label="关闭面板"
            onClick={() => setPanel(null)}
            className="absolute right-3 top-3 grid size-11 place-items-center rounded-full text-muted-foreground active:bg-secondary"
          >
            <X className="size-[18px]" strokeWidth={1.6} aria-hidden />
          </button>
          <SheetDescription className="mt-1 text-xs text-muted-foreground">
            {panel === 'characters'
              ? '查看全部作品，或专注某一个角色'
              : `${selected?.name ?? '全部角色'} · ${periodLabel} · ${total}条`}
          </SheetDescription>
          <div ref={panelScroll} className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {listQuery.isError ? (
              <div role="alert" className="py-8 text-center text-sm">
                <p>暂时没能读取记录</p>
                <button
                  onClick={() => void listQuery.refetch()}
                  className="mt-3 min-h-11 px-4 text-primary"
                >
                  重新加载记录
                </button>
              </div>
            ) : listQuery.isPending ? (
              <p role="status" className="py-10 text-center text-sm text-muted-foreground">
                正在读取…
              </p>
            ) : panel === 'characters' ? (
              <>
                <button
                  onClick={() => chooseCard(null)}
                  className="mb-2 flex min-h-14 w-full items-center gap-3 rounded-xl bg-secondary/60 px-3 text-left"
                >
                  <span className="grid size-9 place-items-center rounded-lg bg-primary/10">
                    <Users className="size-4 text-primary" aria-hidden />
                  </span>
                  <span className="flex-1 text-sm">全部角色</span>
                  {cardId === null ? <Check className="size-4 text-primary" aria-hidden /> : null}
                </button>
                {listCharacters.map((card) => (
                  <button
                    key={card.id}
                    onClick={() => chooseCard(card.id)}
                    className="flex min-h-[76px] w-full items-center gap-3 border-b border-border/40 py-3 text-left last:border-0"
                  >
                    {cover(card, 'h-12 w-9')}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{card.name}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {card.state === 'draft'
                          ? '草稿'
                          : card.visibility === 'private'
                            ? '私密'
                            : '公开'}
                      </span>
                    </span>
                    {cardId === card.id ? (
                      <Check className="size-4 text-primary" aria-hidden />
                    ) : null}
                  </button>
                ))}
              </>
            ) : panel === 'works' ? (
              <div className="divide-y divide-border/50">{cardRows(listWorks)}</div>
            ) : panel === 'rewards' ? (
              <>
                <div className="mb-2 flex items-baseline justify-between rounded-xl bg-secondary/50 px-4 py-3">
                  <span className="text-xs text-muted-foreground">获得专项星尘</span>
                  <strong className="text-xl font-semibold text-primary tabular-nums">
                    {number(data?.earned ?? 0)}
                  </strong>
                </div>
                {listRewards.length ? (
                  rewardRows(listRewards)
                ) : (
                  <p className="py-8 text-center text-xs text-muted-foreground">暂无奖励记录</p>
                )}
              </>
            ) : listFeedback.length ? (
              feedbackRows(listFeedback)
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {period === 'all' ? '还没有公开评论' : '这段时间暂无公开评论'}
              </p>
            )}
          </div>
          {panel && total > 0 ? (
            <nav
              aria-label="列表分页"
              className="mt-3 flex shrink-0 items-center justify-between gap-3 border-t border-border/70 pt-3"
            >
              <button
                onClick={() => changePage(currentPage - 1)}
                disabled={currentPage <= 1 || listQuery.isFetching}
                className="min-h-11 rounded-xl border border-border px-4 text-xs text-foreground disabled:opacity-30"
              >
                上一页
              </button>
              <span aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
                {currentPage} / {pageCount}
              </span>
              <button
                onClick={() => changePage(currentPage + 1)}
                disabled={currentPage >= pageCount || listQuery.isFetching}
                className="min-h-11 rounded-xl border border-primary/25 bg-primary/10 px-4 text-xs text-primary disabled:opacity-30"
              >
                下一页
              </button>
            </nav>
          ) : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}
