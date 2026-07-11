import { FastifyInstance } from 'fastify';
import { ok } from '@miniapp/shared';
import type { GetModelTiersData } from '@miniapp/shared';
import { getAllTiers } from '../platform/model-tiers.js';

export default async function modelsRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/platform/models', async (_request, reply) => {
    const tiers = await getAllTiers();
    return reply.send(ok<GetModelTiersData>({ tiers }));
  });
}
