import { LobbyShellSkeleton } from '@/components/characters/lobby-shell-skeleton';
import { ChatsShellSkeleton } from '@/components/conversations/chats-shell-skeleton';
import { DramaListShell } from '@/components/drama/drama-list-shell';
import { BottomNavShell } from './bottom-nav-shell';
import { DramaHomeFrame, DramaHomeLoading } from '@/components/drama/drama-home-frame';

/** 只画启动框架；业务组件仍等待 Telegram 初始化，避免提前读取身份或发起请求。 */
export function EntryShell({ pathname }: { pathname: string }) {
  return (
    <>
      <div
        data-startup-content
        data-startup-fullscreen={pathname === '/watch' ? '' : undefined}
        className="pb-[var(--app-nav-space)]"
        aria-busy="true"
      >
        {pathname === '/watch' ? (
          <DramaHomeFrame>
            <DramaHomeLoading />
          </DramaHomeFrame>
        ) : pathname === '/characters' ? (
          <LobbyShellSkeleton />
        ) : pathname === '/dramas' ? (
          <DramaListShell />
        ) : pathname === '/chats' ? (
          <ChatsShellSkeleton />
        ) : (
          <main className="mx-auto min-h-dvh w-full max-w-screen-xl p-6 pt-[calc(1.5rem+env(safe-area-inset-top))]">
            {pathname !== '/watch' && (
              <p role="status" className="text-muted-foreground">
                加载中
              </p>
            )}
          </main>
        )}
      </div>
      {pathname.startsWith('/chat/') ? null : <BottomNavShell pathname={pathname} />}
    </>
  );
}
