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
    <div
      aria-label="她正在打字"
      className={cn('flex w-full animate-whisper-in items-end', !isNoir && 'gap-2')}
    >
      {!isNoir && <CharacterAvatar avatarUrl={charAvatarUrl} characterId={characterId} size="sm" />}

      <div
        className={cn(
          'flex items-center gap-1.5 px-3.5 py-3',
          isNoir
            ? 'rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)]'
            : 'rounded-2xl rounded-bl-[6px] bg-secondary/50 px-4 py-2.5'
        )}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 animate-breath rounded-full [animation-delay:-0.32s]',
            isNoir ? 'bg-[rgba(242,243,245,0.45)]' : 'bg-muted-foreground/70'
          )}
        />
        <span
          className={cn(
            'h-1.5 w-1.5 animate-breath rounded-full [animation-delay:-0.16s]',
            isNoir ? 'bg-[rgba(242,243,245,0.45)]' : 'bg-muted-foreground/70'
          )}
        />
        <span
          className={cn(
            'h-1.5 w-1.5 animate-breath rounded-full',
            isNoir ? 'bg-[rgba(242,243,245,0.45)]' : 'bg-muted-foreground/70'
          )}
        />
      </div>
    </div>
  );
}
