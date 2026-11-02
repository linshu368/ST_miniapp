import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, getModelBillingContext, shouldReuseCatalogCache } from './model-tiers.js';
import { ModelCatalogSchema } from '@miniapp/shared';

describe('model catalog runtime helpers', () => {
  it('prices an accepted model from its supplied catalog without a runtime_config roundtrip', async () => {
    const snapshot = { catalog: DEFAULT_CATALOG, version: 123 };
    const model = snapshot.catalog.tiers[0]!.models[0]!;
    const billing = await getModelBillingContext(
      { provider: model.provider, providerModelId: model.provider_model_id },
      snapshot
    );
    expect(billing).toMatchObject({
      catalogVersion: 123,
      modelId: model.id,
      modelDisplayName: model.display_name,
      providerModelId: model.provider_model_id,
      isFree: model.is_free,
    });
  });

  it('invalidates the cache whenever runtime_config.version changes', () => {
    expect(shouldReuseCatalogCache(4, 4)).toBe(true);
    expect(shouldReuseCatalogCache(4, 5)).toBe(false);
  });

  it('ships a built-in fallback catalog that satisfies the formal schema', () => {
    // 模块加载时已 parse 过一次；这里锁死形状，防止有人改成非法值后启动即炸。
    expect(ModelCatalogSchema.safeParse(DEFAULT_CATALOG).success).toBe(true);
    expect(DEFAULT_CATALOG.default_model_id).toBe('google-gemini-3.1-flash-lite');
    expect(DEFAULT_CATALOG.tiers.flatMap((tier) => tier.models.map((m) => m.id))).toEqual([
      'google-gemini-3.1-flash-lite',
      'anthropic-claude-sonnet-4.5',
    ]);
  });
});
