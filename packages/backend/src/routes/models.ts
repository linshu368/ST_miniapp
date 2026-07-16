import { FastifyInstance } from 'fastify';
import { ok } from '@miniapp/shared';
import type { GetModelTiersData, ModelCatalog } from '@miniapp/shared';
import { fetchModelCatalog, getAllTiers } from '../platform/model-tiers.js';

export default async function modelsRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/platform/models', async (_request, reply) => {
    const tiers = await getAllTiers();
    return reply.send(ok<GetModelTiersData>({ tiers }));
  });

  app.get('/api/v1/models/config', async (_request, reply) => {
    const catalog = await fetchModelCatalog();
    return reply.send(ok<ModelCatalog>(catalog));
  });
}
