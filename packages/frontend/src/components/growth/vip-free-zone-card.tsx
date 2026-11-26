'use client';

import { ArrowLeftRight } from 'lucide-react';
import { freeZoneWeekdayLabel, type VipGrowthPrompt, type VipPromptContext } from '@miniapp/shared';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort } from '@/lib/utils/payment';

const EYEBROW: Record<VipPromptContext, string> = {
  trial_ended: '新人畅聊体验已结束',
  welfare_ended: '畅聊福利期已结束',
  vip_day: '今天是 VIP 畅聊日',
};

/** 票券两半之间的打孔线：左右两个缺口用遮罩底色挖出来 */
const PERFORATION =
  "relative -mx-[22px] my-[18px] border-t-[1.5px] border-dashed border-[#d9b48a]/30 before:absolute before:-left-[11px] before:-top-[10px] before:size-5 before:rounded-full before:bg-[var(--scrim-notch)] before:content-[''] after:absolute after:-right-[11px] after:-top-[10px] after:size-5 after:rounded-full after:bg-[var(--scrim-notch)] after:content-['']";

function Ticket(props: {
  tone: 'chat' | 'gold';
  label: string;
  big: string;
  unit?: string;
  caption: string[];
}) {
  const chat = props.tone === 'chat';
  return (
    <div
      className={cn(
        'rounded-2xl border px-2 pb-3 pt-3.5',
        chat ? 'border-free-zone/40 bg-free-zone/[0.08]' : 'border-[#d9b48a]/40 bg-[#d9b48a]/[0.08]'
      )}
    >
      <p className={cn('text-xs font-semibold', chat ? 'text-free-zone' : 'text-[#d9b48a]')}>
        {props.label}
      </p>
      <p className="mt-2 flex items-baseline justify-center gap-0.5">
        <span
          className={cn(
            'bg-clip-text text-[40px] font-extrabold leading-none tracking-tight text-transparent tabular-nums',
            chat
              ? 'bg-gradient-to-b from-[#d4f0fe] via-free-zone to-[#3d9fd0]'
              : 'bg-gradient-to-b from-[#f6dcb2] via-[#d9b48a] to-[#b8875a]'
          )}
        >
          {props.big}
        </span>
        {props.unit ? (
          <span
            className={cn('text-xl font-extrabold', chat ? 'text-free-zone' : 'text-[#d9b48a]')}
          >
            {props.unit}
          </span>
        ) : null}
      </p>
      <p className="mt-2 text-[11.5px] leading-normal text-[#cfc4c9]">
        {props.caption.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * VIP 弹窗（对比稿 A「并排双券」）：免费畅聊与赠送星尘两块等大，主按钮一键去开通，「以后再说」压暗。
 * 「刚结束」场景底部带一行切换提示（用户这一轮已经被切到付费模型）。
 */
export function VipFreeZoneCard({
  prompt,
  context,
  switchNote,
  onAccept,
  onDismiss,
}: {
  prompt: VipGrowthPrompt;
  context: VipPromptContext;
  /** 「已切换到轻量模型继续聊 · 每轮 15 星尘」；畅聊日场景不传 */
  switchNote: string | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const perDay = (prompt.price_cents / 100 / prompt.duration_days).toFixed(2);
  const welcomeDays = prompt.welcome_days ?? 0;
  const weekday = prompt.vip_day ? freeZoneWeekdayLabel(prompt.vip_day.weekday) : null;
  const main = prompt.bonus_main_credits ?? 0;
  const special = prompt.bonus_credits - main;
  const vipDay = context === 'vip_day';
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onDismiss())}>
      <DialogContent
        showCloseButton={false}
        data-growth-prompt="vip"
        data-vip-context={context}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="dark w-[calc(100%-56px)] max-w-[340px] gap-0 rounded-[26px] border border-[#d9b48a]/40 bg-[linear-gradient(180deg,#33281f,#261f25_42%)] px-[22px] pb-2.5 pt-[26px] text-center shadow-[0_24px_60px_rgba(0,0,0,0.55),0_0_60px_rgba(217,165,105,0.12)] sm:rounded-[26px]"
      >
        <p className="text-xs text-[#a5959e]">{EYEBROW[context]}</p>
        <DialogTitle className="mt-2.5 text-[21px] font-bold text-[#ece3e7]">
          {vipDay ? '开通 VIP，今天就畅聊' : '开通 VIP，畅聊继续'}
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-[13px] text-[#a5959e]">
          {prompt.duration_days} 天会员 · 平均每天 ¥{perDay}
        </DialogDescription>
        <div aria-hidden className={PERFORATION} />
        <div className="grid grid-cols-2 gap-2.5">
          {welcomeDays > 0 ? (
            <Ticket
              tone="chat"
              label="免费畅聊"
              big={String(welcomeDays)}
              unit="天"
              caption={['开通立享', weekday ? `之后每${weekday}畅聊` : '之后每周畅聊']}
            />
          ) : (
            <Ticket
              tone="chat"
              label="免费畅聊"
              big={weekday ?? '每周'}
              caption={['会员每周畅聊日']}
            />
          )}
          <Ticket
            tone="gold"
            label="赠送星尘"
            big={formatNumber(prompt.bonus_credits)}
            caption={
              main > 0
                ? [`${formatNumber(special)} 专项`, `+ ${formatNumber(main)} 通用`]
                : ['开通立得']
            }
          />
        </div>
        <button
          type="button"
          onClick={onAccept}
          className={cn(
            'growth-cta-sheen relative mt-[18px] flex h-[54px] w-full items-center justify-center overflow-hidden rounded-2xl text-[17px] font-extrabold tracking-wide text-[#2a1c10] transition-transform active:scale-[0.98]',
            'bg-[linear-gradient(180deg,#f2d4a7,#d7ac78_60%,#c4935f)] shadow-[0_10px_28px_rgba(217,165,105,0.35),inset_0_1px_0_rgba(255,255,255,0.55)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f2d4a7] focus-visible:ring-offset-2 focus-visible:ring-offset-[#261f25]'
          )}
        >
          {vipDay ? '开通 VIP，立即畅聊' : '开通 VIP，继续畅聊'}
          <span className="ml-1.5 text-[13px] font-semibold opacity-75">
            ¥{formatYuanShort(prompt.price_cents)}
          </span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="mx-auto mt-1 block min-h-11 px-5 text-[13px] text-[#948790] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          以后再说
        </button>
        {switchNote ? (
          <p className="mb-1.5 flex items-center justify-center gap-1.5 text-[11px] text-[#a5959e]">
            <ArrowLeftRight className="size-3" aria-hidden />
            {switchNote}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
