/**
 * 解析记忆模型的输出并合进上一份记忆。
 *
 * 只检查长度和该写的有没有写，不检查内容格式（记忆栏是自由文字的剧情记录）。
 * 轮次、哪些段落被压缩或并进前情概要，都由代码按 planMemoryBarUpdate 的任务决定。
 * 没有进展（record 为空）是正常结果：剧情记录不变，「记到哪了」也不挪，下次接着从同一处看。
 * 不合格时返回问题清单（中文短句），交给兜底模型重试。
 */
import { z } from 'zod';
import type { MemoryBarTasks } from './plan';
import {
  MEMORY_BAR_LIMITS,
  MemoryBarStateSchema,
  type MemoryBarMilestone,
  type MemoryBarState,
} from './schema';

const L = MEMORY_BAR_LIMITS;
const chars = (value: string) => [...value].length;
const str = z.string().trim();

const OutputSchema = z.object({
  record: str.nullish(),
  milestones: z.array(str).nullish(),
  archive: str.nullish(),
  summary: str.nullish(),
});
type Output = z.infer<typeof OutputSchema>;

export type MemoryBarApplyResult =
  | {
      ok: true;
      state: MemoryBarState;
      /** 有没有任何变化（新记录、新里程碑、压缩或改写前情概要） */
      changed: boolean;
      /** 这次记下了新的剧情 */
      recorded: boolean;
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

const key = (value: string) => value.replace(/[\s，。、！？,.!?「」“”"'（）()：:-]/g, '');

function checkOutput(o: Output, tasks: MemoryBarTasks): string[] {
  const issues: string[] = [];
  if (o.record && chars(o.record) > L.entryMaxChars)
    issues.push(`剧情记录太长，不超过 ${L.entryChars} 字`);
  if (tasks.archive) {
    if (!o.archive) issues.push('要求压缩最早几段剧情记录，但没有写 archive');
    else if (chars(o.archive) > L.archiveMaxChars)
      issues.push(`压缩后的剧情太长，不超过 ${L.archiveChars} 字`);
  }
  if (tasks.fold) {
    if (!o.summary) issues.push('要求改写前情概要，但没有写 summary');
    else if (chars(o.summary) > L.summaryMaxChars)
      issues.push(`前情概要太长，不超过 ${L.summaryChars} 字`);
  }
  return issues;
}

function newMilestones(o: Output, kept: MemoryBarMilestone[], turn: number): MemoryBarMilestone[] {
  const seen = new Set(kept.map((m) => key(m.text)));
  const out: MemoryBarMilestone[] = [];
  for (const line of o.milestones ?? []) {
    if (out.length >= L.newMilestonesPerUpdate) break;
    if (!line || chars(line) > L.milestoneMaxChars || seen.has(key(line))) continue;
    seen.add(key(line));
    out.push({ turn, text: line });
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
    return {
      ok: false,
      issues: ['没有输出符合要求的 JSON（record、milestones、archive、summary）'],
    };
  const o = parsed.data;
  const issues = checkOutput(o, tasks);
  if (issues.length) return { ok: false, issues };

  const record = o.record
    ? [{ from_turn: tasks.fromTurn, to_turn: tasks.toTurn, text: o.record }]
    : [];
  const merged = tasks.archive ?? [];
  const archive =
    tasks.archive && o.archive
      ? [
          {
            from_turn: merged[0]!.from_turn,
            to_turn: merged[merged.length - 1]!.to_turn,
            text: o.archive,
          },
        ]
      : [];
  const keptMilestones = state.milestones.slice(tasks.fold?.milestones.length ?? 0);
  const added = newMilestones(o, keptMilestones, tasks.toTurn);
  // 记下了新剧情 → 这次看过的都算记过；没进展 → 不挪，下次接着从同一处看
  const covered = Math.max(
    state.covered_turn,
    record.length ? tasks.toTurn : 0,
    tasks.fold?.legacy?.turn ?? 0
  );
  const next = MemoryBarStateSchema.safeParse({
    version: 1,
    covered_turn: covered,
    summary: tasks.fold ? o.summary! : state.summary,
    archives: [...state.archives.slice(tasks.fold?.archives.length ?? 0), ...archive],
    milestones: [...keptMilestones, ...added].slice(-L.milestones),
    entries: [...state.entries.slice(merged.length), ...record],
  });
  if (!next.success) return { ok: false, issues: ['记忆整理后超出上限，请写得更简短'] };
  return {
    ok: true,
    state: next.data,
    changed: Boolean(record.length || added.length || tasks.archive || tasks.fold),
    recorded: record.length > 0,
    newMilestones: added.length,
  };
}
