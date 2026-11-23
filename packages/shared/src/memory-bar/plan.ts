/**
 * 一次记忆更新要做什么：由代码按上限算好，模型只负责写文字。
 *
 * - 总是写一条新的工作记忆，覆盖 [fromTurn, toTurn]（上次记录之后的这几轮）。
 * - 工作记忆已满 → 最早的 10 条合并成一条历史档案（archive）。
 * - 档案或里程碑放不下 → 最早的几条并进前情概要，前情概要整段重写（fold）。
 * - 老会话第一次生成：把旧回复里的记忆区原文也并进前情概要（legacyText）。
 */
import {
  MEMORY_BAR_LIMITS,
  type MemoryBarArchive,
  type MemoryBarEntry,
  type MemoryBarMilestone,
  type MemoryBarState,
} from './schema';

const L = MEMORY_BAR_LIMITS;

export interface MemoryBarTasks {
  fromTurn: number;
  toTurn: number;
  /** 要合并成一条历史档案的工作记忆（按时间顺序）；不需要合并为 null */
  archive: MemoryBarEntry[] | null;
  /** 要并进前情概要的内容；不需要改写前情概要为 null */
  fold: {
    archives: MemoryBarArchive[];
    milestones: MemoryBarMilestone[];
    /** 老会话第一次生成时，旧回复里记忆区的原文 */
    legacyText: string | null;
  } | null;
}

export function planMemoryBarUpdate(
  state: MemoryBarState,
  turns: { fromTurn: number; toTurn: number },
  legacyText: string | null = null
): MemoryBarTasks {
  const archive = state.entries.length >= L.entries ? state.entries.slice(0, L.entries) : null;
  const archivesAfter = state.archives.length + (archive ? 1 : 0);
  const foldArchives = state.archives.slice(0, Math.max(0, archivesAfter - L.archives));
  // 新里程碑最多 newMilestonesPerUpdate 条，先腾出位置
  const foldMilestones =
    state.milestones.length + L.newMilestonesPerUpdate > L.milestones
      ? state.milestones.slice(0, L.milestoneFoldCount)
      : [];
  const legacy = legacyText?.trim() ? legacyText.trim() : null;
  const fold =
    foldArchives.length || foldMilestones.length || legacy
      ? { archives: foldArchives, milestones: foldMilestones, legacyText: legacy }
      : null;
  return { fromTurn: turns.fromTurn, toTurn: turns.toTurn, archive, fold };
}
