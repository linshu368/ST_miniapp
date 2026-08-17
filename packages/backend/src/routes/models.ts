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
import {
  fetchModelCatalogSnapshot,
  getAllTiers,
  getPricingConfig,
} from '../platform/model-tiers.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { openRouterModelsClient } from '../platform/openrouter-models.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { resolveFixedDeduction } from '../features/billing/usage-pricing.js';

export default async function modelsRoutes(app: FastifyInstance) {
  const settings = new MiniappUserSettingsRepository();
  const wallets = new MiniappWalletRepository();

  // @frontend-ready: true
  app.get('/api/platform/models', async (_request, reply) => {
    const tiers = await getAllTiers();
    return reply.send(ok<GetModelTiersData>({ tiers }));
  });

  // @frontend-ready: true
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

  // @frontend-ready: true
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

  // @frontend-ready: true
  app.post(
    '/api/v1/models/select',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const parsed = SelectModelRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(fail('INVALID_MODEL', '请选择有效模型'));
      }

      const log = requestLogger(request.log, 'models');
      try {
        const { catalog } = await fetchModelCatalogSnapshot();
        const selectedModel = resolveEnabledCatalogModel(catalog, parsed.data.model_id);
        const selectedTier =
          catalog.tiers.find((tier) => tier.models.some((model) => model.id === selectedModel.id))
            ?.tier ?? null;
        const dbUser = await getOrCreateDbUser(request.user);

        if (selectedModel.markup > 0) {
          const [wallet, pricing] = await Promise.all([
            wallets.getOrCreate(dbUser.id),
            getPricingConfig(),
          ]);
          const fixedDeduction = resolveFixedDeduction({
            defaultModelMarkup: selectedModel.markup,
            effectiveModelMarkup: selectedModel.markup,
            modelTier: selectedTier,
            config: pricing.fixedDeduction,
          });
          const balance = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
          if (balance < fixedDeduction.amount) {
            log.biz.info(
              {
                event: 'models.select.blocked_insufficient',
                userId: dbUser.id,
                modelId: selectedModel.id,
                model: selectedModel.openrouter_model_id,
                balance,
                required: fixedDeduction.amount,
              },
              'paid model selection blocked by insufficient balance'
            );
            return reply
              .status(402)
              .send(fail('INSUFFICIENT_CREDITS', '星尘余额不足，请先充值后再切换付费模型'));
          }
        }

        await settings.setSelectedModelId(dbUser.id, request.user, selectedModel.id);
        log.biz.info(
          {
            event: 'models.select.done',
            userId: dbUser.id,
            modelId: selectedModel.id,
            model: selectedModel.openrouter_model_id,
          },
          '用户切换模型'
        );
        return reply.send(
          ok<SelectModelData>({
            model_id: selectedModel.id,
            openrouter_model_id: selectedModel.openrouter_model_id,
          })
        );
      } catch (error) {
        log.sys.warn(
          { event: 'models.select.unavailable', err: error, modelId: parsed.data.model_id },
          'unavailable model selection'
        );
        return reply.status(400).send(fail('MODEL_UNAVAILABLE', '该模型暂不可用'));
      }
    }
  );
}
