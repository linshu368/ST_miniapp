export function TypingIndicator() {
  return (
    <div aria-label="她正在打字" className="flex w-full animate-whisper-in justify-start">
      <div className="flex items-center gap-1.5 px-1 py-2">
        <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/70 [animation-delay:-0.32s]" />
        <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/70 [animation-delay:-0.16s]" />
        <span className="h-1.5 w-1.5 animate-breath rounded-full bg-muted-foreground/70" />
      </div>
    </div>
  );
}
