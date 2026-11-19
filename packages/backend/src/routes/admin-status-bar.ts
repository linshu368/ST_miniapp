import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ADMIN_STATUS_BAR_TOP_MAX,
  AdminSetStatusBarRequestSchema,
  AdminStatusBarGenerateRequestSchema,
  fail,
  ok,
} from '@miniapp/shared';
import { authorizeAdminOperator } from '../features/admin-access/session.js';
import { CreatorStatusBarError } from '../features/generation/creator-status-bar.js';
import {
  AdminStatusBarError,
  generateAdminCharacterStatusBar,
  listTopFavoritedCards,
  readAdminCharacterStatusBar,
  setAdminCharacterStatusBar,
} from '../features/status-bar/admin.js';

/** 后端同时只跑这么多张卡的生成；CLI 自己也限并发，这里兜底防止误开多个批次。 */
const MAX_ACTIVE_GENERATIONS = 24;
let activeGenerations = 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(issue: { path: PropertyKey[]; message: string } | undefined) {
  return fail('BAD_REQUEST', `参数不合法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`);
}

/** 一张卡的生成：占一个并发名额，记成功/失败日志，模型错误映射成 422/503。 */
async function runGenerate(
  request: FastifyRequest,
  reply: FastifyReply,
  characterId: string,
  model: string | undefined
) {
  activeGenerations += 1;
  const startedAt = Date.now();
  try {
    const result = await generateAdminCharacterStatusBar(characterId, model);
    request.log.info(
      {
        event: 'admin.status_bar.generated',
        outcome: 'succeeded',
        characterId,
        model: result.model,
        itemCount: result.template.sections.reduce((n, s) => n + s.items.length, 0),
        durationMs: result.durationMs,
      },
      '运营生成卡的状态栏'
    );
    return reply.send(ok(result));
  } catch (err) {
    const known = err instanceof AdminStatusBarError || err instanceof CreatorStatusBarError;
    request.log.warn(
      {
        event: 'admin.status_bar.generated',
        outcome: 'failed',
        characterId,
        code: known ? err.code : 'unexpected',
        durationMs: Date.now() - startedAt,
        ...(known ? {} : { err }),
      },
      '运营生成卡的状态栏失败'
    );
    if (err instanceof AdminStatusBarError)
      return reply.status(404).send(fail(err.code, err.message));
    if (err instanceof CreatorStatusBarError)
      return err.code === 'invalid_output'
        ? reply.status(422).send(fail('STATUS_AI_INVALID', err.message))
        : reply.status(503).send(fail('STATUS_AI_UNAVAILABLE', '模型暂时不可用'));
    throw err;
  } finally {
    activeGenerations -= 1;
  }
}

/**
 * 运营给存量卡设定状态栏（运营 CLI `status-bar top / generate / apply`）。
 * 生成只返回结果不落库；写入单独走 PUT，CLI 先把差异给人看再 --yes。
 */
export default async function adminStatusBarRoutes(app: FastifyInstance) {
  // @frontend-ready: false — 运营 CLI 专用
  app.get('/api/admin/status-bar/top-favorited', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
    const raw = Number((request.query as { limit?: string }).limit ?? 300);
    const limit = Number.isInteger(raw)
      ? Math.min(Math.max(raw, 1), ADMIN_STATUS_BAR_TOP_MAX)
      : 300;
    const cards = await listTopFavoritedCards(limit);
    request.log.info(
      { event: 'admin.status_bar.top_listed', limitCount: limit, cardCount: cards.length },
      '运营查看收藏量头部卡'
    );
    return reply.send(ok({ cards }));
  });

  // @frontend-ready: false — 运营 CLI 专用
  app.get<{ Params: { characterId: string } }>(
    '/api/admin/characters/:characterId/status-bar',
    async (request, reply) => {
      if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
      const { characterId } = request.params;
      if (!UUID.test(characterId))
        return reply.status(400).send(fail('BAD_REQUEST', '角色 id 不对'));
      try {
        return reply.send(ok(await readAdminCharacterStatusBar(characterId)));
      } catch (err) {
        if (err instanceof AdminStatusBarError)
          return reply.status(404).send(fail(err.code, err.message));
        throw err;
      }
    }
  );

  // @frontend-ready: false — 运营 CLI 专用；要调模型、花钱，按写权限算
  app.post<{ Params: { characterId: string } }>(
    '/api/admin/characters/:characterId/status-bar/generate',
    async (request, reply) => {
      if (!(await authorizeAdminOperator(request, reply, 'write'))) return reply;
      const { characterId } = request.params;
      if (!UUID.test(characterId))
        return reply.status(400).send(fail('BAD_REQUEST', '角色 id 不对'));
      const parsed = AdminStatusBarGenerateRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.issues[0]));
      if (activeGenerations >= MAX_ACTIVE_GENERATIONS)
        return reply.status(429).send(fail('RATE_LIMITED', '同时生成的卡太多，稍后再试'));
      return runGenerate(request, reply, characterId, parsed.data.model);
    }
  );

  // @frontend-ready: false — 运营 CLI 专用
  app.put<{ Params: { characterId: string } }>(
    '/api/admin/characters/:characterId/status-bar',
    async (request, reply) => {
      if (!(await authorizeAdminOperator(request, reply, 'write'))) return reply;
      const { characterId } = request.params;
      if (!UUID.test(characterId))
        return reply.status(400).send(fail('BAD_REQUEST', '角色 id 不对'));
      const parsed = AdminSetStatusBarRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(badRequest(parsed.error.issues[0]));
      try {
        const result = await setAdminCharacterStatusBar(characterId, parsed.data.template);
        request.log.info(
          {
            kind: 'biz',
            event: 'admin.status_bar.saved',
            characterId,
            mode: parsed.data.template ? 'set' : 'clear',
            outcome: 'succeeded',
            code: result.draftPatched ? 'draft_patched' : 'card_only',
          },
          '运营写入卡的状态栏'
        );
        return reply.send(ok(result));
      } catch (err) {
        if (err instanceof AdminStatusBarError)
          return reply
            .status(err.code === 'CHARACTER_NOT_FOUND' ? 404 : 400)
            .send(fail(err.code, err.message));
        throw err;
      }
    }
  );
}
