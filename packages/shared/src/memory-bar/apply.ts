/**
 * 解析记忆模型的输出并合进上一份记忆。
 *
 * 只检查长度和该写的有没有写，不检查内容格式（记忆栏是自由文字的剧情记录）。
 * 轮次、哪些记录压短或并进前情概要，都由代码按 planMemoryBarUpdate 的任务决定。
 * 没有进展（record 为空）是正常结果：记忆不变，「记到哪了」也不挪，下次接着从同一处看；
 * 这时压短和前情概要都不用（没有新的一段，前面的也就不往远挪），只有旧记忆区要照样并进来。
 * 最后一次机会（degrade）：压短项缺失或超长时不整单作废——新的一段照写，那一段沿用原文、保留原档位，
 * 下次检查会再压；前情概要超长、新记录超长仍算不合格（它们没有「沿用」的办法）。
 * 不合格时返回问题清单（中文短句），交给兜底模型重试；同时给出稳定的问题码和所在层（format 不是
 * 合格 JSON / content 内容检查没过），只用于质量监控统计。
 */
import { z } from 'zod';
import type { MemoryBarTasks } from './plan';
import {
  MEMORY_BAR_LIMITS,
  MemoryBarStateSchema,
  type MemoryBarMilestone,
  type MemoryBarRecord,
  type MemoryBarState,
} from './schema';

const L = MEMORY_BAR_LIMITS;
const chars = (value: string) => [...value].length;
const str = z.string().trim();

const OutputSchema = z.object({
  record: str.nullish(),
  milestones: z.array(str).nullish(),
  compress: z.record(str).nullish(),
  summary: str.nullish(),
});
type Output = z.infer<typeof OutputSchema>;

/** 内容检查没过的原因（稳定码，和 issues 文案一一对应）。 */
export type MemoryBarProblem =
  | 'json_invalid'
  | 'record_too_long'
  | 'compress_missing'
  | 'compress_too_long'
  | 'summary_missing'
  | 'summary_too_long'
  | 'over_limit';

export type MemoryBarApplyResult =
  | {
      ok: true;
      state: MemoryBarState;
      /** 有没有任何变化 */
      changed: boolean;
      /** 这次记下了新的剧情 */
      recorded: boolean;
      newMilestones: number;
      /** 降级沿用了原文的压短项的原因（compress_missing / compress_too_long）；没降级为空 */
      degraded: MemoryBarProblem[];
    }
  | {
      ok: false;
      issues: string[];
      stage: 'format' | 'content';
      problems: MemoryBarProblem[];
    };

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

/** 这次要不要写前情概要：记下新的一段且有要并的，或者有旧记忆区 */
const needsSummary = (tasks: MemoryBarTasks, recorded: boolean) =>
  Boolean(
    tasks.fold &&
    (tasks.fold.legacy || (recorded && (tasks.fold.records.length || tasks.fold.milestones.length)))
  );

export interface MemoryBarApplyOptions {
  /** 最后一次机会：压短项缺失或超长时沿用原文，不退回 */
  degrade?: boolean;
}

interface Checked {
  issues: string[];
  problems: MemoryBarProblem[];
  /** 降级沿用原文的压短项：编号 → 原因 */
  kept: Map<string, MemoryBarProblem>;
}

