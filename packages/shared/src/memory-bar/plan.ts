/**
 * 一次记忆检查要做什么：由代码按上限算好，模型只负责判断有没有进展、写文字。
 *
 * - 看的范围：上一件记下的事之后的所有轮次（covered_turn 之后）。中间几次判断「没进展」不挪起点，
 *   零碎的小变化会攒到真正有进展的那一次一起记；一直没进展就一直不记。
 * - 近期事件快满 → 最早几件合并成一条历史档案（archive）。
 * - 档案或里程碑放不下 → 最早的几条并进前情概要，前情概要整段重写（fold）。
 * - 老会话第一次检查：把旧回复里的记忆区原文并进前情概要，起点从那条回复之后算（legacy）。
 */
import {
  MEMORY_BAR_LIMITS,
  isEmptyMemoryBar,
  type MemoryBarArchive,
  type MemoryBarEntry,
  type MemoryBarMilestone,
  type MemoryBarState,
} from './schema';

const L = MEMORY_BAR_LIMITS;

export interface MemoryBarLegacy {
  /** 旧回复里记忆区的原文 */
  text: string;
  /** 那条回复是第几轮 */
  turn: number;
}

export interface MemoryBarTasks {
  /** 这次从第几轮看到第几轮（只在内部用，不给玩家看） */
  fromTurn: number;
  toTurn: number;
  /** 要合并成一条历史档案的近期事件（按时间顺序）；不需要合并为 null */
  archive: MemoryBarEntry[] | null;
  /** 要并进前情概要的内容；不需要改写前情概要为 null */
  fold: {
    archives: MemoryBarArchive[];
    milestones: MemoryBarMilestone[];
    legacy: MemoryBarLegacy | null;
  } | null;
}

/** 返回 null：从上次记录到现在没有新轮次，不用检查 */
export function planMemoryBarUpdate(
  state: MemoryBarState,
  latestTurn: number,
  legacyInput: MemoryBarLegacy | null = null
): MemoryBarTasks | null {
  const legacy =
    legacyInput?.text.trim() && isEmptyMemoryBar(state)
      ? { text: legacyInput.text.trim(), turn: legacyInput.turn }
      : null;
  const fromTurn = Math.max(state.covered_turn, legacy?.turn ?? 0) + 1;
  if (fromTurn > latestTurn) return null;
  // 这次最多新记 newEntriesPerUpdate 件，先腾出位置
  const archive =
    state.entries.length + L.newEntriesPerUpdate > L.entries
      ? state.entries.slice(0, L.archiveMergeCount)
      : null;
  const archivesAfter = state.archives.length + (archive ? 1 : 0);
  const foldArchives = state.archives.slice(0, Math.max(0, archivesAfter - L.archives));
  const foldMilestones =
    state.milestones.length + L.newMilestonesPerUpdate > L.milestones
      ? state.milestones.slice(0, L.milestoneFoldCount)
      : [];
  const fold =
    foldArchives.length || foldMilestones.length || legacy
      ? { archives: foldArchives, milestones: foldMilestones, legacy }
      : null;
  return { fromTurn, toTurn: latestTurn, archive, fold };
}
