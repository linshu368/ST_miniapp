'use client';

import type { ReactNode } from 'react';
import { Send } from 'lucide-react';
import type { GrowthPrompt } from '@miniapp/shared';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort } from '@/lib/utils/payment';

interface CardContent {
  eyebrow: string;
  amount: number;
  title: string;
  sub: string;
  chips: ReactNode[];
  cta: ReactNode;
}

function contentFor(prompt: GrowthPrompt): CardContent {
  if (prompt.kind === 'community') {
    return {
      eyebrow: '官方社群福利',
      amount: prompt.reward_credits,
      title: '进官方社群就送',
      sub: '一键进群，奖励自动到账',
      chips: [],
      cta: (
        <>
          <Send className="mr-2 size-[18px]" aria-hidden />
          立即进群领取
        </>
      ),
    };
  }
  const perDay = (prompt.price_cents / 100 / prompt.duration_days).toFixed(2);
  const monthMax = prompt.bonus_credits + prompt.checkin_daily_credits * prompt.duration_days;
  return {
    eyebrow: 'VIP 月卡',
    amount: prompt.bonus_credits,
    title: '开通立得',
    sub: `${prompt.duration_days} 天会员 · 平均每天 ¥${perDay}`,
    chips: [
      <>
        每天签到 <b>{formatNumber(prompt.checkin_daily_credits)}</b> 星尘
      </>,
      <>
        解锁<b>标准·旗舰</b>引擎
      </>,
      <>
        天天签到，{prompt.duration_days} 天最多 <b>{formatNumber(monthMax)}</b> 星尘
      </>,
    ],
    cta: (
      <>
        立即开通
        <span className="ml-1.5 text-[13px] font-semibold opacity-75">
          ¥{formatYuanShort(prompt.price_cents)}
        </span>
      </>
    ),
  };
}

/**
 * 居中礼券（对比稿 B）：奖励数字最醒目，主按钮金色带光泽，「以后再说」压暗。
 * 不显示与用户无关的轮数；遮罩不用模糊，动效只有缩放与透明度。
 */
export function GrowthPromptCard({
  prompt,
  fallbackHandle,
  onAccept,
  onDismiss,
}: {
  prompt: GrowthPrompt;
  /** 打不开 Telegram 链接时提示手动搜索的账号 */
  fallbackHandle: string | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const content = contentFor(prompt);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onDismiss())}>
      <DialogContent
        showCloseButton={false}
        data-growth-prompt={prompt.kind}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-[calc(100%-56px)] max-w-[340px] gap-0 rounded-[26px] border border-[#d9b48a]/40 bg-[linear-gradient(180deg,#33281f,#261f25_42%)] px-[22px] pb-3 pt-[26px] text-center shadow-[0_24px_60px_rgba(0,0,0,0.55),0_0_60px_rgba(217,165,105,0.12)] sm:rounded-[26px]"
      >
        <p className="text-xs text-[#a5959e]">{content.eyebrow}</p>
        <p className="mt-3 flex items-baseline justify-center gap-1.5">
          <span className="bg-gradient-to-b from-[#f6dcb2] via-[#d9b48a] to-[#b8875a] bg-clip-text text-[64px] font-extrabold leading-none tracking-tight text-transparent tabular-nums">
            {formatNumber(content.amount)}
          </span>
          <span className="text-base font-semibold text-[#d9b48a]">星尘</span>
        </p>
        <DialogTitle className="mt-2 text-[19px] font-bold text-[#ece3e7]">
          {content.title}
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-[13px] text-[#a5959e]">
          {content.sub}
        </DialogDescription>
        <div
          aria-hidden
          className="relative -mx-[22px] mb-[18px] mt-[18px] border-t-[1.5px] border-dashed border-[#d9b48a]/30 before:absolute before:-left-[11px] before:-top-[10px] before:size-5 before:rounded-full before:bg-[#0f0d0e] before:content-[''] after:absolute after:-right-[11px] after:-top-[10px] after:size-5 after:rounded-full after:bg-[#0f0d0e] after:content-['']"
        />
        {content.chips.length > 0 ? (
          <ul className="mb-[18px] flex flex-wrap justify-center gap-1.5">
            {content.chips.map((chip, index) => (
              <li
                key={index}
                className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-xs text-[#ece3e7] [&_b]:font-semibold [&_b]:text-[#d9b48a]"
              >
                {chip}
              </li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          onClick={onAccept}
          className={cn(
            'growth-cta-sheen relative flex h-[54px] w-full items-center justify-center overflow-hidden rounded-2xl text-[17px] font-extrabold tracking-wide text-[#2a1c10] transition-transform active:scale-[0.98]',
            'bg-[linear-gradient(180deg,#f2d4a7,#d7ac78_60%,#c4935f)] shadow-[0_10px_28px_rgba(217,165,105,0.35),inset_0_1px_0_rgba(255,255,255,0.55)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2d4a7] focus-visible:ring-offset-2 focus-visible:ring-offset-[#261f25]'
          )}
        >
          {content.cta}
        </button>
        {fallbackHandle ? (
          <p role="status" className="mt-3 text-xs leading-5 text-[#a5959e]">
            没能打开社群，请在 Telegram 搜索{' '}
            <strong className="text-[#ece3e7]">{fallbackHandle}</strong>
          </p>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          className="mx-auto mt-1 block min-h-11 px-5 text-[13px] text-[#7d7178] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          以后再说
        </button>
      </DialogContent>
    </Dialog>
  );
}
