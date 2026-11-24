import { Clapperboard } from 'lucide-react';

/**
 * 剧场下线期间的占位页：纯静态，不读身份、不发请求，启动骨架与正式页共用。
 * 恢复短剧时整体换回 DramaListShell / 列表页即可。
 */
export function DramaComingSoon() {
  return (
    <main
      aria-label="剧场"
      className="flex min-h-dvh flex-col items-center justify-center bg-[#121113] px-8 text-center text-[#eee7e2]"
    >
      <div role="status" className="flex flex-col items-center">
        <Clapperboard aria-hidden className="mb-5 h-10 w-10 text-[#eee7e2]/30" />
        <p className="text-lg font-semibold">好戏筹备中，敬请期待</p>
      </div>
    </main>
  );
}
