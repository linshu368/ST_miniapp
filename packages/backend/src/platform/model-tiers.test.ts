import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, shouldReuseCatalogCache } from './model-tiers.js';
import { ModelCatalogSchema } from '@miniapp/shared';

describe('model catalog runtime helpers', () => {
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
