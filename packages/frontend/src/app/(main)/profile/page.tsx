'use client';

import Link from 'next/link';
import { ChevronRight, Settings, Sparkles } from 'lucide-react';

import { mockCurrentUser } from '@/lib/mock-data';
import { useMockWalletCredits } from '@/lib/api/payment';
import { formatNumber } from '@/lib/utils/payment';

export default function ProfilePage() {
  const user = mockCurrentUser;
  // 实时订阅 mock 钱包余额，聊天扣费 / 充值到账都会即时反映
  const credits = useMockWalletCredits();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10 pt-[env(safe-area-inset-top)]">
      {/* 顶部 bar：左=合并 pill（星尘数 + 商店入口），右=设置 */}
      <header className="flex items-center justify-between py-3">
        <Link
          href="/profile/recharge"
          aria-label={`当前星尘 ${credits}，前往星尘商店`}
          className="animate-stardust-pulse inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-gradient-to-r from-sky-500/10 via-card/60 to-indigo-500/10 px-3.5 py-2 text-sm transition-colors duration-300 hover:border-sky-400/60 hover:[animation-play-state:paused] hover:shadow-[0_0_26px_-4px_rgba(56,189,248,0.7),inset_0_0_16px_-3px_rgba(56,189,248,0.4)]"
        >
          <Sparkles
            className="h-4 w-4 text-sky-300 drop-shadow-[0_0_4px_rgba(56,189,248,0.7)]"
            aria-hidden
          />
          <span className="font-semibold tabular-nums">{formatNumber(credits)}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-foreground/85">星尘商店</span>
          <ChevronRight className="h-3.5 w-3.5 text-sky-300/80" aria-hidden />
        </Link>
        <Link
          href="/profile/settings"
          aria-label="设置"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-card hover:text-foreground"
        >
          <Settings className="h-5 w-5" aria-hidden />
        </Link>
      </header>

      {/* 身份：页面重心；第二入口已合并进 pill，下方保持留白 */}
      <section className="mt-10 flex flex-col items-center gap-3">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 via-purple-500 to-blue-500 text-3xl font-black text-white">
          {user.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold">{user.username}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground/70">ID · {user.tg_id}</div>
        </div>
      </section>
    </main>
  );
}
