import Link from 'next/link';
import { ArrowUpRight, ChevronRight, Gem } from 'lucide-react';
import { formatNumber } from '@/lib/utils/payment';

/**
 * 「我的」页星尘卡：大数字只放通用星尘（所有功能可用），专项星尘单独一行。
 * 合计会让用户以为生图、语音、标准/旗舰对话也能花专项，所以不再显示合计。
 * 专项只能用在轻量档对话和状态面板的立即更新，用时先扣（与 shared/api/wallet.ts 的扣费顺序一致）。
 */
export function ProfileStardustBalance(props: {
  mainCredits: number | undefined;
  bonusCredits: number | undefined;
  isError: boolean;
  isFetching: boolean;
  onRetry: () => void;
}) {
  const { mainCredits, bonusCredits } = props;
  const loaded = typeof mainCredits === 'number' && typeof bonusCredits === 'number';
  const hasBonus = typeof bonusCredits === 'number' && bonusCredits > 0;

  return (
    <section aria-label="我的星尘" className="relative px-5 pb-1 pt-5">
      <div className="relative flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground dark:text-[#b7aeb5]">
            <Gem className="size-3.5" aria-hidden />
            通用星尘
          </p>
          <p className="mt-2 flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[36px] font-medium leading-none tabular-nums tracking-[-0.04em] text-foreground dark:text-[#f4eeeb]">
              {typeof mainCredits === 'number' ? formatNumber(mainCredits) : '—'}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">所有功能可用</span>
          </p>
        </div>
        <Link
          href="/profile/recharge"
          aria-label="前往星尘充值"
          className="relative inline-flex min-h-11 shrink-0 items-center justify-center gap-1 rounded-full bg-foreground px-3.5 text-xs font-semibold text-background transition-colors hover:bg-foreground/90 dark:bg-[#eee5e0] dark:text-[#332a2f] dark:hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:focus-visible:ring-[#d7b4bf] focus-visible:ring-offset-2 focus-visible:ring-offset-surface motion-reduce:transition-none"
        >
          充值星尘
          <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      </div>
      {loaded ? (
        <div
          className={`mt-3.5 flex items-center gap-2.5 rounded-[14px] px-3 py-2.5 ${hasBonus ? 'bg-mauve/[0.12] dark:bg-[#d7b4bf]/[0.12]' : 'bg-secondary dark:bg-white/[0.035]'}`}
        >
          <span
            className={`shrink-0 rounded-full border px-[7px] py-0.5 text-[10px] ${hasBonus ? 'border-mauve/35 dark:border-[#d7b4bf]/35 text-mauve dark:text-[#d7b4bf]' : 'border-border dark:border-white/[0.07] text-muted-foreground'}`}
          >
            专项
          </span>
          <span
            className={`text-[17px] font-medium tabular-nums ${hasBonus ? 'text-foreground dark:text-[#f4eeeb]' : 'text-muted-foreground'}`}
          >
            {formatNumber(bonusCredits ?? 0)}
          </span>
          <span className="ml-auto text-right text-[10.5px] leading-[1.4] text-muted-foreground dark:text-[#b7aeb5]">
            {hasBonus ? (
              <>
                轻量档对话、状态更新可用
                <br />
                使用时先扣
              </>
            ) : (
              <>
                暂无
                <br />
                开通会员可得
              </>
            )}
          </span>
        </div>
      ) : null}
      <div className="relative mt-1 flex min-h-11 items-center justify-between gap-2">
        {props.isError ? (
          <button
            type="button"
            onClick={props.onRetry}
            disabled={props.isFetching}
            className="min-h-11 text-left text-[11px] text-destructive disabled:opacity-60"
          >
            {props.isFetching ? '正在重试…' : '余额加载失败，重试'}
          </button>
        ) : (
          <p className="min-w-0 truncate text-[11px] text-muted-foreground">
            {loaded ? '' : '正在读取余额…'}
          </p>
        )}
        <Link
          href="/profile/spending"
          className="inline-flex min-h-11 shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/80 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          消费明细
          <ChevronRight className="size-3" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
