/** The route shell shows progress without fetching identity or declaring content ready. */
export default function ChatLoading() {
  return (
    <main className="flex h-[100dvh] flex-col bg-background text-foreground" aria-busy="true">
      <header className="border-b border-border px-4 pb-3 pt-[calc(1rem+env(safe-area-inset-top))]">
        <span className="block h-4 w-28 rounded bg-secondary" aria-hidden />
      </header>
      <div className="flex flex-1 items-center justify-center" role="status" aria-live="polite">
        <p className="text-sm text-muted-foreground">正在进入对话…</p>
      </div>
      <div
        className="mx-4 mb-[calc(1rem+env(safe-area-inset-bottom))] h-12 rounded-2xl border border-border bg-secondary/40"
        aria-hidden
      />
    </main>
  );
}
