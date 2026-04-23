'use client';

import type { CharacterSummary } from '@miniapp/shared';

import { cn } from '@/lib/utils';
import { characterRoomGradient } from '@/lib/utils/character-hue';

interface CharacterCardProps {
  character: CharacterSummary;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export function CharacterCard({ character, onSelect, disabled }: CharacterCardProps) {
  const gradient = characterRoomGradient(character.id);
  const hasAvatar = !!character.avatar_url;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(character.id)}
      className={cn(
        'group flex w-full flex-col overflow-hidden rounded-xl border border-border/50 bg-card text-left shadow-sm',
        'transition-transform duration-200 ease-out active:scale-[0.995]',
        'disabled:opacity-60'
      )}
      aria-label={`查看 ${character.name} 的详情`}
    >
      {/* 图片区：3:4 + 渐变叠层 + 名字 */}
      <div className="relative aspect-[3/4] w-full overflow-hidden">
        {hasAvatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={character.avatar_url}
            alt={character.name}
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        ) : (
          <div className="absolute inset-0" aria-hidden="true" style={{ background: gradient }} />
        )}

        {/* 渐变遮罩 */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 via-black/40 to-transparent"
        />

        {/* 渐变层底部：名字独占一行 + 下方单行标签（溢出软淡出，不折行不堆叠） */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-2.5 pb-2.5">
          <h3 className="truncate px-0.5 text-[15px] font-semibold leading-tight text-white drop-shadow-sm">
            {character.name}
          </h3>

          {character.personality_tags.length > 0 && (
            <div
              className="flex min-w-0 flex-nowrap items-center gap-0.5 overflow-hidden"
              style={{
                maskImage: 'linear-gradient(to right, black 0, black 78%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to right, black 0, black 78%, transparent 100%)',
              }}
            >
              {character.personality_tags.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="shrink-0 rounded-full bg-white/12 px-1.5 py-[2px] text-[10px] font-medium leading-none text-white/90 ring-1 ring-inset ring-white/15 backdrop-blur-[2px]"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 信息区：作者 + 描述最多两行省略 */}
      <div className="flex flex-col gap-1 px-3 py-2.5">
        <p className="text-[10px] leading-none text-muted-foreground/60">
          by {character.author_name}
        </p>
        <p className="line-clamp-2 text-[11px] leading-relaxed text-foreground/60">
          {character.description}
        </p>
      </div>
    </button>
  );
}
