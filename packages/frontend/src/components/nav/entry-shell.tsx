import { LobbyShellSkeleton } from '@/components/characters/lobby-shell-skeleton';
import { ChatsShellSkeleton } from '@/components/conversations/chats-shell-skeleton';
import { DramaComingSoon } from '@/components/drama/drama-coming-soon';
import { BottomNavShell } from './bottom-nav-shell';

/** 只画启动框架；业务组件仍等待 Telegram 初始化，避免提前读取身份或发起请求。 */
export function EntryShell({ pathname }: { pathname: string }) {
  return (
    <>
      <div
        data-startup-content
        data-startup-pathname={pathname}
        className="pb-[var(--app-nav-space)]"
        aria-busy="true"
      >
        {pathname === '/characters' ? (
          <LobbyShellSkeleton />
        ) : pathname === '/dramas' || pathname === '/watch' ? (
          <DramaComingSoon />
        ) : pathname === '/chats' ? (
          <ChatsShellSkeleton />
        ) : (
          <main className="mx-auto min-h-dvh w-full max-w-screen-xl p-6 pt-[calc(1.5rem+env(safe-area-inset-top))]">
            <p role="status" className="text-muted-foreground">
              加载中
            </p>
          </main>
        )}
      </div>
      {pathname.startsWith('/chat/') ? null : <BottomNavShell pathname={pathname} />}
    </>
  );
}
