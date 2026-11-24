'use client';

/**
 * 面板里的记忆栏（对比稿 B 时间线）：这段故事的剧情记录，不显示轮次。
 * - 近、中两档的记录按时间排成一条线，最新在上；中档（已压成两三句）字小一号、颜色淡一点；
 * - 同一次记下的里程碑跟在那段记录下面（记录和里程碑带同一个内部轮次标记）；
 * - 远档（一句话一条）、记录已压走的里程碑、前情概要收在「更早的记忆」，默认收起。
 * - 标题右边「记忆要求」：玩家写对记忆的要求；写了在顶部显示一行，点它也能改。
 */
import { useState } from 'react';
import type {
  ConversationMemoryData,
  MemoryBarMilestone,
  MemoryBarRecord,
  MemoryBarState,
} from '@miniapp/shared';
import { cn } from '@/lib/utils';

interface MemoryGroups {
  recent: Array<{ record: MemoryBarRecord; milestones: MemoryBarMilestone[] }>;
  earlier: { records: MemoryBarRecord[]; milestones: MemoryBarMilestone[]; summary: string };
}

/** 按远近分组，最新在前；里程碑挂到同一次记下的那段记录上，挂不上的进「更早的记忆」。 */
export function groupMemory(state: MemoryBarState): MemoryGroups {
  const byTurn = new Map<number, MemoryBarMilestone[]>();
  for (const milestone of state.milestones)
    byTurn.set(milestone.turn, [...(byTurn.get(milestone.turn) ?? []), milestone]);
  const recentRecords = state.records.filter((record) => record.tier !== 'far').reverse();
  const attached = new Set(recentRecords.map((record) => record.to_turn));
  return {
    recent: recentRecords.map((record) => ({
      record,
      milestones: byTurn.get(record.to_turn) ?? [],
    })),
    earlier: {
      records: state.records.filter((record) => record.tier === 'far').reverse(),
      milestones: state.milestones.filter((m) => !attached.has(m.turn)).reverse(),
      summary: state.summary.trim(),
    },
  };
}

function MilestoneTag({ text }: { text: string }) {
  return (
    <li className="relative py-1.5 text-[12.5px] text-primary">
      <span
        className="absolute -left-[19px] top-[11px] size-[9px] rotate-45 bg-primary"
        aria-hidden
      />
      <span className="inline-block rounded-full bg-primary/15 px-2.5 py-0.5">里程碑 · {text}</span>
    </li>
  );
}

function EarlierMemory({ earlier }: { earlier: MemoryGroups['earlier'] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-[18px] bg-secondary dark:bg-white/[0.05]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[46px] w-full items-center justify-between px-3.5 text-[13.5px] font-semibold"
      >
        <span>更早的记忆</span>
        <span className="font-normal text-muted-foreground">{open ? '收起' : '展开'}</span>
      </button>
      {open ? (
        <div className="grid gap-2.5 px-3.5 pb-3.5 text-[12px] leading-relaxed text-foreground/75">
          {earlier.records.length || earlier.milestones.length ? (
            <ul className="grid list-disc gap-1 pl-4">
              {earlier.milestones.map((m, index) => (
                <li key={`m-${m.turn}-${index}`} className="text-primary/90">
                  {m.text}
                </li>
              ))}
              {earlier.records.map((record) => (
                <li key={`r-${record.from_turn}`}>{record.text}</li>
              ))}
            </ul>
          ) : null}
          {earlier.summary ? (
            <div className="rounded-[14px] bg-secondary dark:bg-black/20 px-3 py-2.5">
              <span className="mb-1 block text-[11.5px] text-muted-foreground">前情概要</span>
              <p className="whitespace-pre-wrap">{earlier.summary}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MemoryTimeline({
  memory,
  onEditRequest,
}: {
  memory: ConversationMemoryData;
  onEditRequest: () => void;
}) {
  const groups = memory.state ? groupMemory(memory.state) : null;
  const earlier = groups?.earlier;
  const hasEarlier = Boolean(
    earlier && (earlier.records.length || earlier.milestones.length || earlier.summary)
  );
  return (
    <section aria-label="记忆" className="mt-4 grid gap-3 first:mt-1">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">
          记忆
          <span className="ml-1 text-[11.5px] font-normal text-muted-foreground">· 最新在上</span>
        </h2>
        <button
          type="button"
          onClick={onEditRequest}
          className="min-h-11 pl-2 text-[12.5px] text-primary"
        >
          记忆要求 ›
        </button>
      </div>
      {memory.request ? (
        <button
          type="button"
          onClick={onEditRequest}
          className="w-full rounded-[14px] border border-dashed border-primary/40 bg-primary/[0.07] px-3 py-2 text-left text-[12px] leading-relaxed text-primary/90"
        >
          按你的要求记：{memory.request}
        </button>
      ) : null}
      {groups?.recent.length ? (
        <ol className="grid border-l-[1.5px] border-primary/35 pl-3.5">
          {groups.recent.map(({ record, milestones }) => (
            <li key={record.from_turn}>
              <div className="relative pb-3 pt-2">
                <span
                  className={cn(
                    'absolute rounded-full',
                    record.tier === 'near'
                      ? '-left-[19px] top-[14px] size-2 bg-mauve'
                      : '-left-[18px] top-[13px] size-1.5 bg-mauve/55'
                  )}
                  aria-hidden
                />
                <p
                  className={cn(
                    'whitespace-pre-wrap',
                    record.tier === 'near'
                      ? 'text-[12.5px] leading-[1.65]'
                      : 'text-[12px] leading-relaxed text-foreground/70'
                  )}
                >
                  {record.text}
                </p>
              </div>
              {milestones.length ? (
                <ul>
                  {milestones.map((m, index) => (
                    <MilestoneTag key={`${m.turn}-${index}`} text={m.text} />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-[18px] bg-secondary dark:bg-white/[0.05] px-3.5 py-3 text-[12.5px] text-muted-foreground">
          还没有记忆
        </p>
      )}
      {hasEarlier && earlier ? <EarlierMemory earlier={earlier} /> : null}
    </section>
  );
}
