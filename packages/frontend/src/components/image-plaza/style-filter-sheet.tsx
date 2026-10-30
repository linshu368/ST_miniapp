'use client';

import { ChevronDown } from 'lucide-react';
import { useMemo } from 'react';
import type { GetImagePlazaFeedData } from '@miniapp/shared';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export function StyleFilterSheet(props: {
  tags: GetImagePlazaFeedData['tags'];
  selected: string[];
  counts?: Record<string, number>;
  countsFailed?: boolean;
  onOpen?: () => void;
  onChange: (tags: string[]) => void;
}) {
  const groups = useMemo(() => {
    const grouped = new Map<
      string,
      {
        id: string;
        label: string;
        sortOrder: number;
        layout: 'chips' | 'grid';
        tags: GetImagePlazaFeedData['tags'];
      }
    >();
    for (const tag of props.tags) {
      // Backend-first 发布；若误回滚到旧 Backend，仍将无分组目录安全归入默认组。
      const groupId = tag.group_id || 'style';
      const group = grouped.get(groupId) ?? {
        id: groupId,
        label: tag.group_label || '风格',
        sortOrder: tag.group_sort_order ?? 0,
        layout: tag.group_layout || 'chips',
        tags: [],
      };
      group.tags.push(tag);
      grouped.set(groupId, group);
    }
    return [...grouped.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
    );
  }, [props.tags]);
  const allTagIds = useMemo(() => props.tags.map((tag) => tag.id), [props.tags]);
  const activeTagIds = props.selected.length ? props.selected : allTagIds;
  const activeTagSet = new Set(activeTagIds);

  const toggle = (tagId: string) => {
    const next = activeTagSet.has(tagId)
      ? activeTagIds.filter((id) => id !== tagId)
      : [...activeTagIds, tagId];
    // 空数组是「全部展示」的压缩状态；保留至少一个选项避免最后一项跳回全选。
    if (next.length === 0) return;
    props.onChange(next.length === allTagIds.length ? [] : next);
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          data-image-plaza-filter-trigger
          type="button"
          onClick={props.onOpen}
          className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-[13px] font-bold ${
            props.selected.length
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-border bg-card text-foreground'
          }`}
        >
          全部风格 <ChevronDown className="ml-1 inline size-3.5" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[86dvh] w-full max-w-3xl rounded-t-2xl px-3 pb-0"
      >
        <div className="grid grid-cols-3 items-center border-b border-border pb-3 pt-1">
          <button
            type="button"
            onClick={() => props.onChange([])}
            className="justify-self-start text-sm text-muted-foreground"
          >
            全部展示
          </button>
          <SheetTitle className="text-center text-base">筛选</SheetTitle>
          <SheetClose className="justify-self-end text-sm text-muted-foreground">关闭</SheetClose>
        </div>
        <SheetDescription className="sr-only">
          默认展示全部标签。点击标签取消展示，再次点击恢复；已保留的标签之间按任一匹配。
        </SheetDescription>
        <div className="overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          {groups.map((group) => (
            <section key={group.id} className="border-b border-border py-4 last:border-b-0">
              <div className="mb-3 flex items-baseline gap-2">
                <h3 className="text-sm font-bold text-muted-foreground">{group.label}</h3>
                <p className="text-[11px] text-muted-foreground/70">
                  {group.layout === 'grid' ? '可多选 · ' : ''}默认全部展示 · 点一下取消
                </p>
              </div>
              <div
                className={
                  group.layout === 'grid'
                    ? 'grid grid-cols-2 gap-2 min-[520px]:grid-cols-3'
                    : 'flex flex-wrap gap-2'
                }
              >
                {group.tags.map((tag) => {
                  const active = activeTagSet.has(tag.id);
                  const count = props.countsFailed ? '—' : (props.counts?.[tag.id] ?? '…');
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggle(tag.id)}
                      className={`border text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                        group.layout === 'grid'
                          ? 'min-h-14 rounded-xl px-3 py-2'
                          : 'rounded-full px-4 py-2'
                      } ${
                        active
                          ? 'border-primary/70 bg-primary/5 text-primary'
                          : 'border-border bg-muted/40 text-muted-foreground line-through opacity-55'
                      }`}
                    >
                      <span>{tag.label}</span>{' '}
                      <span className="text-xs font-normal opacity-75">{count}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
