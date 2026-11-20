import { describe, expect, it } from 'vitest';
import { ImagePlazaModelCatalogSchema, VideoPlazaModelCatalogSchema } from '@miniapp/shared';
import { configMetadata, parseManagedConfig } from '@miniapp/admin-client';
import {
  calculateImagePlazaPrice,
  getImagePlazaPricingFactors,
  imagePlazaPriceKey,
  recalculateImagePlazaCatalog,
  updateImagePlazaPricingFactor,
} from './imagePlazaPricing';
import {
  calculateVideoPlazaPrice,
  getVideoPlazaPricingFactors,
  recalculateVideoPlazaCatalog,
  updateVideoPlazaPricingFactor,
  videoPlazaPriceKey,
} from './videoPlazaPricing';

const factors = { exchange: 7.3, markup: 2, ratio: 100 };

describe('video plaza pricing calculator', () => {
  const createCatalog = () =>
    VideoPlazaModelCatalogSchema.parse(configMetadata.image_plaza_video_model_catalog.defaultValue);

  it('matches the reference formula, exact boundaries and video price ceiling', () => {
    expect(calculateVideoPlazaPrice(0.04, { ...factors, markup: 2.5 })).toEqual({
      raw: 73,
      credits: 80,
    });
    const exact = { exchange: 1, markup: 1, ratio: 1000 };
    expect(calculateVideoPlazaPrice(0.07, exact)).toEqual({ raw: 70, credits: 70 });
    expect(calculateVideoPlazaPrice(1000, exact)?.credits).toBe(1_000_000);
    expect(calculateVideoPlazaPrice(1000.0001, exact)).toBeNull();
    expect(calculateVideoPlazaPrice(0.0001, factors)?.credits).toBe(10);
    for (const invalid of [null, undefined, 0, -1, NaN, Infinity, 1_000_001, 0.00001]) {
      expect(calculateVideoPlazaPrice(invalid, factors)).toBeNull();
    }
  });

  it('preserves manual prices and standards when factors change or are invalid', () => {
    const catalog = createCatalog();
    const key = Object.keys(catalog.models[0].price_matrix)[0];
    catalog.standard_prices = { [videoPlazaPriceKey(catalog.models[0].id, key)]: 0.04 };
    const before = structuredClone(catalog);
    expect(getVideoPlazaPricingFactors(catalog)).toEqual(factors);
    expect(catalog.pricing_factors).toBeUndefined();
    for (const field of ['exchange', 'markup', 'ratio'] as const) {
      for (const invalid of [null, 0, -1, NaN, Infinity, 1_000_001, 0.00001]) {
        expect(updateVideoPlazaPricingFactor(catalog, field, invalid)).toBeNull();
        expect(catalog).toEqual(before);
      }
    }
    const updated = updateVideoPlazaPricingFactor(catalog, 'markup', 2.5)!;
    expect(updated.pricing_factors).toEqual({ ...factors, markup: 2.5 });
    expect(updated.models).toEqual(before.models);
    expect(updated.standard_prices).toEqual(before.standard_prices);
  });

  it('recalculates distinct model, duration, resolution and audio tiers atomically including disabled models', () => {
    const catalog = createCatalog();
    catalog.models[1].enabled = false;
    catalog.pricing_factors = { ...factors, markup: 2.5 };
    const tiers = catalog.models.flatMap((model) =>
      Object.keys(model.price_matrix).map((key) => ({ model, key }))
    );
    const keys = tiers.map(({ model, key }) => videoPlazaPriceKey(model.id, key));
    expect(new Set(keys).size).toBe(tiers.length);
    catalog.standard_prices = Object.fromEntries(
      keys.map((key, index) => [key, (index + 1) / 100])
    );
    const before = structuredClone(catalog);
    const result = recalculateVideoPlazaCatalog(catalog);
    expect(result.issues).toEqual([]);
    const loaded = VideoPlazaModelCatalogSchema.parse(
      parseManagedConfig(
        'image_plaza_video_model_catalog',
        JSON.parse(JSON.stringify(result.catalog))
      )
    );
    expect(loaded.pricing_factors).toEqual(catalog.pricing_factors);
    expect(loaded.standard_prices).toEqual(catalog.standard_prices);
    tiers.forEach(({ model, key }, index) => {
      expect(loaded.models.find((item) => item.id === model.id)?.price_matrix[key]).toBe(
        calculateVideoPlazaPrice((index + 1) / 100, catalog.pricing_factors!)?.credits
      );
    });
    expect(catalog).toEqual(before);
    for (const invalid of [null, 1_000_000]) {
      const incomplete = structuredClone(catalog);
      incomplete.standard_prices![keys[0]] = invalid;
      const original = structuredClone(incomplete);
      expect(recalculateVideoPlazaCatalog(incomplete).catalog).toBeNull();
      expect(recalculateVideoPlazaCatalog(incomplete).issues).toHaveLength(1);
      expect(incomplete).toEqual(original);
    }
    delete catalog.standard_prices[keys[0]];
    expect(recalculateVideoPlazaCatalog(catalog).catalog).toBeNull();
    expect(recalculateVideoPlazaCatalog(createCatalog()).catalog).toBeNull();
  });
});

describe('image plaza pricing calculator', () => {
  it('keeps the valid catalog intact when a parameter is cleared and then re-entered', () => {
    const catalog = ImagePlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_model_catalog.defaultValue
    );
    catalog.models[0].resolutions[0].credits = 30;
    catalog.standard_prices = { [imagePlazaPriceKey(catalog.models[0].id, '1K')]: 0.04 };
    const before = structuredClone(catalog);
    for (const value of [null, 0, -1, NaN, Infinity, 1_000_001, 0.00001]) {
      expect(updateImagePlazaPricingFactor(catalog, 'markup', value)).toBeNull();
      expect(catalog).toEqual(before);
    }
    const updated = updateImagePlazaPricingFactor(catalog, 'markup', 2.5);
    expect(updated?.pricing_factors).toEqual({ exchange: 7.3, markup: 2.5, ratio: 100 });
    expect(updated?.models).toEqual(before.models);
    expect(updated?.standard_prices).toEqual(before.standard_prices);
    expect(ImagePlazaModelCatalogSchema.safeParse(updated).success).toBe(true);
  });

  it('loads saved parameters after reopening and preserves manual prices until recalculation', () => {
    const catalog = ImagePlazaModelCatalogSchema.parse(
      configMetadata.image_plaza_model_catalog.defaultValue
    );
    catalog.models[0].resolutions[0].credits = 30;
    const modelsBefore = structuredClone(catalog.models);
    catalog.pricing_factors = { exchange: 7.3, markup: 2.5, ratio: 100 };
    const loaded = ImagePlazaModelCatalogSchema.parse(
      parseManagedConfig('image_plaza_model_catalog', JSON.parse(JSON.stringify(catalog)))
    );
    expect(getImagePlazaPricingFactors(loaded)).toEqual(catalog.pricing_factors);
    expect(loaded.models).toEqual(modelsBefore);
    expect(calculateImagePlazaPrice(0.06, getImagePlazaPricingFactors(loaded))).toEqual({
      raw: 109.5,
      credits: 110,
    });
    delete loaded.pricing_factors;
    expect(getImagePlazaPricingFactors(loaded)).toEqual(factors);
    expect(loaded.pricing_factors).toBeUndefined();
  });

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
