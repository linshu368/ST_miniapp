import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { retrieveRawInitData } = vi.hoisted(() => ({ retrieveRawInitData: vi.fn() }));
vi.mock('@telegram-apps/sdk-react', () => ({ retrieveRawInitData }));

describe('Telegram signed launch payload capture', () => {
  beforeEach(() => {
    vi.resetModules();
    retrieveRawInitData.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each(['host', 'hash', 'query'])(
    'retains exact %s payload after URL cleanup',
    async (source) => {
      const raw = 'user=%7B%22id%22%3A123%7D&auth_date=1&hash=synthetic';
      const location = {
        hash: source === 'hash' ? `#tgWebAppData=${encodeURIComponent(raw)}` : '',
        search: source === 'query' ? `?tgWebAppData=${encodeURIComponent(raw)}` : '',
      };
      vi.stubGlobal('window', {
        location,
        Telegram: source === 'host' ? { WebApp: { initData: raw } } : undefined,
      });
      retrieveRawInitData.mockImplementation(() => {
        throw new Error('SDK unavailable');
      });
      const { getRawInitData } = await import('./auth');
      expect(getRawInitData()).toBe(raw);
      location.hash = '';
      location.search = '';
      expect(getRawInitData()).toBe(raw);
    }
  );
  it('does not manufacture identity from an unsigned user object', async () => {
    vi.stubGlobal('window', {
      location: { hash: '', search: '' },
      Telegram: { WebApp: { initDataUnsafe: { user: { id: 123 } } } },
    });
    const { getRawInitData } = await import('./auth');
    expect(getRawInitData()).toBeUndefined();
  });
});
