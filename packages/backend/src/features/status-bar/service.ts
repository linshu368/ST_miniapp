/**
 * 状态面板与玩家状态栏的对外操作（路由只做鉴权、参数校验和错误映射）。
 */
import {
  STATUS_AUTO_UPDATE_EVERY_TURNS,
  STATUS_REFRESH_COOLDOWN_SECONDS,
  StatusBarTemplateDraftSchema,
  checkStatusBarTemplate,
  statusInitialText,
  type CharacterStatusBarData,
  type ConversationStatusData,
  type StatusBarTemplate,
} from '@miniapp/shared';
import type { RequestLogger } from '../../platform/observability/logger.js';
import { VipStatusService } from '../vip/vip-status.js';
import { resolveEffectiveStatusBar, statusRepo, StatusBarError } from './template.js';
import { isStatusUpdating, runStatusUpdate } from './update.js';

let vipInstance: VipStatusService | null = null;
const vip = () => (vipInstance ??= new VipStatusService());

/** 手动更新限频：同一玩家同一会话 60 秒一次（单实例部署，进程内计时即可）。 */
const lastManual = new Map<string, number>();

async function requireSession(userId: string, sessionId: string) {
  const session = await statusRepo().readSession(sessionId, userId);
  if (!session) throw new StatusBarError('STATUS_NOT_FOUND', '对话不存在');
  return session;
}

export async function readConversationStatus(
  userId: string,
  sessionId: string,
  log?: RequestLogger
): Promise<ConversationStatusData> {
  const session = await requireSession(userId, sessionId);
  const [effective, snapshot, vipStatus] = await Promise.all([
    resolveEffectiveStatusBar({
      userId,
      characterId: session.characterId,
      sessionId,
    }),
    statusRepo().readCurrent(sessionId),
    vip().getStatus(userId, log),
  ]);
  const enabled = effective.source !== 'none';
  return {
    source: effective.source,
    template: effective.template,
    snapshot:
      enabled && snapshot
        ? {
            id: snapshot.id,
            text: snapshot.text,
            trigger: snapshot.trigger,
            createdAt: snapshot.createdAt,
            canUndo: snapshot.canUndo,
          }
        : null,
    initialText: effective.template ? statusInitialText(effective.template) : null,
    updating: enabled && isStatusUpdating(sessionId),
    manualUpdate: vipStatus.active ? 'allowed' : 'vip_required',
  };
}

/** 手动更新：仅限 VIP、限频；撞上进行中的自动更新就等它的结果。 */
export async function refreshConversationStatus(
  userId: string,
  sessionId: string,
  log: RequestLogger
): Promise<ConversationStatusData> {
  await requireSession(userId, sessionId);
  const vipStatus = await vip().getStatus(userId, log);
  if (!vipStatus.active)
    throw new StatusBarError(
      'STATUS_VIP_REQUIRED',
      `手动更新状态是 VIP 功能，每 ${STATUS_AUTO_UPDATE_EVERY_TURNS} 轮会自动更新`
    );
  const key = `${userId}:${sessionId}`;
  const last = lastManual.get(key) ?? 0;
  if (!isStatusUpdating(sessionId) && Date.now() - last < STATUS_REFRESH_COOLDOWN_SECONDS * 1000)
    throw new StatusBarError('STATUS_RATE_LIMITED', '刚更新过，稍等一会儿再试');
  lastManual.set(key, Date.now());
  const result = await runStatusUpdate({ userId, sessionId, trigger: 'manual', log });
  if (result.outcome === 'failed')
    throw new StatusBarError('STATUS_UPDATE_FAILED', '这次没更新成功，再试一次');
  return readConversationStatus(userId, sessionId, log);
}

export async function undoConversationStatus(
  userId: string,
  sessionId: string,
  log?: RequestLogger
): Promise<ConversationStatusData> {
  await requireSession(userId, sessionId);
  await statusRepo().undo(sessionId, userId);
  return readConversationStatus(userId, sessionId, log);
}

// ── 玩家在工具箱里改这张卡的状态栏 ───────────────────────────────────────────

export async function readCharacterStatusBar(
  userId: string,
  characterId: string
): Promise<CharacterStatusBarData> {
  const effective = await resolveEffectiveStatusBar({ userId, characterId });
  return {
    source: effective.source,
    template: effective.template,
    cardTemplate: effective.cardTemplate,
  };
}

/** 保存前走同一套语义校验；返回第一条问题给玩家看。 */
export async function saveCharacterStatusBar(
  userId: string,
  characterId: string,
  raw: StatusBarTemplate
): Promise<CharacterStatusBarData> {
  const parsed = StatusBarTemplateDraftSchema.safeParse(raw);
  if (!parsed.success) throw new StatusBarError('STATUS_INVALID_TEMPLATE', '状态栏格式不对');
  const issues = checkStatusBarTemplate(parsed.data);
  if (issues.length) throw new StatusBarError('STATUS_INVALID_TEMPLATE', issues[0]!.message);
  await statusRepo().writeOverride(userId, characterId, parsed.data);
  return readCharacterStatusBar(userId, characterId);
}

export async function resetCharacterStatusBar(
  userId: string,
  characterId: string
): Promise<CharacterStatusBarData> {
  await statusRepo().writeOverride(userId, characterId, null);
  return readCharacterStatusBar(userId, characterId);
}
