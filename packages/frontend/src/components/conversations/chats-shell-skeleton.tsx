/**
 * Telegram SDK 就绪前的对话页静态占位：有对话记录的用户冷启动落在 /chats。
 * 必须保持纯展示：不读 storage、不发请求、不挂业务组件，否则会绕过 Providers 的就绪门。
 * 页头与 RoleplayHeader 对齐、行高与对话行对齐，切到真实内容时不跳动。
 */
export function ChatsShellSkeleton() {
  return (
    <main
      className="min-h-screen bg-background text-foreground"
      aria-busy="true"
      aria-label="加载中"
    >
      <header className="sticky top-0 z-30 w-full border-b border-border/70 bg-background pb-1 pt-[calc(0.5rem+env(safe-area-inset-top))]">
        <div className="mx-auto flex w-full max-w-screen-xl gap-2 px-4 sm:px-6 lg:px-8">
          <h1 className="relative flex min-h-11 min-w-20 items-center justify-center px-4 pb-2 text-sm font-semibold text-primary">
            对话
            <span
              className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
              aria-hidden
            />
          </h1>
          <span className="ml-auto mt-1 h-9 w-[104px] rounded-full bg-[#e3d5b8]/25" aria-hidden />
        </div>
      </header>
      <p className="mx-auto w-full max-w-2xl px-4 pb-2 pt-2 text-xs text-muted-foreground">
        继续你的故事，也可以在这里管理对话。
      </p>
      <div className="mx-auto w-full max-w-2xl space-y-2 px-4 pt-1">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="flex animate-breath items-center gap-3 rounded-3xl border border-border bg-card p-3.5"
          >
            <span className="size-12 shrink-0 rounded-2xl bg-secondary" />
            <span className="flex-1 space-y-2">
              <span className="block h-3.5 w-28 rounded bg-secondary" />
              <span className="block h-3 w-44 rounded bg-secondary/70" />
            </span>
          </div>
        ))}
      </div>
    </main>
  );
}
