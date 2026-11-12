import type { FastifyInstance } from 'fastify';
import { AdminFreeZoneScreeningRequestSchema, fail, ok } from '@miniapp/shared';
import { authorizeAdminOperator } from '../features/admin-access/session.js';
import { previewFreeZoneScreening } from '../features/free-zone/admin-preview.js';
import { loadFreeZoneStatus } from '../features/free-zone/admin-status.js';
import { fetchFreeZoneConfig } from '../features/free-zone/config.js';

/**
 * 运营平台调试畅聊：线上状态、按页面上的门槛筛选候选池。两个接口都只读，viewer 也能用。
 */
export default async function adminFreeZoneRoutes(app: FastifyInstance) {
  app.get('/api/admin/free-zone/status', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
    return reply.send(ok(await loadFreeZoneStatus(await fetchFreeZoneConfig())));
  });

  // 不带 body 时用已发布配置的候选和门槛（CLI 直接看线上配置的筛选结果）。
  app.post('/api/admin/free-zone/screening', async (request, reply) => {
    if (!(await authorizeAdminOperator(request, reply, 'read'))) return reply;
    let input: unknown = request.body;
    if (input === undefined || input === null || input === '') {
      const config = await fetchFreeZoneConfig();
      if (config.candidates.length === 0) {
        return reply.status(400).send(fail('BAD_REQUEST', '已发布配置里还没有候选模型'));
      }
      input = { candidates: config.candidates, screening: config.screening };
    }
    const parsed = AdminFreeZoneScreeningRequestSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply
        .status(400)
        .send(
          fail(
            'BAD_REQUEST',
            `筛选参数不合法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`
          )
        );
    }
    const startedAt = Date.now();
    const result = await previewFreeZoneScreening(parsed.data);
    request.log.info(
      {
        event: 'admin.free_zone.screening_preview',
        candidates: result.models.length,
        passed: result.models.filter((model) => model.pass).length,
        durationMs: Date.now() - startedAt,
      },
      'admin free zone screening preview'
    );
    return reply.send(ok(result));
  });
}
