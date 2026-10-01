'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';

const PAYMENT_STEPS = [
  '第一步：请关闭VPN',
  '第二步：点击「打开支付宝APP付款」，跳转后完成付款',
  '第三步：完成付款后再次开启VPN返回到秘境。',
] as const;

/**
 * 支付宝需要在离开 Mini App 前完成 VPN 切换；保持这套固定提示独立于微信的截图付款配置，
 * 避免渠道文案或后续操作被运行时配置误混用。
 */
export function AlipayPaymentGuidanceDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const [vpnClosed, setVpnClosed] = useState(false);

  useEffect(() => {
    if (!open) setVpnClosed(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="bottom-0 left-0 top-auto w-full max-w-md translate-x-0 translate-y-0 gap-0 rounded-b-none rounded-t-3xl border-border bg-popover p-0 text-popover-foreground sm:left-[50%] sm:translate-x-[-50%]"
      >
        <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-muted-foreground/45" aria-hidden />
        <div className="max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] overflow-y-auto px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5">
          <DialogTitle className="sr-only">支付宝付款指引</DialogTitle>
          <ol className="divide-y divide-border border-y border-border">
            {PAYMENT_STEPS.map((step, index) => (
              <li key={step} className="flex items-start gap-3 py-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1677FF] text-xs font-black text-white">
                  {index + 1}
                </span>
                <span className="pt-0.5 text-[15px] font-bold leading-5">{step}</span>
              </li>
            ))}
          </ol>

          <label className="mt-4 flex min-h-14 cursor-pointer items-center justify-between rounded-xl bg-secondary px-4">
            <span className="text-sm font-bold">我已关闭VPN</span>
            <input
              type="checkbox"
              checked={vpnClosed}
              onChange={(event) => setVpnClosed(event.target.checked)}
              aria-label="确认已关闭VPN"
              className="h-5 w-5 accent-[#1677FF]"
            />
          </label>

          <DialogFooter className="mt-4 flex-col gap-2 sm:flex-col sm:space-x-0">
            <Button
              disabled={!vpnClosed}
              onClick={onConfirm}
              className="h-12 w-full rounded-xl border-0 bg-[#1677FF] font-black text-white hover:bg-[#1677FF]/90"
            >
              打开支付宝APP付款
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="h-10 w-full font-bold text-muted-foreground"
            >
              暂不付款
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
