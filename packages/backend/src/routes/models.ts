import { FastifyInstance } from 'fastify';
import { ok } from '@miniapp/shared';
import type { GetModelTiersData, ModelCatalog, OpenRouterModelDirectory } from '@miniapp/shared';
import { fetchModelCatalog, getAllTiers } from '../platform/model-tiers.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { openRouterModelsClient } from '../platform/openrouter-models.js';

export default async function modelsRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.get('/api/platform/models', async (_request, reply) => {
    const tiers = await getAllTiers();
    return reply.send(ok<GetModelTiersData>({ tiers }));
  });

  app.get('/api/platform/openrouter/models', async (_request, reply) => {
    const directory = await openRouterModelsClient.getModels();
    reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
    return reply.send(ok<OpenRouterModelDirectory>(directory));
  });

  app.get(
    '/api/v1/models/config',
    { preHandler: [requireTelegramAuth] },
    async (_request, reply) => {
      const catalog = await fetchModelCatalog();
      return reply.send(ok<ModelCatalog>(catalog));
    }
  );
}
