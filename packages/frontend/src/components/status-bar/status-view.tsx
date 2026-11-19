'use client';

/**
 * 状态内容渲染（雾面玻璃风格）。只看文本本身的写法，不查模板：68/100 是进度条、45% 是百分比、
 * 暧昧（3/5）是阶段……解析全部用 shared 的 parseStatusBody，和状态模型的提示词、校验同源。
 * 写歪的行退化成普通文字；内容一律按文本渲染，不解析 HTML。
 */
import type { ReactNode } from 'react';
import {
  parseStatusBody,
  type StatusEntry,
  type StatusSection,
  type StatusValue,
} from '@miniapp/shared';
import { cn } from '@/lib/utils';

function Delta({ value, percent }: { value: number | null; percent?: boolean }) {
  if (!value) return null;
  return (
    <span
      className={cn(
        'ml-1.5 text-[11.5px] tabular-nums',
        value > 0 ? 'text-mauve' : 'text-muted-foreground'
      )}
    >
      {value > 0 ? '↑' : '↓'}
      {Math.abs(value)}
      {percent ? '%' : ''}
    </span>
  );
}

function Meter({ bucket, thin }: { bucket: number; thin?: boolean }) {
  return (
    <span
      className={cn('block overflow-hidden rounded-full bg-white/10', thin ? 'h-1' : 'h-1.5')}
      aria-hidden
    >
      <span
        className="block h-full rounded-full bg-gradient-to-r from-mauve to-primary transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${bucket}%` }}
      />
    </span>
  );
}

function ValueView({ value }: { value: StatusValue }): ReactNode {
  switch (value.kind) {
    case 'bar':
      return (
        <span
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5"
          aria-label={`${value.current}/${value.max}`}
        >
          <Meter bucket={value.bucket} />
          <span className="text-[13px] tabular-nums">
            {value.current}/{value.max}
            <Delta value={value.delta} />
          </span>
        </span>
      );
    case 'percent':
      return (
        <span
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5"
          aria-label={`${value.current}%`}
        >
          <Meter bucket={value.bucket} thin />
          <span className="text-[15px] font-semibold tabular-nums">
            {value.current}%
            <Delta value={value.delta} percent />
          </span>
        </span>
      );
    case 'number':
      return (
        <span className="tabular-nums">
          <span className="text-[17px] font-semibold">{value.current}</span>
          {value.unit ? (
            <span className="ml-0.5 text-[12px] text-muted-foreground">{value.unit}</span>
          ) : null}
          <Delta value={value.delta} />
        </span>
      );
    case 'stars':
      return (
        <span
          className="tracking-[2px] text-mauve"
          aria-label={`${value.filled}/${value.total} 星`}
        >
          {'★'.repeat(value.filled)}
          <span className="text-white/15">{'★'.repeat(value.total - value.filled)}</span>
        </span>
      );
    case 'stage':
      return (
        <span className="grid gap-1">
          <span
            className="grid grid-flow-col gap-[3px]"
            style={{ gridAutoColumns: '1fr' }}
            aria-hidden
          >
            {Array.from({ length: value.total }, (_, index) => (
              <span
                key={index}
                className={cn(
                  'h-[5px] rounded-sm',
                  index < value.step ? 'bg-gradient-to-r from-mauve to-primary' : 'bg-white/10'
                )}
              />
            ))}
          </span>
          <span className="text-[13px]">
            {value.label}
            <span className="ml-1 text-[11.5px] text-muted-foreground">
              {value.step}/{value.total}
            </span>
          </span>
        </span>
      );
    case 'tags':
      return (
        <span className="flex flex-wrap gap-1.5">
          {value.tags.map((tag, index) => (
            <span
              key={`${tag}-${index}`}
              className="rounded-full bg-mauve/15 px-2.5 py-px text-[12px] text-mauve"
            >
              {tag}
            </span>
          ))}
        </span>
      );
    case 'text':
      return <span className={cn(value.wide && 'italic text-foreground/85')}>{value.text}</span>;
    default:
      return null;
  }
}

function Entries({ entries }: { entries: StatusEntry[] }) {
  const out: ReactNode[] = [];
  let list: {
    kind: 'check' | 'bullet';
    items: Extract<StatusEntry, { kind: 'check' | 'bullet' }>[];
  } | null = null;
  const flush = () => {
    if (!list) return;
    const current = list;
    out.push(
      <ul key={`list-${out.length}`} className="grid gap-1 text-[13.5px]">
        {current.items.map((item, index) => (
          <li
            key={index}
            className={cn(
              'grid grid-cols-[1.2em_minmax(0,1fr)]',
              item.kind === 'check' &&
                item.done &&
                'text-muted-foreground line-through decoration-white/20'
            )}
          >
            <span
              aria-hidden
              className={cn(
                item.kind === 'check' && item.done ? 'text-mauve' : 'text-muted-foreground'
              )}
            >
              {item.kind === 'check' ? (item.done ? '✓' : '○') : '·'}
            </span>
            <span className="min-w-0 break-words">{item.text}</span>
          </li>
        ))}
      </ul>
    );
    list = null;
  };
  entries.forEach((entry, index) => {
    if (entry.kind === 'check' || entry.kind === 'bullet') {
      if (!list || list.kind !== entry.kind) {
        flush();
        list = { kind: entry.kind, items: [] };
      }
      list.items.push(entry);
      return;
    }
    flush();
    if (entry.kind === 'label')
      out.push(
        <div key={index} className="text-[12.5px] text-muted-foreground">
          {entry.text}
        </div>
      );
    else if (entry.kind === 'note')
      out.push(
        <p key={index} className="m-0 break-words text-[13px] text-foreground/80">
          {entry.text}
        </p>
      );
    else {
      const wide = entry.value.kind === 'text' && entry.value.wide;
      out.push(
        <div
          key={index}
          className={cn(
            'grid min-w-0 gap-2.5 text-[14px]',
            wide ? 'grid-cols-1 gap-0.5' : 'grid-cols-[4.6em_minmax(0,1fr)] items-center'
          )}
        >
          <span className="break-words text-[12.5px] text-muted-foreground">{entry.label}</span>
          <span className="min-w-0 break-words">
            <ValueView value={entry.value} />
          </span>
        </div>
      );
    }
  });
  flush();
  return <>{out}</>;
}

export function StatusSectionCard({
  section,
  children,
}: {
  section: StatusSection;
  children?: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-2.5 rounded-2xl bg-white/[0.05] p-3 ring-1 ring-inset ring-white/[0.06]">
      {section.title ? (
        <div className="text-[12px] font-semibold tracking-wide text-mauve">{section.title}</div>
      ) : null}
      <Entries entries={section.entries} />
      {children}
    </section>
  );
}

/** 渲染一段状态文本；旧格式（<details>）不在这里显示。 */
export function StatusView({ text, className }: { text: string; className?: string }) {
  const parsed = parseStatusBody(text);
  if (parsed.format !== 'v2' || parsed.sections.length === 0) return null;
  return (
    <div className={cn('grid gap-2.5', className)}>
      {parsed.sections.map((section, index) => (
        <StatusSectionCard key={`${section.title ?? ''}-${index}`} section={section} />
      ))}
    </div>
  );
}

/** 单个项目的预览（编辑器里用）。 */
export function StatusEntryPreview({ text }: { text: string }) {
  const parsed = parseStatusBody(text);
  if (parsed.format !== 'v2') return null;
  return <Entries entries={parsed.sections.flatMap((section) => section.entries)} />;
}
