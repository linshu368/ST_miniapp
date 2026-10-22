/**
 * Telegram SDK 就绪前的大厅静态占位。`/` 是静态预渲染页，这段会直接进 SSR HTML，
 * 让首次绘制不必等 JS 下载 + hydrate。这里必须保持纯展示：不挂任何发请求、读 initData
 * 或读 localStorage 的组件，否则会绕过 Providers 的就绪门。
 * 布局与 HomePage + CharacterGallery 的加载态对齐，切换到真实内容时不跳动。
 */
export function LobbyShellSkeleton() {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col pt-[env(safe-area-inset-top)]"
      aria-busy="true"
      aria-label="加载中"
    >
      <div className="mx-auto w-full max-w-screen-xl px-4 pb-2 pt-2 sm:px-6 lg:px-8">
        <div className="h-10 rounded-full border border-border bg-card" />
      </div>
      <div className="mx-auto flex w-full max-w-screen-xl items-center gap-2 px-4 pb-1 pt-1.5 sm:px-6 lg:px-8">
        <div className="h-[30px] w-16 rounded-full border border-primary/30 bg-primary/10" />
        <div className="h-[30px] w-16 rounded-full" />
      </div>
      <div className="mx-auto grid w-full max-w-screen-xl grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3 px-4 py-6 sm:px-6 lg:px-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="aspect-[3/4] w-full animate-breath rounded-[16px] border border-border bg-card"
          />
        ))}
      </div>
    </main>
  );
}
