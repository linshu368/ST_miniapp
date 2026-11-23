/**
 * 解析记忆模型的输出并合进上一份记忆。
 *
 * 模型只写文字；轮次、哪些条目被合并或并进前情概要都由代码按 planMemoryBarUpdate 的任务决定。
 * 不合格时返回问题清单（中文短句），交给兜底模型重试。
 */
import { z } from 'zod';
import type { MemoryBarTasks } from './plan';
import {
  MEMORY_BAR_LIMITS,
  MemoryBarStateSchema,
  type MemoryBarArchive,
  type MemoryBarMilestone,
  type MemoryBarState,
} from './schema';

const L = MEMORY_BAR_LIMITS;
const chars = (value: string) => [...value].length;
const str = z.string().trim();

const OutputSchema = z.object({
  entry: z.object({ time: str, feeling: str, acts: str, state: str, hooks: str }),
  milestones: z.array(z.object({ time: str, who: str, text: str })).nullish(),
  archive: z
    .object({ time_range: str, line: str, intimacy: str, changes: str, hooks: str })
    .nullish(),
  summary: str.nullish(),
});

export type MemoryBarApplyResult =
  | { ok: true; state: MemoryBarState; newMilestones: number }
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

function checkFields(
  fields: Record<string, string>,
  labels: Record<string, string>,
  max: number,
  where: string
): string[] {
  const issues: string[] = [];
  for (const [name, label] of Object.entries(labels)) {
    const value = fields[name] ?? '';
    if (!value) issues.push(`${where}缺了「${label}」`);
    else if (chars(value) > max) issues.push(`${where}「${label}」太长，不超过 ${max} 字`);
  }
  return issues;
}

const ENTRY_LABELS = {
  feeling: '感情进展',
  acts: '做过什么',
  state: '留下状态',
  hooks: '悬念与承诺',
};
const ARCHIVE_LABELS = {
  line: '感情线走向',
  intimacy: '亲密经历概述',
  changes: '累计变化',
  hooks: '仍有效的悬念与承诺',
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
      time: [...(m.time || '不详')].slice(0, L.timeMaxChars).join(''),
      who: [...(m.who || '不详')].slice(0, L.whoMaxChars).join(''),
      text: m.text,
    });
  }
  return out;
}

export function applyMemoryBarOutput(
  state: MemoryBarState,
  tasks: MemoryBarTasks,
  output: string
): MemoryBarApplyResult {
  const parsed = OutputSchema.safeParse(extractJson(output));
  if (!parsed.success)
    return { ok: false, issues: ['没有输出符合要求的 JSON（必须有 entry 和它的五项）'] };
  const o = parsed.data;
  const issues = checkFields(o.entry, ENTRY_LABELS, L.entryFieldMaxChars, '工作记忆');
  if (tasks.archive) {
    if (!o.archive) issues.push('要求合并历史档案，但没有写 archive');
    else issues.push(...checkFields(o.archive, ARCHIVE_LABELS, L.archiveFieldMaxChars, '历史档案'));
  }
  if (tasks.fold) {
    if (!o.summary) issues.push('要求改写前情概要，但没有写 summary');
    else if (chars(o.summary) > L.summaryMaxChars)
      issues.push(`前情概要太长，不超过 ${L.summaryChars} 字`);
  }
  if (issues.length) return { ok: false, issues };

  const entry = {
    from_turn: tasks.fromTurn,
    to_turn: tasks.toTurn,
    time: [...(o.entry.time || '不详')].slice(0, L.timeMaxChars).join(''),
    feeling: o.entry.feeling,
    acts: o.entry.acts,
    state: o.entry.state,
    hooks: o.entry.hooks,
  };
  const merged = tasks.archive ?? [];
  const archive: MemoryBarArchive[] =
    tasks.archive && o.archive
      ? [
          {
            from_turn: merged[0]!.from_turn,
            to_turn: merged[merged.length - 1]!.to_turn,
            time_range: [...(o.archive.time_range || '不详')].slice(0, L.timeMaxChars * 2).join(''),
            line: o.archive.line,
            intimacy: o.archive.intimacy,
            changes: o.archive.changes,
            hooks: o.archive.hooks,
          },
        ]
      : [];
  const keptMilestones = state.milestones.slice(tasks.fold?.milestones.length ?? 0);
  const added = newMilestones(o, keptMilestones, tasks.toTurn);
  const next = MemoryBarStateSchema.safeParse({
    version: 1,
    summary: tasks.fold ? o.summary! : state.summary,
    archives: [...state.archives.slice(tasks.fold?.archives.length ?? 0), ...archive],
    milestones: [...keptMilestones, ...added].slice(-L.milestones),
    entries: [...state.entries.slice(merged.length), entry],
  });
  if (!next.success) return { ok: false, issues: ['记忆整理后超出上限，请写得更简短'] };
  return { ok: true, state: next.data, newMilestones: added.length };
}
