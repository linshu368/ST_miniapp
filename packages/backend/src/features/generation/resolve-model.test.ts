import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG } from '../../platform/model-tiers.js';
import { resolveModelForUser } from './resolve-model.js';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  selected: vi.fn(),
  entitlement: vi.fn(),
  correctSelected: vi.fn(),
}));

vi.mock('../../platform/model-tiers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/model-tiers.js')>()),
  fetchModelCatalogSnapshot: mocks.catalog,
}));
vi.mock('../../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {
    getSelectedModelId = mocks.selected;
    correctSelectedModelId = mocks.correctSelected;
  },
}));
vi.mock('../vip/vip-status.js', () => ({
  VipStatusService: class {
    getStatus = mocks.entitlement;
  },
}));

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.catalog.mockResolvedValue({ catalog: DEFAULT_CATALOG, version: 999 });
  mocks.selected.mockResolvedValue(DEFAULT_CATALOG.default_model_id);
  mocks.entitlement.mockResolvedValue({ active: true, valid_until: '2027-01-01T00:00:00Z' });
});

describe('one conversation preparation snapshot', () => {
  it('reuses the supplied selection and catalog for model identity, policy and quote', async () => {
    const model = DEFAULT_CATALOG.tiers[0]!.models[0]!;
    const result = await resolveModelForUser('user', {
      selectedModelId: model.id,
      catalogSnapshot: { catalog: DEFAULT_CATALOG, version: 77 },
    });
    expect(mocks.selected).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(result.modelId).toBe(model.id);
    expect(result.firstTokenPolicy?.catalogVersion).toBe(77);
    expect(result.billingContext).toMatchObject({
      modelId: model.id,
      provider: model.provider,
      providerModelId: model.provider_model_id,
      catalogVersion: 77,
    });
  });

  it('starts entitlement lookup before settings and instruction normalization finish', async () => {
    let select!: (value: string | null) => void;
    const selectedModelId = new Promise<string | null>((resolve) => {
      select = resolve;
    });
    const result = resolveModelForUser('user', {
      selectedModelId,
      catalogSnapshot: { catalog: DEFAULT_CATALOG, version: 77 },
    });
    expect(mocks.entitlement).toHaveBeenCalledExactlyOnceWith('user', expect.anything());
    expect(mocks.selected).not.toHaveBeenCalled();
    select(DEFAULT_CATALOG.default_model_id);
    await expect(result).resolves.toMatchObject({
      modelId: DEFAULT_CATALOG.default_model_id,
      billingContext: { catalogVersion: 77 },
    });
  });

  it('keeps standalone consumers compatible and reads their catalog only once', async () => {
    const result = await resolveModelForUser('user');
    expect(mocks.selected).toHaveBeenCalledExactlyOnceWith('user');
    expect(mocks.catalog).toHaveBeenCalledOnce();
    expect(result.billingContext?.catalogVersion).toBe(999);
  });
});
