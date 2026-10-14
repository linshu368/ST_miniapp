import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from './config.js';
import { veniceFetch } from './venice-http.js';

const originalVeniceConfig = { ...config.venice };

afterEach(() => {
  Object.assign(config.venice, originalVeniceConfig);
  vi.unstubAllGlobals();
});

describe('veniceFetch', () => {
  it('直连全局 fetch（未配置代理时，对应 Railway/生产）', async () => {
    Object.assign(config.venice, { httpsProxy: '' });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await veniceFetch('https://api.venice.ai/api/v1/models');
    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('拒绝非法代理 URL', async () => {
    Object.assign(config.venice, { httpsProxy: 'not-a-url' });
    await expect(veniceFetch('https://api.venice.ai/api/v1/models')).rejects.toThrow(
      'venice_https_proxy_url_invalid'
    );
  });
});
