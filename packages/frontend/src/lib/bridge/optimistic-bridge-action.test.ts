import { describe, expect, it, vi } from 'vitest';
import { optimisticBridgeAction } from './optimistic-bridge-action';

describe('optimisticBridgeAction', () => {
  it('persists and bridges without compensation on success', async () => {
    const rollbackPersisted = vi.fn(async () => undefined);
    const rollbackOptimistic = vi.fn();

    await expect(
      optimisticBridgeAction({
        applyOptimistic: vi.fn(),
        persist: async () => ({ id: 'selected' }),
        bridge: async () => undefined,
        rollbackPersisted,
        rollbackOptimistic,
      })
    ).resolves.toEqual({ id: 'selected' });
    expect(rollbackPersisted).not.toHaveBeenCalled();
    expect(rollbackOptimistic).not.toHaveBeenCalled();
  });

  it('rolls back UI only when persistence fails', async () => {
    const rollbackPersisted = vi.fn(async () => undefined);
    const rollbackOptimistic = vi.fn();

    await expect(
      optimisticBridgeAction({
        applyOptimistic: vi.fn(),
        persist: async () => {
          throw new Error('persist failed');
        },
        bridge: async () => undefined,
        rollbackPersisted,
        rollbackOptimistic,
      })
    ).rejects.toThrow('persist failed');
    expect(rollbackOptimistic).toHaveBeenCalledOnce();
    expect(rollbackPersisted).not.toHaveBeenCalled();
  });

  it('compensates persistence and UI when Bridge application fails', async () => {
    const rollbackPersisted = vi.fn(async () => undefined);
    const rollbackOptimistic = vi.fn();

    await expect(
      optimisticBridgeAction({
        applyOptimistic: vi.fn(),
        persist: async () => ({ id: 'selected' }),
        bridge: async () => {
          throw new Error('bridge failed');
        },
        rollbackPersisted,
        rollbackOptimistic,
      })
    ).rejects.toThrow('bridge failed');
    expect(rollbackOptimistic).toHaveBeenCalledOnce();
    expect(rollbackPersisted).toHaveBeenCalledWith({ id: 'selected' });
  });
});
