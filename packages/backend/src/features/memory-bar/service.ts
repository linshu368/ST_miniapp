/**
 * 面板里记忆栏的对外操作：读当前路径上的记忆（随状态接口一起返回）、存玩家的记忆要求。
 * 检查本身在 update.ts；手动更新由状态面板的 refresh 并行触发。
 */
import type { ConversationMemoryData, MemoryRequestData } from '@miniapp/shared';
import type { RequestLogger } from '../../platform/observability/logger.js';
import { StatusBarError, statusRepo } from '../status-bar/template.js';
import { isMemoryChecking, memoryRepo } from './update.js';

/** 读失败不拖垮状态面板：只返回开关与进行中，记 warn。 */
export async function readConversationMemory(
  userId: string,
  session: { sessionId: string; characterId: string },
  log?: RequestLogger
): Promise<ConversationMemoryData> {
  const started = Date.now();
  const updating = isMemoryChecking(session.sessionId);
  try {
    const repo = memoryRepo();
    const [enabled, current, request] = await Promise.all([
      repo.readShowMemory(userId),
      repo.readCurrent(session.sessionId),
      repo.readRequest(userId, session.characterId),
    ]);
    return { enabled, state: enabled ? (current?.state ?? null) : null, request, updating };
  } catch (err) {
    log?.sys.warn(
      {
        event: 'memory_bar.read.failed',
        err,
        sessionId: session.sessionId,
        durationMs: Date.now() - started,
      },
      '读取记忆栏失败，面板只显示状态'
    );
    return { enabled: true, state: null, request: null, updating };
  }
}

/** 存在这张卡上（每人一段）；null 表示清空。下一次检查生效，已记下的不回头改。 */
export async function saveMemoryRequest(
  userId: string,
  sessionId: string,
  request: string | null
): Promise<MemoryRequestData> {
  const session = await statusRepo().readSession(sessionId, userId);
  if (!session) throw new StatusBarError('STATUS_NOT_FOUND', '对话不存在');
  await memoryRepo().writeRequest(userId, session.characterId, request);
  return { request };
}
