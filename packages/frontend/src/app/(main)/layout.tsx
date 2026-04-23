import { BottomNav } from '@/components/nav/bottom-nav';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* 底边栏高度约 56px + safe-area，内容区底部留出同等 padding 避免被遮住 */}
      <div className="pb-[calc(3.5rem+env(safe-area-inset-bottom))]">{children}</div>
      <BottomNav />
    </>
  );
}
