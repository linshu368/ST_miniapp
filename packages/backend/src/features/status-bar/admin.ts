/**
 * 运营给存量卡生成/写入状态栏（状态栏 v2 不再有"模型自己挑"的通用模板，没有状态栏的卡不显示状态）。
 * 生成只返回结果不落库：运营 CLI 汇总给人看过，再逐张 PUT 写入。
 */
import {
  ADMIN_STATUS_BAR_DEFAULT_MODEL,
  StatusBarTemplateDraftSchema,
  checkStatusBarTemplate,
  emptyCharacterDraft,
  type AdminCharacterStatusBarData,
  type AdminSetStatusBarData,
  type AdminStatusBarGenerateData,
  type AdminStatusBarTopCard,
  type CharacterDraft,
  type StatusBarTemplate,
} from '@miniapp/shared';
import {
  CharacterCardRepository,
  type CharacterStatusBarSourceRow,
} from '../../infrastructure/repositories/CharacterCardRepository.js';
import { prisma } from '../../lib/db.js';
import { generateCreatorStatusBar } from '../generation/creator-status-bar.js';

/** 每次调模型的时限（最多 3 次）：长卡资料，比建卡页放宽。 */
const ADMIN_GENERATE_TIMEOUT_MS = 120_000;

export class AdminStatusBarError extends Error {
  constructor(
    readonly code: 'CHARACTER_NOT_FOUND' | 'INVALID_TEMPLATE',
    message: string
  ) {
    super(message);
  }
}

let repoInstance: CharacterCardRepository | null = null;
const cards = () => (repoInstance ??= new CharacterCardRepository());

function storedTemplate(raw: unknown): StatusBarTemplate | null {
  const parsed = StatusBarTemplateDraftSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * 存量卡没有建卡草稿：把卡的内容列拼成生成用的资料。
 * 官方卡（酒馆格式）的人设主要写在 description，创作卡的设定在 system_prompt，两类都整段放进背景；
 * 公开简介用 creator_notes。
 */
export function draftFromCard(row: CharacterStatusBarSourceRow): CharacterDraft {
  const draft = emptyCharacterDraft();
  draft.name = row.name;
  draft.description = row.creator_notes ?? '';
  draft.opening = row.first_mes ?? '';
  draft.background = (
    [
      ['角色设定', row.description],
      ['性格', row.personality],
      ['场景', row.scenario],
      ['人设与文风', row.character_persona_and_style],
      ['设定与规则', row.system_prompt],
      ['对话示例', row.mes_example],
    ] as const
  )
    .filter(([, text]) => text?.trim())
    .map(([title, text]) => `【${title}】\n${text!.trim()}`)
    .join('\n\n');
  draft.tags = Array.isArray(row.tags)
    ? row.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return draft;
}

async function requireCard(characterId: string): Promise<CharacterStatusBarSourceRow> {
  const row = await cards().readStatusBarSource(characterId);
  if (!row) throw new AdminStatusBarError('CHARACTER_NOT_FOUND', '角色不存在');
  return row;
}

export async function readAdminCharacterStatusBar(
  characterId: string
): Promise<AdminCharacterStatusBarData> {
  const row = await requireCard(characterId);
  return { characterId, name: row.name, template: storedTemplate(row.status_bar_detail) };
}

export async function generateAdminCharacterStatusBar(
  characterId: string,
  model: string = ADMIN_STATUS_BAR_DEFAULT_MODEL,
  signal?: AbortSignal
): Promise<AdminStatusBarGenerateData> {
  const row = await requireCard(characterId);
  const startedAt = Date.now();
  const { template } = await generateCreatorStatusBar(draftFromCard(row), signal, {
    model,
    timeoutMs: ADMIN_GENERATE_TIMEOUT_MS,
  });
  return { characterId, name: row.name, model, template, durationMs: Date.now() - startedAt };
}

/** 写入前再走一遍与建卡、玩家保存相同的语义校验。 */
export async function setAdminCharacterStatusBar(
  characterId: string,
  template: StatusBarTemplate | null
): Promise<AdminSetStatusBarData> {
  if (template) {
    const issue = checkStatusBarTemplate(template)[0];
    if (issue) throw new AdminStatusBarError('INVALID_TEMPLATE', issue.message);
  }
  const result = await cards().setStatusBar(characterId, template);
  if (!result) throw new AdminStatusBarError('CHARACTER_NOT_FOUND', '角色不存在');
  return {
    characterId,
    previous: storedTemplate(result.previous),
    template,
    draftPatched: result.draftPatched,
  };
}

/** 收藏量从高到低的卡（不含已删除、测试卡）；同收藏量按新卡在前。只读事务 + 语句超时。 */
export async function listTopFavoritedCards(limit: number): Promise<AdminStatusBarTopCard[]> {
  const rows = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
      return tx.$queryRaw<
        Array<{ id: string; name: string; favorite_count: bigint; has_status_bar: boolean }>
      >`
        SELECT c.id::text AS id, c.name,
          (SELECT count(*) FROM features.character_favorites f WHERE f.character_id = c.id) AS favorite_count,
          c.status_bar_detail IS NOT NULL AND jsonb_typeof(c.status_bar_detail) = 'object' AS has_status_bar
        FROM app_core.characters c
        JOIN app_core.character_listings l ON l.character_id = c.id
        WHERE NOT c.is_test AND l.archived_at IS NULL
        ORDER BY favorite_count DESC, c.created_at DESC, c.id
        LIMIT ${limit}
      `;
    },
    { maxWait: 2_000, timeout: 10_000 }
  );
  return rows.map((row) => ({
    characterId: row.id,
    name: row.name,
    favoriteCount: Number(row.favorite_count),
    hasStatusBar: row.has_status_bar,
  }));
}
