import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, Search } from 'lucide-react';

/** Shared HTML/interactive frame; no identity, storage, or business queries. */
export function DramaHomeFrame({
  controlsVisible = true,
  headerActions,
  onBrowse,
  children,
}: {
  controlsVisible?: boolean;
  headerActions?: ReactNode;
  onBrowse?: (tab: 'library' | 'theater') => void;
  children: ReactNode;
}) {
  return (
    <main
      aria-label="短剧放映"
      className="fixed inset-0 z-30 overflow-hidden bg-black text-[#eee7e2]"
    >
      <div className="relative mx-auto h-full max-w-lg">
        {controlsVisible ? (
          <header className="pointer-events-none relative z-20 flex [&_a]:pointer-events-auto [&_button]:pointer-events-auto h-[calc(60px+env(safe-area-inset-top))] items-center justify-between bg-gradient-to-b from-black/65 to-transparent px-5 pt-[env(safe-area-inset-top)]">
            <div className="flex h-full items-center gap-7">
              <div className="flex h-full items-center gap-2">
                {/* 放映只从剧场进入，返回固定回剧场；剧场会找回最后看的那部。 */}
                <Link
                  href="/dramas"
                  aria-label="返回剧场"
                  className="-ml-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/20"
                >
                  <ArrowLeft className="h-6 w-6" />
                </Link>
                <h1 className="relative flex h-full items-center text-[18px] font-bold">
                  推荐
                  <span
                    aria-hidden
                    className="absolute bottom-1.5 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-white"
                  />
                </h1>
              </div>
              <Link
                href="/dramas"
                onClick={() => onBrowse?.('library')}
                className="flex min-h-11 items-center text-base text-[#eee7e2]/60"
              >
                追剧
              </Link>
            </div>
            <div className="-mr-2 flex items-center">
              {headerActions}
              <Link
                href="/dramas"
                aria-label="搜索短剧"
                onClick={() => onBrowse?.('theater')}
                className="flex h-11 w-11 items-center justify-center"
              >
                <Search className="h-[22px] w-[22px]" />
              </Link>
            </div>
          </header>
        ) : null}
        {/* 放映页不再显示底栏，画面始终铺满到底部安全区。 */}
        <div className="absolute inset-0">{children}</div>
      </div>
    </main>
  );
}

export function DramaHomeLoading() {
  return (
    <div
      role="status"
      className="flex h-full items-center justify-center text-sm text-[#eee7e2]/40"
    >
      <span className="animate-pulse">好戏，即将开始</span>
    </div>
  );
}

export function DramaHomeEmpty({ isError, onRetry }: { isError: boolean; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center px-8 text-center"
    >
      <Clapperboard className="mb-5 h-10 w-10 text-[#eee7e2]/30" />
      <h2 className="text-lg font-semibold">{isError ? '短剧暂时没加载出来' : '好戏，即将开场'}</h2>
      <p className="mt-2 text-sm text-[#eee7e2]/45">
        {isError ? '网络可能开了个小差，再试一次就好。' : '短剧正在陆续上架，稍后回来看看。'}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 min-h-11 rounded-full bg-[#dfd2cf] px-6 text-sm font-semibold text-black"
      >
        {isError ? '重新加载' : '刷新看看'}
      </button>
    </div>
  );
}
