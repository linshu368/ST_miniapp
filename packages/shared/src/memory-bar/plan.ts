/**
 * 一次记忆检查要做什么：由代码按档位和上限算好，模型只负责判断有没有进展、写文字。
 *
 * - 看的范围：上一段记下的剧情之后的所有轮次（covered_turn 之后）。中间几次判断「没进展」不挪起点，
 *   零碎的小变化会攒到真正有进展的那一次一起记；一直没进展就一直不记。
 * - 这次如果记下新的一段，前面的每段都往远挪一位：跨进下一档的压短（近→中两三句、中→远一句），
 *   挪出「远」的并进前情概要（fold）。没记新的就都不挪，这些整理也不用。
 * - 里程碑放不下 → 最早几条并进前情概要。
 * - 老会话第一次检查：把旧回复里的记忆区原文并进前情概要，起点从那条回复之后算（legacy）；有没有进展都要做。
 */
import {
  MEMORY_BAR_LIMITS,
  isEmptyMemoryBar,
  memoryBarTierAt,
  memoryBarTierRank,
  type MemoryBarMilestone,
  type MemoryBarRecord,
  type MemoryBarState,
  type MemoryBarTier,
} from './schema';

const L = MEMORY_BAR_LIMITS;

export interface MemoryBarLegacy {
  /** 旧回复里记忆区的原文 */
  text: string;
  /** 那条回复是第几轮 */
  turn: number;
}

export interface MemoryBarCompressTask {
  /** 输出里用的编号：A、B、C… */
  key: string;
  /** 在 state.records 里的下标 */
  index: number;
  record: MemoryBarRecord;
  to: MemoryBarTier;
}

export interface MemoryBarTasks {
  /** 这次从第几轮看到第几轮（只在内部用，不给玩家看） */
  fromTurn: number;
  toTurn: number;
  /** 记下新的一段后要压短的记录（没记新的就不用） */
  compress: MemoryBarCompressTask[];
  /** 要并进前情概要的内容；不需要改写前情概要为 null */
  fold: {
    /** 挪出「远」的记录、放不下的最早几条里程碑（记下新的一段才需要） */
    records: MemoryBarRecord[];
    milestones: MemoryBarMilestone[];
    /** 旧记忆区原文（有没有进展都要并） */
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

  const n = state.records.length;
  const compress: MemoryBarCompressTask[] = [];
  const foldRecords: MemoryBarRecord[] = [];
  state.records.forEach((record, index) => {
    // 新的一段排在最后，这一段就往前数第 n - index 段
    const to = memoryBarTierAt(n - index);
    if (!to) foldRecords.push(record);
    else if (memoryBarTierRank(to) > memoryBarTierRank(record.tier))
      compress.push({ key: String.fromCharCode(65 + compress.length), index, record, to });
  });
  const foldMilestones =
    state.milestones.length + L.newMilestonesPerUpdate > L.milestones
      ? state.milestones.slice(0, L.milestoneFoldCount)
      : [];
  const fold =
    foldRecords.length || foldMilestones.length || legacy
      ? { records: foldRecords, milestones: foldMilestones, legacy }
      : null;
  return { fromTurn, toTurn: latestTurn, compress, fold };
}
