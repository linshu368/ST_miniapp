import { cn } from '@/lib/utils';

/** 播放页六个以内完整呈现，更多标签由简介面板承接；沿用运营排列顺序。 */
export function DramaTags({ tags, variant }: { tags: string[]; variant: 'player' | 'detail' }) {
  const labels = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (!labels.length) return null;
  const limit = variant === 'detail' ? labels.length : 6;
  const remaining = Math.max(0, labels.length - limit);

  return (
    <div
      role="list"
      aria-label={variant === 'detail' ? '全部标签' : '短剧标签'}
      className={cn(
        'min-w-0 text-[11px] font-normal leading-4',
        variant === 'player' && 'flex flex-wrap items-center gap-1.5',
        variant === 'detail' && 'mb-4 flex flex-wrap gap-1.5 text-xs leading-5'
      )}
    >
      {labels.slice(0, limit).map((tag) => (
        <span
          key={tag}
          role="listitem"
          className={cn(
            'min-w-0 max-w-full rounded px-1.5 py-0.5',
            variant === 'player' && 'whitespace-normal break-words bg-black/20 text-[#eee7e2]/65',
            variant === 'detail' &&
              'whitespace-normal break-words bg-white/[0.045] px-2 text-[#c7b5ba]'
          )}
        >
          {tag}
        </span>
      ))}
      {remaining > 0 ? (
        <span
          role="listitem"
          aria-label={`另有 ${remaining} 个标签，可在简介中查看`}
          className={cn('shrink-0 self-center px-1 py-0.5 tabular-nums', 'text-[#eee7e2]/45')}
        >
          +{remaining}
        </span>
      ) : null}
    </div>
  );
}
