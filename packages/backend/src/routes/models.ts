import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  fail,
  GetModelCatalogQuerySchema,
  isFreeZoneModelId,
  LlmModelProviderSchema,
  ok,
  resolveEnabledCatalogModel,
  SelectModelRequestSchema,
} from '@miniapp/shared';
import type {
  GetModelCatalogData,
  ModelCatalog,
  ModelCatalogTierKey,
  OpenRouterModelDirectory,
  ProviderModelDirectory,
  SelectModelData,
} from '@miniapp/shared';
import { fetchModelCatalogSnapshot, getPricingConfig } from '../platform/model-tiers.js';
import { readVipStrategy } from '../platform/vip-strategy.js';
import { requireTelegramAuth } from '../middleware/auth.js';
import { openRouterModelsClient } from '../platform/openrouter-models.js';
import { getProviderModelDirectory } from '../platform/model-provider-directory.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { VipStatusService } from '../features/vip/vip-status.js';
import { getCharacterCreatorOwner } from '../features/generation/creator-billing.js';
import { canUseCharacter } from '../features/creator/access.js';
import {
  resolveCatalogFreeZone,
  resolveFreeZoneSelection,
} from '../features/free-zone/selection.js';
import {
  coverageForTextWallet,
  presentTextModelCatalog,
  quoteAcceptedTextUsage,
  resolveTextModelSelection,
  type TextWalletDenial,
} from '../features/generation/text-billing.js';

export default async function modelsRoutes(app: FastifyInstance) {
  const settings = new MiniappUserSettingsRepository();
  const wallets = new MiniappWalletRepository();
  const vip = new VipStatusService();

  /** 切到付费模型前先看可用钱包够不够这一档的实扣；不够返回拒绝原因。 */
  async function paidSelectionWalletBlock(input: {
    userId: string;
    characterId: string | undefined;
    entitlement: Awaited<ReturnType<VipStatusService['getStatus']>>;
    modelId: string;
    tier: ModelCatalogTierKey | null;
    log: ReturnType<typeof requestLogger>;
  }): Promise<{ code: TextWalletDenial; message: string } | null> {
    const quotedTier = input.tier ?? 'standard';
    const [wallet, pricing, strategy, creatorUserId] = await Promise.all([
      wallets.getOrCreate(input.userId),
      getPricingConfig(),
      readVipStrategy(),
      getCharacterCreatorOwner(input.characterId ?? null),
    ]);
    const quote = quoteAcceptedTextUsage({
      originalCredits: pricing.fixedDeduction[quotedTier],
      tier: quotedTier,
      isVip: input.entitlement.active,
      isFreeRound: false,
      vipValidUntil: input.entitlement.valid_until,
      discountRate: strategy.discountRate,
      discountConfigVersion: strategy.discountVersion,
      creatorSelf: creatorUserId === input.userId,
    });
    const coverage = coverageForTextWallet({
      policy: quote.wallet_policy,
      payableCredits: quote.payable_credits,
      mainCredits: wallet.main_credits,
      bonusCredits: wallet.bonus_credits,
    });
    if (coverage.ok) return null;
    input.log.biz.info(
      {
        event: 'models.select.wallet_blocked',
        userId: input.userId,
        modelId: input.modelId,
        tier: input.tier,
        policy: quote.wallet_policy,
        code: coverage.code,
        available: coverage.available,
        required: quote.payable_credits,
      },
      '模型切换被可用钱包拒绝'
    );
    return {
      code: coverage.code,
      message:
        coverage.code === 'MAIN_CREDITS_INSUFFICIENT'
          ? '充值星尘不足，标准/旗舰模型不能使用专项星尘'
          : '星尘余额不足，请先充值后再切换付费模型',
    };
  }

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
  app.get('/api/platform/model-providers/:provider/models', async (request, reply) => {
    const params = request.params as { provider?: string };
    const parsedProvider = LlmModelProviderSchema.safeParse(params.provider);
    if (!parsedProvider.success) {
      return reply.status(400).send(fail('INVALID_PROVIDER', 'Unsupported model provider'));
    }

    const query = request.query as { refresh?: string };
    const forceRefresh = query.refresh === '1';
    const directory = await getProviderModelDirectory(parsedProvider.data, { forceRefresh });
    reply.header(
      'Cache-Control',
      forceRefresh ? 'no-store' : 'public, max-age=300, stale-while-revalidate=900'
    );
    return reply.send(ok<ProviderModelDirectory>(directory));
  });

  // @frontend-ready: true
  app.get(
    '/api/v1/models/config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const query = GetModelCatalogQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply.status(400).send(fail('INVALID_CHARACTER', '请选择有效角色'));
      const log = requestLogger(request.log, 'models');
      const dbUser = await getOrCreateDbUser(request.user);
      const characterId = query.data.character_id;
      if (characterId && !(await canUseCharacter(dbUser.id, characterId))) {
        return reply.status(404).send(fail('CHARACTER_NOT_FOUND', '角色不可用'));
      }
      const [snapshot, userSettings, entitlement, pricing, strategy, creatorUserId] =
        await Promise.all([
          fetchModelCatalogSnapshot(),
          settings.getOrCreate(dbUser.id, request.user),
          vip.getStatus(dbUser.id, log),
          getPricingConfig(),
          readVipStrategy(),
          getCharacterCreatorOwner(characterId ?? null),
        ]);
      const isOwnCard = creatorUserId === dbUser.id;
      const freeZone = await resolveCatalogFreeZone({
        userId: dbUser.id,
        characterId: characterId ?? null,
        settingsModelId: userSettings.selected_model_id,
        catalog: snapshot.catalog,
        isOwnCard,
        pricing: pricing.fixedDeduction,
      });
      const selection = resolveTextModelSelection({
        catalog: snapshot.catalog,
        persistedModelId: freeZone.usable ? null : freeZone.modelId,
        vipActive: entitlement.active,
      });
      const catalogModel = resolveEnabledCatalogModel(snapshot.catalog, selection.modelId);
      // 畅聊免费模型不在付费目录里，选中时按它自己的 Surplus 上游返回。
      const selectedModel = freeZone.usable
        ? {
            id: freeZone.usable.candidate.id,
            openrouter_model_id: freeZone.usable.candidate.surplus_model,
            provider: 'surplus' as const,
            provider_model_id: freeZone.usable.candidate.surplus_model,
          }
        : catalogModel;
      if (freeZone.replacement) {
        log.biz.info(
          {
            event: 'models.config.free_zone_replaced',
            userId: dbUser.id,
            fromModelId: userSettings.selected_model_id,
            toModelId: selectedModel.id,
            reason: freeZone.replacement.reason,
          },
          '畅聊模型不可用，已自动替换'
        );
      }

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
            creatorSelf: isOwnCard,
          }),
          selected_model_id: selectedModel.id,
          selected_openrouter_model_id: selectedModel.openrouter_model_id,
          selected_provider: selectedModel.provider,
          selected_provider_model_id: selectedModel.provider_model_id,
          catalog_version: snapshot.version,
          vip_status: {
            active: entitlement.active,
            remaining_days: entitlement.remaining_days,
            valid_until: entitlement.valid_until,
          },
          free_zone: freeZone.view,
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
        const characterId = parsed.data.character_id;
        if (characterId && !(await canUseCharacter(dbUser.id, characterId))) {
          return reply.status(404).send(fail('CHARACTER_NOT_FOUND', '角色不可用'));
        }
        if (isFreeZoneModelId(parsed.data.model_id)) {
          const freeZone = {
            modelId: parsed.data.model_id,
            catalog: snapshot.catalog,
            characterId,
          };
          return selectFreeZoneModel({
            ...freeZone,
            reply,
            request,
            userId: dbUser.id,
            log,
            settings,
          });
        }
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

        if (!selectedModel.is_free) {
          const blocked = await paidSelectionWalletBlock({
            userId: dbUser.id,
            characterId,
            entitlement,
            modelId: selectedModel.id,
            tier: selectedTier,
            log,
          });
          if (blocked) return reply.status(402).send(fail(blocked.code, blocked.message));
        }

        await settings.setSelectedModelId(dbUser.id, request.user, selectedModel.id);
        log.biz.info(
          {
            event: 'models.select.done',
            userId: dbUser.id,
            modelId: selectedModel.id,
            provider: selectedModel.provider,
            model: selectedModel.provider_model_id,
          },
          '用户切换模型'
        );
        return reply.send(
          ok<SelectModelData>({
            model_id: selectedModel.id,
            openrouter_model_id: selectedModel.openrouter_model_id,
            provider: selectedModel.provider,
            provider_model_id: selectedModel.provider_model_id,
          })
        );
      } catch (error) {
        log.sys.warn(
          { event: 'models.select.unavailable', err: error, modelId: parsed.data.model_id },
          'unavailable model selection'
        );
        return reply.status(400).send(fail('MODEL_UNAVAILABLE', '这个模型暂时用不了'));
      }
    }
  );
}

