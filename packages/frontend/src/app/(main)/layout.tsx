'use client';

import { BottomNav } from '@/components/nav/bottom-nav';
import { usePathname } from 'next/navigation';

const NAV_HIDDEN_PREFIXES = ['/profile/recharge', '/create/wish'];

export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hideBottomNav =
    pathname && NAV_HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  return (
    <>
      {/* 悬浮底边栏高度+间距约 90px + safe-area，内容区底部留出同等 padding 避免被遮住 */}
      <div className={hideBottomNav ? undefined : 'pb-[calc(5.5rem+env(safe-area-inset-bottom))]'}>
        {children}
      </div>
      <BottomNav />
    </>
  );
}