function checkOutput(o: Output, tasks: MemoryBarTasks, degrade: boolean): Checked {
  const out: Checked = { issues: [], problems: [], kept: new Map() };
  const add = (problem: MemoryBarProblem, issue: string) => {
    out.issues.push(issue);
    if (!out.problems.includes(problem)) out.problems.push(problem);
  };
  const near = L.tiers.near;
  if (o.record && chars(o.record) > near.maxChars)
    add('record_too_long', `剧情记录太长，不超过 ${near.chars} 字`);
  if (o.record)
    for (const task of tasks.compress) {
      const tier = L.tiers[task.to];
      const value = o.compress?.[task.key];
      const problem: MemoryBarProblem | null = !value
        ? 'compress_missing'
        : chars(value) > tier.maxChars
          ? 'compress_too_long'
          : null;
      if (!problem) continue;
      if (degrade) out.kept.set(task.key, problem);
      else
        add(
          problem,
          problem === 'compress_missing'
            ? `要求压短记录 ${task.key}，但 compress 里没有写`
            : `压短后的记录 ${task.key} 太长，${tier.style}、不超过 ${tier.chars} 字`
        );
    }
  if (needsSummary(tasks, Boolean(o.record))) {
    if (!o.summary) add('summary_missing', '要求改写前情概要，但没有写 summary');
    else if (chars(o.summary) > L.summaryMaxChars)
      add('summary_too_long', `前情概要太长，不超过 ${L.summaryChars} 字`);
  }
  return out;
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

/** 记下新的一段：前面的往远挪（压短或并走），新的放最后 */
function shiftRecords(
  state: MemoryBarState,
  tasks: MemoryBarTasks,
  o: Output,
  kept: Map<string, MemoryBarProblem>
): MemoryBarRecord[] {
  const folded = tasks.fold?.records.length ?? 0;
  const compressed = new Map(tasks.compress.map((t) => [t.index, t]));
  const shifted = state.records.flatMap((record, index) => {
    if (index < folded) return [];
    const task = compressed.get(index);
    // 降级沿用的那段原样保留（原档位、原文），下次检查还会再压
    if (!task || kept.has(task.key)) return [record];
    return [{ ...record, tier: task.to, text: o.compress![task.key]! }];
  });
  return [
    ...shifted,
    { from_turn: tasks.fromTurn, to_turn: tasks.toTurn, tier: 'near' as const, text: o.record! },
  ];
}

export function applyMemoryBarOutput(
  state: MemoryBarState,
  tasks: MemoryBarTasks,
  output: string,
  options: MemoryBarApplyOptions = {}
): MemoryBarApplyResult {
  const parsed = OutputSchema.safeParse(extractJson(output));
  if (!parsed.success)
    return {
      ok: false,
      issues: ['没有输出符合要求的 JSON（record、milestones、compress、summary）'],
      stage: 'format',
      problems: ['json_invalid'],
    };
  const o = parsed.data;
  const checked = checkOutput(o, tasks, Boolean(options.degrade));
  if (checked.issues.length)
    return { ok: false, stage: 'content', issues: checked.issues, problems: checked.problems };

  const recorded = Boolean(o.record);
  const legacyTurn = tasks.fold?.legacy?.turn ?? 0;
  if (!recorded && !legacyTurn)
    return { ok: true, state, changed: false, recorded: false, newMilestones: 0, degraded: [] };

  const keptMilestones = recorded
    ? state.milestones.slice(tasks.fold?.milestones.length ?? 0)
    : state.milestones;
  const added = recorded ? newMilestones(o, keptMilestones, tasks.toTurn) : [];
  const next = MemoryBarStateSchema.safeParse({
    version: 1,
    // 记下了新剧情 → 这次看过的都算记过；只并了旧记忆区 → 从那条回复之后接着看
    covered_turn: Math.max(state.covered_turn, recorded ? tasks.toTurn : 0, legacyTurn),
    summary: needsSummary(tasks, recorded) ? o.summary! : state.summary,
    milestones: [...keptMilestones, ...added],
    records: recorded ? shiftRecords(state, tasks, o, checked.kept) : state.records,
  });
  if (!next.success)
    return {
      ok: false,
      issues: ['记忆整理后超出上限，请写得更简短'],
      stage: 'content',
      problems: ['over_limit'],
    };
  return {
    ok: true,
    state: next.data,
    changed: true,
    recorded,
    newMilestones: added.length,
    degraded: [...new Set(checked.kept.values())],
  };
}
