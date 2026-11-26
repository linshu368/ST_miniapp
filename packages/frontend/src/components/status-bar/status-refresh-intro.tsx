'use client';

/**
 * 「立即更新」的收费说明（对比稿 B「只在第一次说」）。价格只在这两处出现：
 * 按钮不带价签、面板不显示余额、扣费不做动效，让用户知道收费，日常用起来不掂量。
 * - RefreshIntroCard：第一次点「立即更新」弹一次说明卡；「更新」才开始，「先不用」只关卡片。
 *   卡片一弹出就记"看过"：价格已经告知，之后不管怎么关（先不用 / 遮罩 / 返回键 / Esc），再点都直接更新。
 * - RefreshPriceHint：标题「每 N 轮自动更新」后面的小问号，点开三行说明，点外面或再点一次关。
 */
import { useEffect, useRef } from 'react';
import { Gem } from 'lucide-react';
import { STATUS_REFRESH_CREDITS } from '@miniapp/shared';
import { useTelegramBackButton } from '@/lib/telegram';
import { readLocal, writeLocal } from './use-status-gestures';

const INTRO_KEY = 'st_miniapp_status_refresh_intro_seen';

/** 存储拿不到时（隐私模式）每次都当没看过：多看一次说明，不会漏告知收费。 */
export const refreshIntroSeen = () => readLocal(INTRO_KEY) === '1';

export function RefreshIntroCard({
  autoEveryTurns,
  onConfirm,
  onClose,
}: {
  autoEveryTurns: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useTelegramBackButton(onClose, 'dialog');
  useEffect(() => {
    writeLocal(INTRO_KEY, '1');
    confirmRef.current?.focus();
  }, []);
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center px-6"
      role="dialog"
      aria-modal="true"
      aria-label="立即更新"
    >
      <div
        className="absolute inset-0 rounded-l-[26px] bg-black/55 motion-safe:animate-in motion-safe:fade-in-0"
        onClick={onClose}
      />
      <div className="relative grid w-full max-w-[300px] gap-3.5 rounded-[24px] bg-card px-5 pb-3 pt-6 text-center shadow-[0_20px_50px_rgb(0_0_0/0.35)] dark:bg-[rgb(53_43_49)] motion-safe:animate-in motion-safe:zoom-in-95">
        <span className="mx-auto grid size-[46px] place-items-center rounded-2xl bg-mauve/15 text-mauve">
          <Gem className="size-6" aria-hidden />
        </span>
        <span className="text-[17px] font-bold">立即更新</span>
        <span className="text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums">
          {STATUS_REFRESH_CREDITS}
          <span className="ml-1 text-[13px] font-medium tracking-normal text-muted-foreground">
            星尘 / 次
          </span>
        </span>
        <span className="grid gap-1.5 text-[12.5px] text-muted-foreground">
          <span>每 {autoEveryTurns} 轮自动更新，不花星尘</span>
          <span>没更新成功不扣</span>
        </span>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          className="mt-1 min-h-[46px] rounded-[14px] bg-gradient-to-r from-mauve to-primary text-[14.5px] font-semibold text-white dark:from-[hsl(341_33%_70%)] dark:to-primary dark:text-[#2a1a20]"
        >
          更新
        </button>
        <button
          type="button"
          onClick={onClose}
          className="min-h-9 text-[12.5px] text-muted-foreground/70"
        >
          先不用
        </button>
      </div>
    </div>
  );
}

export function RefreshPriceHint({
  open,
  autoEveryTurns,
  onToggle,
}: {
  open: boolean;
  autoEveryTurns: number;
  onToggle: (open: boolean) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onToggle(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, onToggle]);
  return (
    // 气泡相对标题那一行定位（调用方给那一行 relative），从行首展开，不会顶出面板右边
    <span ref={ref} className="inline-flex">
      <button
        type="button"
        aria-label="立即更新怎么收费"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="-m-2 grid size-[31px] place-items-center"
      >
        <span className="grid size-[15px] place-items-center rounded-full border border-muted-foreground/70 text-[10px] leading-none">
          ?
        </span>
      </button>
      {open ? (
        <span
          role="status"
          className="absolute left-0 top-full z-10 mt-1.5 grid w-[196px] gap-0.5 rounded-[14px] bg-card px-3.5 py-3 text-[12px] leading-[1.8] text-foreground shadow-[0_10px_30px_rgb(0_0_0/0.3)] dark:bg-[rgb(53_43_49)] motion-safe:animate-in motion-safe:fade-in-0"
        >
          <span>
            每 {autoEveryTurns} 轮自动更新 <span className="text-muted-foreground">不花星尘</span>
          </span>
          <span className="flex items-center gap-1">
            立即更新
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Gem className="size-3" aria-hidden />
              {STATUS_REFRESH_CREDITS} 星尘 / 次
            </span>
          </span>
          <span className="text-muted-foreground">没更新成功不扣</span>
        </span>
      ) : null}
    </span>
  );
}
