import { beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({
  pathname: '/create/work/example',
  ready: vi.fn(),
  failed: vi.fn(),
  cleanups: [] as Array<() => void>,
}));

vi.mock('next/navigation', () => ({ usePathname: () => hook.pathname }));
vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hook.cleanups.push(cleanup);
  },
  useRef: (current: unknown) => ({ current }),
}));
vi.mock('./page-tracker', () => ({ markPageReady: hook.ready, markPageFailed: hook.failed }));

import { usePageReady } from './page-ready';

describe('page ready follows the visible business-content branch', () => {
  beforeEach(() => {
    hook.ready.mockClear();
    hook.failed.mockClear();
    hook.cleanups = [];
    hook.pathname = '/create/work/example';
  });

  it('reports error, not ready, when a full-page error hides cached data', async () => {
    const cachedData = { work: { id: 'example' } };
    const isError = true;
    // 与作品/通知/订单详情相同：存在缓存不足以证明页面正展示业务内容。
    usePageReady('/create/work/:id', cachedData !== undefined && !isError, false, isError);
    await Promise.resolve();
    expect(hook.failed).toHaveBeenCalledExactlyOnceWith('/create/work/:id', hook.pathname);
    expect(hook.ready).not.toHaveBeenCalled();
  });

  it('preserves ready priority when usable cached content remains visible after a refresh error', async () => {
    usePageReady('/create', true, false, true, 'cache');
    await Promise.resolve();
    expect(hook.ready).toHaveBeenCalledExactlyOnceWith(
      '/create',
      'content',
      hook.pathname,
      'cache'
    );
    expect(hook.failed).not.toHaveBeenCalled();
  });

  it('does not report readiness while the visible panel is still loading', async () => {
    usePageReady('/profile/invite', false, false, false);
    await Promise.resolve();
    expect(hook.ready).not.toHaveBeenCalled();
    expect(hook.failed).not.toHaveBeenCalled();
  });

  it('discards deferred notifications after the owning page effect is cleaned up', async () => {
    usePageReady('/create/work/:id', true);
    hook.cleanups.forEach((cleanup) => cleanup());
    await Promise.resolve();
    expect(hook.ready).not.toHaveBeenCalled();
    expect(hook.failed).not.toHaveBeenCalled();
  });
});
