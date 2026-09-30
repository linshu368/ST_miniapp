'use client';

import type { PaymentPromptDialogConfig } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';

export function PaymentVpnPromptDialog({
  open,
  config,
  canConfirm,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  config: PaymentPromptDialogConfig;
  canConfirm: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100%-2rem)] max-w-sm overflow-hidden rounded-3xl border-2 bg-popover p-0 text-popover-foreground"
        style={{ borderColor: config.accent_color }}
      >
        <div className="h-1.5 w-full" style={{ backgroundColor: config.accent_color }} />
        <div className="px-5 pb-6 pt-5">
          <DialogHeader className="items-center text-center">
            <div className="flex w-full flex-col gap-3">
              {[
                { id: 1, before: '第一步：请关闭VPN' },
                { id: 2, before: '第二步：请', emphasis: '直接截图', after: '保存支付码' },
                { id: 3, before: '第三步：', emphasis: '手动打开', after: '微信扫码支付' },
              ].map((step) => (
                <div
                  key={step.id}
                  className="w-full rounded-xl border border-[#3f3f46] bg-[#262626] px-[14px] py-[15px] text-center text-[15px] font-[750] leading-[22px] text-[#fde68a] dark:text-[#b45309]"
                >
                  {step.before}
                  {step.emphasis ? (
                    <span className="font-[900]" style={{ color: config.accent_color }}>
                      {step.emphasis}
                    </span>
                  ) : null}
                  {step.after}
                </div>
              ))}
            </div>
          </DialogHeader>
          <DialogFooter className="mt-4 border-t border-[#3f3f46] pt-4">
            <Button
              className="mx-auto min-h-[46px] w-fit rounded-xl border-0 px-6 font-black text-[#171717] hover:opacity-90"
              style={{ backgroundColor: config.accent_color }}
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              已关闭VPN，去截图保存二维码
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
