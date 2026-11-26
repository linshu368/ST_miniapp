import { describe, expect, it } from 'vitest';
import { FreeZoneConfigSchema } from '@miniapp/shared';
import { chooseReplacement, resolveFreeZoneView } from './zone-view.js';
import { evaluateFreeZoneAccess } from './access.js';

describe('resolveFreeZoneView', () => {
  const pricing = { freeQuotaExhausted: 15, light: 15, standard: 33, premium: 55 };
  const candidate = {
    id: 'free-glm',
    surplus_model: 'glm-5.2',
    display_name: 'GLM 5.2',
    tagline: '中文专精',
    family: 'glm',
    benchmark_tier: 'premium' as const,
    parallel_requests: 1,
    min_discount_pct: null,
    turns_per_24h: null,
    route_objective: null,
  };
  const config = FreeZoneConfigSchema.parse({
    enabled: true,
    rules_text: '规则',
    period: { starts_at: '2026-11-12T00:00:00+08:00', ends_at: '2026-11-30T00:00:00+08:00' },
    scope: 'own_cards',
    candidates: [candidate],
  });
  const listed = [{ source: 'surplus' as const, candidate, providers: ['zai'] }];
  const at = (iso: string) => new Date(iso);
  const view = (
    overrides: {
      config?: typeof config;
      listed?: typeof listed;
      now?: Date;
      isOwnCard?: boolean;
    } = {}
  ) => {
    const cfg = overrides.config ?? config;
    return resolveFreeZoneView({
      config: cfg,
      listed: overrides.listed ?? listed,
      isOwnCard: overrides.isOwnCard ?? true,
      pricing,
      access: evaluateFreeZoneAccess({
        config: cfg,
        now: overrides.now ?? at('2026-11-20T00:00:00Z'),
        facts: null,
      }),
    });
  };

  it('is hidden when disabled or after the period', () => {
    expect(view({ config: { ...config, enabled: false } })).toBeNull();
    expect(view({ now: at('2026-12-01T00:00:00Z') })).toBeNull();
  });

  it('reports not_started, no_models, own_card_only and open in that priority', () => {
    expect(view({ now: at('2026-11-10T00:00:00Z') })?.state).toBe('not_started');
    expect(view({ listed: [] })?.state).toBe('no_models');
    expect(view({ isOwnCard: false })?.state).toBe('own_card_only');
    const open = view();
    expect(open).toMatchObject({ state: 'open', ends_at: '2026-11-29T16:00:00.000Z' });
    expect(open?.access).toMatchObject({ via: 'welfare', audience: 'everyone' });
    expect(open?.models[0]?.original_credits).toBe(55);
  });
});

describe('chooseReplacement', () => {
  const make = (id: string, family: string) => ({
    source: 'surplus' as const,
    candidate: {
      id,
      surplus_model: id,
      display_name: id,
      tagline: 't',
      family,
      benchmark_tier: 'light' as const,
      parallel_requests: 1,
      min_discount_pct: null,
      turns_per_24h: null,
      route_objective: null,
    },
    providers: ['p'],
  });

  it('prefers the same family, then any listed model, then nothing', () => {
    const usable = [make('free-gemini', 'gemini'), make('free-ds', 'deepseek')];
    const pick = (currentFamily: string, list = usable, roll = 0) =>
      chooseReplacement({ currentFamily, usable: list, random: () => roll })?.id ?? null;
    expect(pick('DeepSeek')).toBe('free-ds');
    expect(pick('glm', usable, 0.99)).toBe('free-ds');
    expect(pick('glm', [])).toBeNull();
  });
});
