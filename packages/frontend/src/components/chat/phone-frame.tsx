'use client';

import { cn } from '@/lib/utils';

interface PhoneFrameProps {
  children: React.ReactNode;
}

/**
 * 开发专用：给 chat 页面包一个手机外框，便于在浏览器里预览手机比例。
 * 生产环境不渲染此容器，页面直接占满 Telegram WebView。
 * 通过 CSS 类 `phone-frame-dev` 控制显示，仅在 NODE_ENV=development 时渲染。
 */
export function PhoneFrame({ children }: PhoneFrameProps) {
  return (
    <div className="phone-frame-dev fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8">
      <div className="relative h-full w-full max-w-[390px] overflow-hidden rounded-[44px] border-[12px] border-neutral-800 bg-background shadow-2xl">
        {/* 刘海 / 灵动岛 */}
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center">
          <div className="h-7 w-24 rounded-b-2xl bg-neutral-800" />
        </div>

        {/* 手机内容 */}
        <div className="h-full w-full overflow-hidden">{children}</div>

        {/* 底部手势条 */}
        <div className="absolute inset-x-0 bottom-2 flex justify-center">
          <div className="h-1 w-24 rounded-full bg-neutral-600" />
        </div>
      </div>
    </div>
  );
}
