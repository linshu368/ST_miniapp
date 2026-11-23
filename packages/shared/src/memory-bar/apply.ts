/**
 * 解析记忆模型的输出并合进上一份记忆。
 *
 * 模型判断有没有进展、写文字；轮次、哪些条目被合并或并进前情概要都由代码按 planMemoryBarUpdate 的任务决定。
 * 没有进展（events 为空）是正常结果：记忆不变，「记到哪了」也不挪，下次接着从同一处看。
 * 不合格时返回问题清单（中文短句），交给兜底模型重试。
 */
import { z } from 'zod';
import type { MemoryBarTasks } from './plan';
import {
  MEMORY_BAR_LIMITS,
  MemoryBarStateSchema,
  type MemoryBarArchive,
  type MemoryBarEntry,
  type MemoryBarMilestone,
  type MemoryBarState,
} from './schema';

const L = MEMORY_BAR_LIMITS;
const chars = (value: string) => [...value].length;
const str = z.string().trim();

const EventSchema = z.object({
  time: str.default(''),
  title: str.default(''),
  feeling: str.default(''),
  acts: str.default(''),
  state: str.default(''),
  hooks: str.default(''),
});

const OutputSchema = z.object({
  events: z.array(EventSchema).nullish(),
  milestones: z.array(z.object({ time: str, who: str, text: str })).nullish(),
  archive: z
    .object({ time_range: str, line: str, intimacy: str, changes: str, hooks: str })
    .nullish(),
  summary: str.nullish(),
});

export type MemoryBarApplyResult =
  | {
      ok: true;
      state: MemoryBarState;
      /** 有没有任何变化（新事件、新里程碑、合并或改写前情概要） */
      changed: boolean;
      newEvents: number;
      newMilestones: number;
    }
  | { ok: false; issues: string[] };

/** 去掉代码块围栏，取第一个 { 到最后一个 } */
function extractJson(output: string): unknown {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

const key = (value: string) => value.replace(/[\s，。、！？,.!?「」“”"'（）()]/g, '');
const cut = (value: string, max: number) => [...(value || '不详')].slice(0, max).join('');

function checkFields(
  fields: Record<string, string>,
  labels: Record<string, [string, number]>,
  where: string
): string[] {
  const issues: string[] = [];
  for (const [name, [label, max]] of Object.entries(labels)) {
    const value = fields[name] ?? '';
    if (!value) issues.push(`${where}缺了「${label}」（没有就写"无"）`);
    else if (chars(value) > max) issues.push(`${where}「${label}」太长，不超过 ${max} 字`);
  }
  return issues;
}

const EVENT_LABELS: Record<string, [string, number]> = {
  title: ['事件', L.entryTitleMaxChars],
  feeling: ['感情进展', L.entryFieldMaxChars],
  acts: ['做过什么', L.entryFieldMaxChars],
  state: ['留下状态', L.entryFieldMaxChars],
  hooks: ['悬念与承诺', L.entryFieldMaxChars],
};
const ARCHIVE_LABELS: Record<string, [string, number]> = {
  line: ['感情线走向', L.archiveFieldMaxChars],
  intimacy: ['亲密经历概述', L.archiveFieldMaxChars],
  changes: ['累计变化', L.archiveFieldMaxChars],
  hooks: ['仍有效的悬念与承诺', L.archiveFieldMaxChars],
};

function newMilestones(
  output: z.infer<typeof OutputSchema>,
  kept: MemoryBarMilestone[],
  turn: number
): MemoryBarMilestone[] {
  const seen = new Set(kept.map((m) => key(m.text)));
  const out: MemoryBarMilestone[] = [];
  for (const m of output.milestones ?? []) {
    if (out.length >= L.newMilestonesPerUpdate) break;
    if (!m.text || chars(m.text) > L.milestoneMaxChars || seen.has(key(m.text))) continue;
    seen.add(key(m.text));
    out.push({
      turn,
      time: cut(m.time, L.timeMaxChars),
      who: cut(m.who, L.whoMaxChars),
      text: m.text,
    });
  }
  return out;
}

function checkOutput(o: z.infer<typeof OutputSchema>, tasks: MemoryBarTasks): string[] {
  const issues: string[] = [];
  const events = o.events ?? [];
  if (events.length > L.newEntriesPerUpdate)
    issues.push(`events 最多 ${L.newEntriesPerUpdate} 件，只记真正的进展`);
  events.forEach((e, k) =>
    issues.push(...checkFields(e, EVENT_LABELS, events.length > 1 ? `第 ${k + 1} 件事` : '事件'))
  );
  if (tasks.archive) {
    if (!o.archive) issues.push('要求合并历史档案，但没有写 archive');
    else issues.push(...checkFields(o.archive, ARCHIVE_LABELS, '历史档案'));
  }
  if (tasks.fold) {
    if (!o.summary) issues.push('要求改写前情概要，但没有写 summary');
    else if (chars(o.summary) > L.summaryMaxChars)
      issues.push(`前情概要太长，不超过 ${L.summaryChars} 字`);
  }
  return issues;
}

export function applyMemoryBarOutput(
  state: MemoryBarState,
  tasks: MemoryBarTasks,
  output: string
): MemoryBarApplyResult {
  const parsed = OutputSchema.safeParse(extractJson(output));
  if (!parsed.success)
    return {
      ok: false,
      issues: ['没有输出符合要求的 JSON（events、milestones、archive、summary）'],
    };
  const o = parsed.data;
  const issues = checkOutput(o, tasks);
  if (issues.length) return { ok: false, issues };

  const events: MemoryBarEntry[] = (o.events ?? []).map((e) => ({
    from_turn: tasks.fromTurn,
    to_turn: tasks.toTurn,
    time: cut(e.time, L.timeMaxChars),
    title: e.title,
    feeling: e.feeling,
    acts: e.acts,
    state: e.state,
    hooks: e.hooks,
  }));
  const merged = tasks.archive ?? [];
  const archive: MemoryBarArchive[] =
    tasks.archive && o.archive
      ? [
          {
            from_turn: merged[0]!.from_turn,
            to_turn: merged[merged.length - 1]!.to_turn,
            time_range: cut(o.archive.time_range, L.timeMaxChars * 2),
            line: o.archive.line,
            intimacy: o.archive.intimacy,
            changes: o.archive.changes,
            hooks: o.archive.hooks,
          },
        ]
      : [];
  const keptMilestones = state.milestones.slice(tasks.fold?.milestones.length ?? 0);
  const added = newMilestones(o, keptMilestones, tasks.toTurn);
  // 记下了事 → 这次看过的轮次都算记过；没进展 → 不挪，下次接着从同一处看
  const covered = Math.max(
    state.covered_turn,
    events.length ? tasks.toTurn : 0,
    tasks.fold?.legacy?.turn ?? 0
  );
  const next = MemoryBarStateSchema.safeParse({
    version: 1,
    covered_turn: covered,
    summary: tasks.fold ? o.summary! : state.summary,
    archives: [...state.archives.slice(tasks.fold?.archives.length ?? 0), ...archive],
    milestones: [...keptMilestones, ...added].slice(-L.milestones),
    entries: [...state.entries.slice(merged.length), ...events],
  });
  if (!next.success) return { ok: false, issues: ['记忆整理后超出上限，请写得更简短'] };
  const changed = Boolean(events.length || added.length || tasks.archive || tasks.fold);
  return {
    ok: true,
    state: next.data,
    changed,
    newEvents: events.length,
    newMilestones: added.length,
  };
}
