import { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  SelectModelRequestSchema,
  toPublicModelCatalog,
} from '@miniapp/shared';
import type {
  GetModelCatalogData,
  GetModelTiersData,
  OpenRouterModelDirectory,
  SelectModelData,
} from '@miniapp/shared';
import { fetchModelCatalogSnapshot, getAllTiers } from '../platform/model-tiers.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { openRouterModelsClient } from '../platform/openrouter-models.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';

export default async function modelsRoutes(app: FastifyInstance) {
  const settings = new MiniappUserSettingsRepository();

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
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const dbUser = await getOrCreateDbUser(request.user);
      const [snapshot, userSettings] = await Promise.all([
        fetchModelCatalogSnapshot(),
        settings.getOrCreate(dbUser.id, request.user),
      ]);
      const selectedModelId = resolveEffectiveSelectedModelId(
        snapshot.catalog,
        userSettings.selected_model_id
      );
      const selectedModel = resolveEnabledCatalogModel(snapshot.catalog, selectedModelId);

      if (userSettings.selected_model_id !== selectedModelId) {
        await settings.setSelectedModelId(dbUser.id, request.user, selectedModelId);
      }

      reply.header('Cache-Control', 'private, no-cache');
      return reply.send(
        ok<GetModelCatalogData>({
          catalog: toPublicModelCatalog(snapshot.catalog),
          selected_model_id: selectedModel.id,
          selected_openrouter_model_id: selectedModel.openrouter_model_id,
          catalog_version: snapshot.version,
        })
      );
    }
  );

  app.post(
    '/api/v1/models/select',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const parsed = SelectModelRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(fail('INVALID_MODEL', '请选择有效模型'));
      }

      try {
        const { catalog } = await fetchModelCatalogSnapshot();
        const selectedModel = resolveEnabledCatalogModel(catalog, parsed.data.model_id);
        const dbUser = await getOrCreateDbUser(request.user);
        await settings.setSelectedModelId(dbUser.id, request.user, selectedModel.id);
        return reply.send(
          ok<SelectModelData>({
            model_id: selectedModel.id,
            openrouter_model_id: selectedModel.openrouter_model_id,
          })
        );
      } catch (error) {
        request.log.warn(
          { err: String(error), modelId: parsed.data.model_id },
          '[models] unavailable model selection'
        );
        return reply.status(400).send(fail('MODEL_UNAVAILABLE', '该模型暂不可用'));
      }
    }
  );
}
