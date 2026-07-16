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

  app.get('/api/platform/openrouter/models', async (request, reply) => {
    const query = request.query as { refresh?: string };
    const forceRefresh = query.refresh === '1';
    const directory = await openRouterModelsClient.getModels({ forceRefresh });
    reply.header(
      'Cache-Control',
      forceRefresh ? 'no-store' : 'public, max-age=300, stale-while-revalidate=900'
    );
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
