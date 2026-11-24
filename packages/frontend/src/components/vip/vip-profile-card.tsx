'use client';

import type { ReactNode } from 'react';
import type { VipPlan, VipStatus } from '@miniapp/shared';
import { ChevronRight, Crown, Loader2 } from 'lucide-react';

import { useModelCatalogQuery } from '@/lib/api/models';
import { vipFreeChatTerms, type VipFreeChatTerms } from '@/lib/free-zone';
import { cn } from '@/lib/utils';
import { formatNumber, formatYuanShort } from '@/lib/utils/payment';
import { vipCheckinRewardLabel, vipPlanRewardLabel } from '@/lib/vip/rewards';
import { formatDiscountLabel, vipEntryExpiryLabel } from '@/lib/vip/presentation';

interface VipProfileCardProps {
  status: VipStatus | undefined;
  monthlyPlan: VipPlan | undefined;
  loading: boolean;
  disabled: boolean;
  onOpen: () => void;
}

/**
 * 「我的」页 VIP 卡。未开通：免费畅聊与开通赠星尘两张等大的券并排（同 VIP 弹窗「并排双券」），
 * 按钮在底部和价格同一行；已开通：身份、有效期，权益行带上此刻的畅聊状态。
 */
export function VipProfileCard(props: VipProfileCardProps) {
  const { status, monthlyPlan, loading, disabled } = props;
  // 免费畅聊权益（开通礼天数、每周畅聊日、会员此刻的状态）取模型目录里的畅聊规则；
  // 福利期或没有按身份开放时为 null，卡片回到只有星尘的样子
  const catalog = useModelCatalogQuery();
  const freeChat = vipFreeChatTerms(catalog.data?.free_zone);
  const active = status?.active === true;
  const benefits = status?.benefits;
  const bonus = (monthlyPlan?.bonus_credits ?? 0) + (monthlyPlan?.bonus_main_credits ?? 0);
  const tickets = !active && freeChat !== null;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      disabled={disabled || (!active && loading)}
      aria-label={active ? '查看 VIP 权益与续费' : '开通 VIP，查看月卡权益'}
      className="dark group relative w-full overflow-hidden rounded-[22px] border border-[#d8bca0]/20 bg-[linear-gradient(120deg,#332b2b,#272126_65%,#30262c)] px-5 pb-4 pt-4 text-left text-[#eed7bf] transition-colors hover:border-[#d8bca0]/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d7b4bf] disabled:opacity-60 motion-reduce:transition-none"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full border border-[#eed7bf]/[0.07] shadow-[0_0_0_20px_rgb(238_215_191/0.025),0_0_0_40px_rgb(238_215_191/0.02)]"
      />
      <span className="relative flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2">
          <Crown className="size-4" strokeWidth={1.5} aria-hidden />
          <span className="text-[11px] font-medium tracking-[0.12em]">
            {active ? '秘境 · VIP' : 'VIP 月卡'}
          </span>
        </span>
        <span className="text-[10px] text-[#bda99c]">{active ? '权益生效中' : '会员开通礼'}</span>
      </span>
      {tickets ? (
        <OfferTickets freeChat={freeChat} monthlyPlan={monthlyPlan} bonus={bonus} />
      ) : (
        <span className="relative mt-4 flex items-center justify-between gap-3">
          <Headline active={active} status={status} bonus={bonus} />
          <OpenButton active={active} busy={loading || disabled} />
        </span>
      )}
      <span className="relative mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#eed7bf]/10 pt-3 text-[11px] leading-5 text-[#c9b5a6]">
        {typeof benefits?.checkin_vip_credits === 'number' && benefits.checkin_vip_credits > 0 ? (
          <Benefit label="每日签到">{vipCheckinRewardLabel(benefits)}</Benefit>
        ) : null}
        {benefits && benefits.text_discount_rate < 1 ? (
          <Benefit label="对话享">{formatDiscountLabel(benefits.text_discount_rate)}</Benefit>
        ) : null}
        {active && freeChat ? (
          <Benefit label="免费畅聊" chat>
            {freeChat.memberStatus}
          </Benefit>
        ) : null}
        {!benefits ? <span>{loading ? '正在读取会员权益…' : '查看完整月卡权益'}</span> : null}
      </span>
      {!active ? (
        <span className="relative mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] leading-4 text-[#ad9a91]">
          {tickets ? null : (
            <span>
              {bonus > 0 && monthlyPlan
                ? vipPlanRewardLabel(monthlyPlan)
                : '查看月卡内容与专属权益'}
            </span>
          )}
          {monthlyPlan ? (
            <span>
              ¥{formatYuanShort(monthlyPlan.price_cents)} / {monthlyPlan.duration_days} 天
            </span>
          ) : null}
          {tickets ? <OpenButton active={false} busy={loading || disabled} /> : null}
        </span>
      ) : null}
    </button>
  );
}

