import { FastifyInstance } from 'fastify';
import { ok, fail } from '@miniapp/shared';
import type {
  CompleteWishRoleData,
  CompleteWishRoleRequest,
  CreateWishRoleData,
  CreateWishRoleRequest,
  GetWishRoleStatusData,
  WishRoleData,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import {
  MiniappWishRoleRepository,
  type WishRole,
} from '../infrastructure/repositories/MiniappWishRoleRepository.js';

const MIN_WISH_LENGTH = 8;
const WISH_REWARD_CREDITS = 1;
const WISH_LIMIT_HOURS = 24;

export default async function wishRoutes(app: FastifyInstance) {
  const wishes = new MiniappWishRoleRepository();

  app.get('/api/wishes/status', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const latestWish = await wishes.findLatestWithinWindow(request.user.id, WISH_LIMIT_HOURS);
    const nextAvailableAt = latestWish
      ? new Date(
          new Date(latestWish.created_at).getTime() + WISH_LIMIT_HOURS * 60 * 60 * 1000
        ).toISOString()
      : null;

    return reply.send(
      ok<GetWishRoleStatusData>({
        can_submit: !latestWish,
        latest_wish: latestWish ? toWishRoleData(latestWish) : null,
        next_available_at: nextAvailableAt,
      })
    );
  });

  app.post('/api/wishes', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const body = request.body as Partial<CreateWishRoleRequest>;
    const wishText = body.wish_text?.trim() ?? '';
    if (countChars(wishText) <= MIN_WISH_LENGTH) {
      return reply
        .status(400)
        .send(fail('WISH_TOO_SHORT', '再多说几个字呀，不然我猜不到你想要什么样的～'));
    }

    const dbUser = await getOrCreateDbUser(request.user);

    try {
      const wish = await wishes.createWish({
        dbUserId: dbUser.id,
        telegramUserId: request.user.id,
        wishText,
        rewardCredits: WISH_REWARD_CREDITS,
      });
      return reply.send(ok<CreateWishRoleData>({ wish: toWishRoleData(wish) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Create wish failed';
      request.log.warn({ err: error, userId: dbUser.id }, 'Create wish failed');
      if (message.includes('wish limit reached')) {
        return reply
          .status(409)
          .send(fail('WISH_LIMIT_REACHED', '你今天的许愿次数已经用完啦，明天再来～'));
      }
      return reply.status(400).send(fail('WISH_CREATE_FAILED', '许愿暂时保存失败'));
    }
  });

  app.post(
    '/api/wishes/:id/complete',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const { id } = request.params as { id: string };
      const body = request.body as Partial<CompleteWishRoleRequest>;
      const dbUser = await getOrCreateDbUser(request.user);

      const wish = await wishes.completeWish({
        dbUserId: dbUser.id,
        telegramUserId: request.user.id,
        wishId: id,
        extraText: body.extra_text,
      });

      if (!wish) {
        return reply.status(404).send(fail('WISH_NOT_FOUND', '没有找到待补充的许愿'));
      }

      return reply.send(ok<CompleteWishRoleData>({ wish: toWishRoleData(wish) }));
    }
  );
}

function toWishRoleData(wish: WishRole): WishRoleData {
  return {
    id: wish.id,
    wish_text: wish.wish_text,
    extra_text: wish.extra_text,
    reward_credits: wish.reward_credits,
    status: wish.status,
    created_at: wish.created_at,
    closed_at: wish.closed_at,
  };
}

function countChars(value: string): number {
  return Array.from(value.trim()).length;
}
