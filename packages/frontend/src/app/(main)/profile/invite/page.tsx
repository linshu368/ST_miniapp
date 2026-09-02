'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronLeft,
  Copy,
  Gem,
  Loader2,
  RefreshCw,
  RotateCw,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import type { InviteRewardRecord } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  useInviteCenterQuery,
  useInviteEntryStatusQuery,
  useInviteStatsQuery,
} from '@/lib/api/invite';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';
import { formatNumber } from '@/lib/utils/payment';

type InviteTab = 'invite' | 'stats';

const TABS: Array<{ id: InviteTab; label: string }> = [
  { id: 'invite', label: '邀请' },
  { id: 'stats', label: '数据中心' },
];

/** 奖励规则的用户可读文案；未识别的 rule_key 走兜底。 */
const RULE_LABELS: Record<string, string> = {
  invitee_registered: '新好友加入奖励',
  invitee_first_paid: '好友首次充值奖励',
};

export default function InviteCenterPage() {
  const router = useRouter();
  const goBack = useCallback(() => router.push('/profile'), [router]);
  useTelegramBackButton(goBack);

  const [tab, setTab] = useState<InviteTab>('invite');
  const entryStatus = useInviteEntryStatusQuery();
  // 入口开关关闭时不触发 center-view 副作用（不生成邀请码、不标记首次进入）。
  const centerEnabled = entryStatus.data?.entry_enabled === true;
  const center = useInviteCenterQuery(centerEnabled);
  const stats = useInviteStatsQuery(centerEnabled && tab === 'stats');

  const entryDisabled = entryStatus.isSuccess && !centerEnabled;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={goBack}
            className="rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="返回"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </Button>
          <h1 className="text-base font-bold tracking-wide">邀请中心</h1>
        </div>

        <div role="tablist" aria-label="邀请中心" className="flex gap-1 px-3">
          {TABS.map((item) => {
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(item.id)}
                className={cn(
                  'relative px-4 pb-2.5 pt-1 text-sm font-bold transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80'
                )}
              >
                {item.label}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </header>

      <section
        role="tabpanel"
        className="flex flex-1 flex-col px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+6.5rem)]"
      >
        {entryDisabled ? (
          <DisabledState />
        ) : tab === 'invite' ? (
          <InviteTabPanel center={center} />
        ) : (
          <StatsTabPanel stats={stats} />
        )}
      </section>
    </main>
  );
}

function DisabledState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
      <Gem className="h-8 w-8 text-muted-foreground/60" aria-hidden />
      <p className="text-[13px] font-medium text-muted-foreground">邀请活动暂未开启，敬请期待</p>
    </div>
  );
}

