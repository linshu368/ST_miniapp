import { CharacterAvatar } from '@/components/characters/character-avatar';
import { cn } from '@/lib/utils';

interface TypingIndicatorProps {
  charAvatarUrl?: string;
  characterId?: string;
  variant?: 'default' | 'noir';
}

export function TypingIndicator({
  charAvatarUrl,
  characterId,
  variant = 'default',
}: TypingIndicatorProps) {
  const isNoir = variant === 'noir';

  return (
    <div aria-label="她正在打字" className="flex w-full animate-whisper-in items-end gap-2">
      <CharacterAvatar avatarUrl={charAvatarUrl} characterId={characterId} size="sm" />

      <div
        className={cn(
          'flex items-center gap-1.5 px-4 py-3',
          isNoir
            ? 'rounded-2xl border border-white/10 bg-white/[0.06]'
            : 'rounded-2xl rounded-bl-[6px] bg-secondary/50 px-4 py-2.5'
        )}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 animate-breath rounded-full [animation-delay:-0.32s]',
            isNoir ? 'bg-white/40' : 'bg-muted-foreground/70'
          )}
        />
        <span
          className={cn(
            'h-1.5 w-1.5 animate-breath rounded-full [animation-delay:-0.16s]',
            isNoir ? 'bg-white/40' : 'bg-muted-foreground/70'
          )}
        />
        <span
          className={cn(
            'h-1.5 w-1.5 animate-breath rounded-full',
            isNoir ? 'bg-white/40' : 'bg-muted-foreground/70'
          )}
        />
      </div>
    </div>
  );
}
