import { afterEach, describe, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../lib/supabase.js', () => ({ getDomainDb: () => database }));
import { ChatFolderRepository, ChatFolderRepositoryError } from './ChatFolderRepository.js';

afterEach(() => {
  vi.restoreAllMocks();
  database.rpc.mockReset();
});
describe('folder read dependency deadlines', () => {
  it.each(['57014', 'PGRST003', 'PGRST202'])(
    'maps known groups dependency %s to existing unavailable code',
    async (code) => {
      const error = { code, message: 'Synthetic dependency failure' };
      database.rpc.mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({ data: null, error }),
      });
      const read = new ChatFolderRepository().listGroups('fixture-user', {});
      await expect(read).rejects.toMatchObject({ code: 'folders_unavailable', cause: error });
    }
  );
  it('maps an owned SDK deadline rejection without broad AbortError suppression', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    database.rpc.mockReturnValue({
      abortSignal: (signal: AbortSignal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        ),
    });
    const read = new ChatFolderRepository().listGroups('fixture-user', {});
    const rejected = expect(read).rejects.toMatchObject({ code: 'folders_unavailable' });
    controller.abort(new DOMException('Synthetic deadline', 'TimeoutError'));
    await rejected;
  });
  it('maps deadline returned as an SDK error envelope too', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const error = { code: '', message: 'Synthetic SDK abort envelope' };
    database.rpc.mockReturnValue({
      abortSignal: async () => {
        controller.abort(new DOMException('deadline', 'TimeoutError'));
        return { data: null, error };
      },
    });
    await expect(new ChatFolderRepository().listGroups('fixture-user', {})).rejects.toMatchObject({
      code: 'folders_unavailable',
    });
  });
  it.each(['42501', 'XX000'])(
    'does not hide unexpected/permission code %s as unavailable',
    async (code) => {
      database.rpc.mockReturnValue({
        abortSignal: vi
          .fn()
          .mockResolvedValue({ data: null, error: { code, message: 'Synthetic failure' } }),
      });
      await expect(
        new ChatFolderRepository().listGroups('fixture-user', {})
      ).rejects.not.toBeInstanceOf(ChatFolderRepositoryError);
    }
  );
  it('preserves a foreign abort or programming exception when its own deadline has not fired', async () => {
    const error = new DOMException('Synthetic caller abort', 'AbortError');
    database.rpc.mockReturnValue({ abortSignal: vi.fn().mockRejectedValue(error) });
    await expect(new ChatFolderRepository().listGroups('fixture-user', {})).rejects.toBe(error);
  });
  it('does not disguise a known programming failure arriving at the deadline', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const error = { code: 'XX000', message: 'Synthetic SQL bug' };
    database.rpc.mockReturnValue({
      abortSignal: async () => {
        controller.abort(new DOMException('deadline', 'TimeoutError'));
        return { data: null, error };
      },
    });
    const read = new ChatFolderRepository().listGroups('fixture-user', {});
    await expect(read).rejects.not.toBeInstanceOf(ChatFolderRepositoryError);
  });
  it('does not disguise a thrown programming exception at the deadline', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const error = new TypeError('Synthetic programming failure');
    database.rpc.mockReturnValue({
      abortSignal: async () => {
        controller.abort(new DOMException('deadline', 'TimeoutError'));
        throw error;
      },
    });
    await expect(new ChatFolderRepository().listGroups('fixture-user', {})).rejects.toBe(error);
  });
  it('passes optional summary cancellation to the existing SDK RPC', async () => {
    let signal: AbortSignal | undefined;
    database.rpc.mockReturnValue({
      abortSignal: async (value: AbortSignal) => {
        signal = value;
        return { data: { all: 0, ungrouped: 0, folders: [] }, error: null };
      },
    });
    const controller = new AbortController();
    await new ChatFolderRepository().summary('fixture-user', controller.signal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});
