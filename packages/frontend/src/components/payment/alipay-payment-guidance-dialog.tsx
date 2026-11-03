'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';

const PAYMENT_STEPS = [
  '点击「打开支付宝APP付款」，跳转后完成付款',
  '付款完成后返回秘境，到账会自动刷新',
] as const;

/**
 * 当前支付平台无需关闭 VPN（2026-11-03 用户实测），所以不再有 VPN 步骤和勾选确认。
 * 这张确认面板仍要保留：建单是异步请求，Telegram 只允许在用户刚点击时打开外部链接，
 * “打开支付宝APP付款”这一下就是那次点击。保持固定文案，不与微信的运行时配置混用。
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

          <DialogFooter className="mt-4 flex-col gap-2 sm:flex-col sm:space-x-0">
            <Button
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
