import { hueShiftFromId } from '@/lib/utils/character-hue';

interface CharacterAvatarProps {
  avatarUrl?: string | null;
  name?: string;
  characterId?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_CLASS = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
  /** 聊天页顶部角色卡：约 96px */
  xl: 'h-24 w-24',
};

export function CharacterAvatar({
  avatarUrl,
  name,
  characterId,
  size = 'md',
  className,
}: CharacterAvatarProps) {
  const hue = characterId ? hueShiftFromId(characterId) : 12;
  const hasAvatar = !!avatarUrl;

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-white/10 ${size === 'xl' ? 'border border-white/20' : ''} ${SIZE_CLASS[size]} ${className ?? ''}`}
      style={{ boxShadow: `0 0 12px -3px hsl(${hue} 70% 60% / 0.45)` }}
      aria-hidden={!name}
    >
      {hasAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl!} alt={name ?? ''} className="h-full w-full object-cover object-top" />
      ) : (
        <div
          className="h-full w-full"
          style={{
            background: `radial-gradient(100% 100% at 50% 30%, hsl(${hue} 60% 45%), hsl(${hue} 40% 18%))`,
          }}
        />
      )}
    </div>
  );
}
