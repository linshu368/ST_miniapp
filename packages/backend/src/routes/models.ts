import { FastifyInstance } from 'fastify';
import { fail, ok, resolveEnabledCatalogModel, SelectModelRequestSchema } from '@miniapp/shared';
import type {
  GetModelCatalogData,
  OpenRouterModelDirectory,
  SelectModelData,
} from '@miniapp/shared';
import { fetchModelCatalogSnapshot, getPricingConfig } from '../platform/model-tiers.js';
import { readVipStrategy } from '../platform/vip-strategy.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { openRouterModelsClient } from '../platform/openrouter-models.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { VipStatusService } from '../features/vip/vip-status.js';
import {
  coverageForTextWallet,
  presentTextModelCatalog,
  quoteAcceptedTextUsage,
  resolveTextModelSelection,
} from '../features/generation/text-billing.js';

export default async function modelsRoutes(app: FastifyInstance) {
  const settings = new MiniappUserSettingsRepository();
  const wallets = new MiniappWalletRepository();
  const vip = new VipStatusService();

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

      const log = requestLogger(request.log, 'models');
      const dbUser = await getOrCreateDbUser(request.user);
      const [snapshot, userSettings, entitlement, pricing, strategy] = await Promise.all([
        fetchModelCatalogSnapshot(),
        settings.getOrCreate(dbUser.id, request.user),
        vip.getStatus(dbUser.id, log),
        getPricingConfig(),
        readVipStrategy(),
      ]);
      const selection = resolveTextModelSelection({
        catalog: snapshot.catalog,
        persistedModelId: userSettings.selected_model_id,
        vipActive: entitlement.active,
      });
      const selectedModel = resolveEnabledCatalogModel(snapshot.catalog, selection.modelId);

      if (userSettings.selected_model_id !== selectedModel.id) {
        try {
          await settings.setSelectedModelId(dbUser.id, request.user, selectedModel.id);
          if (selection.vipFallback) {
            log.biz.info(
              {
                event: 'models.config.vip_fallback',
                userId: dbUser.id,
                fromModelId: userSettings.selected_model_id,
                toModelId: selectedModel.id,
              },
              'VIP 已失效，模型目录回落轻量'
            );
          }
        } catch (err) {
          log.sys.error(
            {
              err,
              event: 'models.config.persist_failed',
              userId: dbUser.id,
              toModelId: selectedModel.id,
            },
            '回落轻量模型后写回选择失败'
          );
        }
      }

      reply.header('Cache-Control', 'private, no-cache');
      return reply.send(
        ok<GetModelCatalogData>({
          catalog: presentTextModelCatalog({
            catalog: snapshot.catalog,
            pricing: pricing.fixedDeduction,
            vip: entitlement,
            discountRate: strategy.discountRate,
          }),
          selected_model_id: selectedModel.id,
          selected_openrouter_model_id: selectedModel.openrouter_model_id,
          catalog_version: snapshot.version,
          vip_status: {
            active: entitlement.active,
            remaining_days: entitlement.remaining_days,
            valid_until: entitlement.valid_until,
          },
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
        const [snapshot, dbUser] = await Promise.all([
          fetchModelCatalogSnapshot(),
          getOrCreateDbUser(request.user),
        ]);
        const selectedModel = resolveEnabledCatalogModel(snapshot.catalog, parsed.data.model_id);
        const selectedTier =
          snapshot.catalog.tiers.find((tier) =>
            tier.models.some((model) => model.id === selectedModel.id)
          )?.tier ?? null;
        const entitlement = await vip.getStatus(dbUser.id, log);
        const selection = resolveTextModelSelection({
          catalog: snapshot.catalog,
          persistedModelId: selectedModel.id,
          vipActive: entitlement.active,
        });
        if (selection.vipFallback || selection.modelId !== selectedModel.id) {
          log.biz.info(
            {
              event: 'models.select.vip_required',
              userId: dbUser.id,
              modelId: selectedModel.id,
              tier: selectedTier,
            },
            '标准或旗舰模型需要有效 VIP'
          );
          return reply.status(403).send(fail('VIP_REQUIRED', '标准/旗舰模型需要有效 VIP'));
        }

        const quotedTier = selectedTier ?? 'standard';
        if (!selectedModel.is_free) {
          const [wallet, pricing, strategy] = await Promise.all([
            wallets.getOrCreate(dbUser.id),
            getPricingConfig(),
            readVipStrategy(),
          ]);
          const quote = quoteAcceptedTextUsage({
            originalCredits: pricing.fixedDeduction[quotedTier],
            tier: quotedTier,
            isVip: entitlement.active,
            isFreeRound: false,
            vipValidUntil: entitlement.valid_until,
            discountRate: strategy.discountRate,
            discountConfigVersion: strategy.discountVersion,
          });
          const coverage = coverageForTextWallet({
            policy: quote.wallet_policy,
            payableCredits: quote.payable_credits,
            mainCredits: wallet.main_credits,
            bonusCredits: wallet.bonus_credits,
          });
          if (!coverage.ok) {
            log.biz.info(
              {
                event: 'models.select.wallet_blocked',
                userId: dbUser.id,
                modelId: selectedModel.id,
                tier: selectedTier,
                policy: quote.wallet_policy,
                code: coverage.code,
                available: coverage.available,
                required: quote.payable_credits,
              },
              '模型切换被可用钱包拒绝'
            );
            const message =
              coverage.code === 'MAIN_CREDITS_INSUFFICIENT'
                ? '充值星尘不足，标准/旗舰模型不能使用专项星尘'
                : '星尘余额不足，请先充值后再切换付费模型';
            return reply.status(402).send(fail(coverage.code, message));
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
