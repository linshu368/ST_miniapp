import { describe, expect, it } from 'vitest';
import { ImagePlazaModelCatalogSchema } from '@miniapp/shared';
import { configMetadata, parseManagedConfig } from '../configSchemas';
import {
  calculateImagePlazaPrice,
  imagePlazaPriceKey,
  recalculateImagePlazaCatalog,
} from './imagePlazaPricing';

const factors = { exchange: 7.3, markup: 2, ratio: 100 };

describe('image plaza pricing calculator', () => {
  it('keeps saved standard prices through managed config parsing and recalculation', () => {
    const catalog = ImagePlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_model_catalog.defaultValue
    );
    const modelsBefore = structuredClone(catalog.models);
    catalog.standard_prices = Object.fromEntries(
      catalog.models.flatMap((model) =>
        model.resolutions.map((tier) => [imagePlazaPriceKey(model.id, tier.id), 0.11])
      )
    );
    const loaded = ImagePlazaModelCatalogSchema.parse(
      parseManagedConfig('image_plaza_model_catalog', JSON.parse(JSON.stringify(catalog)))
    );
    expect(loaded.standard_prices).toEqual(catalog.standard_prices);
    expect(loaded.models).toEqual(modelsBefore);
    const recalculated = recalculateImagePlazaCatalog(loaded, loaded.standard_prices!, factors);
    expect(recalculated.catalog?.standard_prices).toEqual(catalog.standard_prices);
    expect(recalculated.issues).toEqual([]);

    const key = imagePlazaPriceKey(loaded.models[0].id, loaded.models[0].resolutions[0].id);
    loaded.standard_prices![key] = null;
    const cleared = ImagePlazaModelCatalogSchema.parse(JSON.parse(JSON.stringify(loaded)));
    expect(cleared.standard_prices?.[key]).toBeNull();
    expect(
      recalculateImagePlazaCatalog(cleared, cleared.standard_prices!, factors).catalog
    ).toBeNull();
  });

  it('matches the reference formula and rounds up to tens', () => {
    expect(calculateImagePlazaPrice(0.11, factors)).toEqual({ raw: 160.6, credits: 170 });
    expect(calculateImagePlazaPrice(0.11, { ...factors, markup: 3 })?.credits).toBe(250);
    expect(calculateImagePlazaPrice(0.0001, factors)?.credits).toBe(10);
  });

  it('does not add ten credits at an exact decimal boundary', () => {
    expect(calculateImagePlazaPrice(0.07, { exchange: 1, markup: 1, ratio: 1000 })).toEqual({
      raw: 70,
      credits: 70,
    });
    expect(calculateImagePlazaPrice(0.0701, { exchange: 1, markup: 1, ratio: 1000 })?.credits).toBe(
      80
    );
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, 1_000_001, 0.00001])(
    'rejects missing or invalid standard price %s',
    (usd) => expect(calculateImagePlazaPrice(usd, factors)).toBeNull()
  );

  it('rejects invalid factors and unsafe results', () => {
    for (const key of ['exchange', 'markup', 'ratio'] as const) {
      for (const value of [null, 0, -1, NaN, Infinity, 0.00001]) {
        expect(calculateImagePlazaPrice(0.11, { ...factors, [key]: value })).toBeNull();
      }
    }
    expect(
      calculateImagePlazaPrice(1_000_000, {
        exchange: 1_000_000,
        markup: 1_000_000,
        ratio: 1_000_000,
      })
    ).toBeNull();
  });

  it('recalculates all tiers including disabled models without mutating the source', () => {
    const catalog = ImagePlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_model_catalog.defaultValue
    );
    catalog.models[0].enabled = false;
    catalog.models[0].resolutions.push({ id: '2K', label: '高清', credits: 999 });
    const original = structuredClone(catalog);
    const prices = Object.fromEntries(
      catalog.models.flatMap((model) =>
        model.resolutions.map((tier) => [
          imagePlazaPriceKey(model.id, tier.id),
          tier.id === '2K' ? 0.22 : 0.11,
        ])
      )
    );
    const result = recalculateImagePlazaCatalog(catalog, prices, factors);
    expect(result.issues).toEqual([]);
    expect(result.catalog?.models[0].resolutions.map((tier) => tier.credits)).toEqual([170, 330]);
    expect(result.catalog?.models.every((model) => model.resolutions[0].credits === 170)).toBe(
      true
    );
    expect(catalog).toEqual(original);
    expect(ImagePlazaModelCatalogSchema.safeParse(result.catalog).success).toBe(true);
    expect(recalculateImagePlazaCatalog(result.catalog!, prices, factors)).toEqual(result);

    delete prices[imagePlazaPriceKey(catalog.models[0].id, '2K')];
    const incomplete = recalculateImagePlazaCatalog(catalog, prices, factors);
    expect(incomplete.catalog).toBeNull();
    expect(incomplete.issues).toEqual([`${catalog.models[0].name} / 高清 (2K)`]);
    expect(catalog).toEqual(original);
  });
});