/**
 * 选畅聊免费模型：只看此刻对这张卡开不开放，不查钱包也不查 VIP（应扣 0）。
 */
async function selectFreeZoneModel(input: {
  modelId: string;
  catalog: ModelCatalog;
  characterId: string | undefined;
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  log: ReturnType<typeof requestLogger>;
  settings: MiniappUserSettingsRepository;
}) {
  const { reply, log, userId, settings } = input;
  const decision = await resolveFreeZoneSelection({
    persistedModelId: input.modelId,
    userId,
    characterId: input.characterId ?? null,
    catalog: input.catalog,
  });
  if (decision?.kind !== 'usable' || !input.request.user) {
    log.biz.info(
      { event: 'models.select.free_zone_unavailable', userId, modelId: input.modelId },
      '畅聊模型此刻不可用'
    );
    return reply.status(409).send(fail('FREE_ZONE_UNAVAILABLE', '畅聊模型暂未开放'));
  }
  const { candidate } = decision.listed;
  await settings.setSelectedModelId(userId, input.request.user, candidate.id);
  log.biz.info(
    {
      event: 'models.select.done',
      userId,
      modelId: candidate.id,
      provider: 'surplus',
      model: candidate.surplus_model,
      freeZone: true,
    },
    '用户切换模型'
  );
  return reply.send(
    ok<SelectModelData>({
      model_id: candidate.id,
      openrouter_model_id: candidate.surplus_model,
      provider: 'surplus',
      provider_model_id: candidate.surplus_model,
    })
  );
}