function Headline({
  active,
  status,
  bonus,
}: {
  active: boolean;
  status: VipStatus | undefined;
  bonus: number;
}) {
  if (active)
    return (
      <span className="min-w-0">
        <span className="block text-[24px] font-medium tracking-[0.08em]">尊享会员</span>
        <span className="mt-1 block text-[11px] leading-5 text-[#bda99c]">
          {vipEntryExpiryLabel(status ?? null) ?? '你的专属权益已开启'}
        </span>
      </span>
    );
  if (bonus > 0)
    return (
      <span className="min-w-0">
        <span className="block text-[11px] text-[#c9b5a6]">开通即赠星尘</span>
        <span className="mt-0.5 block text-[38px] font-medium leading-[44px] tabular-nums tracking-[-0.04em]">
          {formatNumber(bonus)}
        </span>
      </span>
    );
  return (
    <span className="min-w-0">
      <span className="block text-lg font-medium leading-7">让每一次相遇，更尽兴</span>
    </span>
  );
}

/** 未开通：免费畅聊（冰蓝）与赠送星尘（香槟金）两张等大的券 */
function OfferTickets({
  freeChat,
  monthlyPlan,
  bonus,
}: {
  freeChat: VipFreeChatTerms;
  monthlyPlan: VipPlan | undefined;
  bonus: number;
}) {
  const main = monthlyPlan?.bonus_main_credits ?? 0;
  const special = monthlyPlan?.bonus_credits ?? 0;
  const chatCaption =
    freeChat.welcomeDays > 0 ? ['开通立享', `之后每${freeChat.weekday}畅聊`] : ['会员每周畅聊日'];
  return (
    <span className={cn('relative mt-4 grid gap-2.5', bonus > 0 ? 'grid-cols-2' : 'grid-cols-1')}>
      <Ticket
        tone="chat"
        label="免费畅聊"
        big={freeChat.welcomeDays > 0 ? String(freeChat.welcomeDays) : freeChat.weekday}
        unit={freeChat.welcomeDays > 0 ? '天' : undefined}
        caption={chatCaption}
      />
      {bonus > 0 ? (
        <Ticket
          tone="gold"
          label="开通即赠星尘"
          big={formatNumber(bonus)}
          caption={
            main > 0 && special > 0
              ? [`${formatNumber(special)} 专项`, `+ ${formatNumber(main)} 通用`]
              : ['开通立得']
          }
        />
      ) : null}
    </span>
  );
}

function Ticket(props: {
  tone: 'chat' | 'gold';
  label: string;
  big: string;
  unit?: string;
  caption: string[];
}) {
  const chat = props.tone === 'chat';
  return (
    <span
      className={cn(
        'block min-w-0 rounded-2xl border px-3 pb-2.5 pt-3',
        chat ? 'border-free-zone/35 bg-free-zone/[0.07]' : 'border-[#d8bca0]/30 bg-[#ead0b6]/[0.06]'
      )}
    >
      <span
        className={cn('block text-[11px] font-medium', chat ? 'text-free-zone' : 'text-[#e2c6a8]')}
      >
        {props.label}
      </span>
      <span className="mt-1 flex items-baseline gap-0.5">
        <span
          className={cn(
            'text-[30px] font-medium leading-9 tabular-nums tracking-[-0.03em]',
            chat ? 'text-[#d4f0fe]' : 'text-[#f0dcc6]'
          )}
        >
          {props.big}
        </span>
        {props.unit ? (
          <span
            className={cn('text-[15px] font-medium', chat ? 'text-free-zone' : 'text-[#e2c6a8]')}
          >
            {props.unit}
          </span>
        ) : null}
      </span>
      <span className="mt-1 block text-[10.5px] leading-4 text-[#c9b5a6]">
        {props.caption.map((line) => (
          <span key={line} className="block truncate">
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}

function Benefit({
  label,
  chat = false,
  children,
}: {
  label: string;
  chat?: boolean;
  children: ReactNode;
}) {
  return (
    <span>
      {label}{' '}
      <strong
        className={cn('font-medium tabular-nums', chat ? 'text-free-zone' : 'text-[#f0dcc6]')}
      >
        {children}
      </strong>
    </span>
  );
}

function OpenButton({ active, busy }: { active: boolean; busy: boolean }) {
  return (
    <span className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border border-[#ead0b6]/25 bg-[#ead0b6]/[0.06] px-3 text-xs font-medium text-[#eed7bf] transition-colors group-hover:bg-[#ead0b6]/10">
      {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {active ? '会员中心' : '开通 VIP'}
      <ChevronRight className="size-3.5" aria-hidden />
    </span>
  );
}
