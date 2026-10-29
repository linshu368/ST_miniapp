import { LobbyShellSkeleton } from '@/components/characters/lobby-shell-skeleton';
import { DramaListShell } from '@/components/drama/drama-list-shell';
import { BottomNavShell } from './bottom-nav';

/** 只画启动框架；业务组件仍等待 Telegram 初始化，避免提前读取身份或发起请求。 */
export function EntryShell({ pathname }: { pathname: string }) {
  return (
    <>
      <div className="pb-[var(--app-nav-space)]" aria-busy="true">
        {pathname === '/characters' ? (
          <LobbyShellSkeleton />
        ) : pathname === '/dramas' ? (
          <DramaListShell />
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