function InviteTabPanel({ center }: { center: ReturnType<typeof useInviteCenterQuery> }) {
  const { whisper, notification } = useHaptic();
  const data = center.data;

  // 文案 = 已发布模板 + {link} 占位替换；刷新在模板库中轮换并覆盖手动修改（PRD 拍板）。
  const templates = useMemo(() => data?.copy_templates ?? [], [data?.copy_templates]);
  const renderTemplate = useCallback(
    (template: string) => template.replaceAll('{link}', data?.invite_link ?? ''),
    [data?.invite_link]
  );

  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const templateIndexRef = useRef(0);
  const initializedRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (initializedRef.current || !data) return;
    initializedRef.current = true;
    const first = templates[0];
    setDraft(first ? renderTemplate(first) : (data.invite_link ?? ''));
  }, [data, templates, renderTemplate]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleRefresh = useCallback(() => {
    if (templates.length === 0) return;
    whisper();
    templateIndexRef.current = (templateIndexRef.current + 1) % templates.length;
    const next = templates[templateIndexRef.current];
    if (next !== undefined) setDraft(renderTemplate(next));
  }, [templates, renderTemplate, whisper]);

  const handleCopy = useCallback(() => {
    // 硬约束（阶段二计划 §10）：writeText 必须在点击同步栈内调用，前面不得插任何 await。
    navigator.clipboard
      .writeText(draft)
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // 非 https 或权限受限时静默（对齐 orders 页复制先例）。
        notification('error');
      });
  }, [draft, notification]);

  if (center.isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="aspect-[9/16] w-full rounded-[22px] border border-border bg-card" />
        <Skeleton className="h-28 rounded-[18px] border border-border bg-card" />
        <Skeleton className="h-12 rounded-[18px] border border-border bg-card" />
      </div>
    );
  }

  if (center.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
        <RefreshCw className="h-8 w-8 text-muted-foreground/60" aria-hidden />
        <p className="text-[13px] font-medium text-muted-foreground">邀请信息暂时无法加载</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void center.refetch()}
          className="rounded-full border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          重新加载
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {data.poster_url ? (
        <div className="overflow-hidden rounded-[22px] border border-border bg-card shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
          {/* 运营发布的邀请海报，2160×3840 成品比例 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={data.poster_url}
            alt="邀请海报"
            loading="lazy"
            className="aspect-[9/16] w-full object-cover"
          />
        </div>
      ) : null}

      <div className="flex items-stretch gap-2.5">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          aria-label="邀请文案与专属链接"
          className="min-h-[104px] flex-1 resize-none rounded-[18px] border-border bg-card text-[13px] leading-relaxed text-foreground focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={handleRefresh}
          disabled={templates.length === 0}
          aria-label="恢复为运营发布文案"
          className="flex w-12 shrink-0 items-center justify-center rounded-[18px] border border-border bg-card text-muted-foreground transition hover:border-primary/25 hover:bg-secondary hover:text-foreground disabled:opacity-40"
        >
          <RotateCw className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>

      <Button
        onClick={handleCopy}
        className="h-12 rounded-[18px] border-0 bg-gradient-to-r from-primary via-rose to-rose-fill text-[15px] font-black text-primary-foreground shadow-[0_10px_30px_hsl(var(--rose)/0.28)] transition hover:opacity-90"
      >
        {copied ? (
          <>
            <Check className="h-4 w-4" aria-hidden />
            已复制，去分享给好友吧
          </>
        ) : (
          <>
            <Copy className="h-4 w-4" aria-hidden />
            复制并分享
          </>
        )}
      </Button>

      {!data.invite_link ? (
        <p className="px-1 text-[11px] leading-relaxed text-destructive/80">
          专属链接暂时无法生成，请稍后重新进入本页。
        </p>
      ) : null}
    </div>
  );
}

function StatsTabPanel({ stats }: { stats: ReturnType<typeof useInviteStatsQuery> }) {
  const data = stats.data;

  if (stats.isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-24 rounded-[20px] border border-border bg-card" />
          <Skeleton className="h-24 rounded-[20px] border border-border bg-card" />
        </div>
        <Skeleton className="h-48 rounded-[22px] border border-border bg-card" />
      </div>
    );
  }

  if (stats.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
        <RefreshCw className="h-8 w-8 text-muted-foreground/60" aria-hidden />
        <p className="text-[13px] font-medium text-muted-foreground">邀请数据暂时无法加载</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void stats.refetch()}
          className="rounded-full border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          重新加载
        </Button>
      </div>
    );
  }

  const updatedAt = formatUpdatedAt(data.updated_at);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-[20px] border border-border bg-card px-4 py-4">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">
            累计邀请人数
          </p>
          <p className="mt-2 text-[28px] font-black leading-none tabular-nums text-foreground">
            {formatNumber(data.invited_count)}
          </p>
        </div>
        <div className="rounded-[20px] border border-primary/20 bg-card px-4 py-4">
          <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">
            累计获得星尘
          </p>
          <p className="mt-2 text-[28px] font-black leading-none tabular-nums text-primary">
            {formatNumber(data.total_reward_credits)}
          </p>
        </div>
      </div>

      <p className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            data.update_mode === 'realtime' ? 'bg-success' : 'bg-warn'
          )}
        />
        {data.update_mode === 'realtime'
          ? '邀请数据实时更新中'
          : `批量更新 · 最近更新 ${updatedAt}`}
      </p>

      <div className="rounded-[22px] border border-border bg-card px-4 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-bold text-foreground">最近到账</h2>
          <span className="text-[10px] text-muted-foreground/70">邀请关系与奖励记录</span>
        </div>

        {data.recent_rewards.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <UserPlus className="h-6 w-6 text-muted-foreground/50" aria-hidden />
            <p className="text-[12px] text-muted-foreground">
              还没有到账记录，快去邀请好友赚星尘吧
            </p>
          </div>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-border/60">
            {data.recent_rewards.map((record, index) => (
              <RewardRow key={`${record.granted_at}-${index}`} record={record} />
            ))}
          </ul>
        )}
      </div>

      <p className="px-1 text-center text-[10px] text-muted-foreground/60">
        数据更新时间 {updatedAt}
        {stats.isFetching ? (
          <Loader2 className="ml-1 inline h-3 w-3 animate-spin align-[-2px]" aria-hidden />
        ) : null}
      </p>
    </div>
  );
}

function RewardRow({ record }: { record: InviteRewardRecord }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {record.rule_key === 'invitee_registered' ? (
          <UserPlus className="h-4 w-4" aria-hidden />
        ) : (
          <Sparkles className="h-4 w-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-foreground">
          {RULE_LABELS[record.rule_key] ?? record.rule_key}
        </span>
        <span className="mt-0.5 block text-[10px] text-muted-foreground">
          {formatGrantedAt(record.granted_at)} · 已计入邀请数据
        </span>
      </span>
      <span className="shrink-0 text-[14px] font-black tabular-nums text-primary">
        +{formatNumber(record.credits)}
      </span>
    </li>
  );
}

function formatGrantedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
