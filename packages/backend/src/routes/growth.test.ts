import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ record: vi.fn(), token: 'local-unit-test-only' }));
vi.mock('../platform/config.js', () => ({ config: { telegramBotToken: mocks.token } }));
vi.mock('../features/growth/entry.js', () => ({ recordEntry: mocks.record }));
import growthRoutes from './growth.js';
function signed(source?: string, age = 0, id = 12345) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id, first_name: 'Fixture' }),
  });
  if (source) params.set('start_param', source);
  const data = [...params]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(mocks.token).digest();
  params.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}
async function call(header?: string, path = 'mujian-entry') {
  const app = Fastify();
  await app.register(growthRoutes);
  try {
    return await app.inject({
      method: 'POST',
      url: '/api/growth/' + path,
      headers: header ? { 'x-init-data': header } : {},
      payload: { source_id: 'forged', user_id: 999 },
    });
  } finally {
    await app.close();
  }
}
describe('signed entry endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.record.mockResolvedValue({ recorded: true, source_id: 'mujian_dzmm' });
  });
  it('ignores body identity/source and shares Telegram identity across endpoints', async () => {
    const raw = signed('mujian_dzmm');
    expect((await call(raw)).statusCode).toBe(200);
    expect((await call(raw, 'miniapp-entry')).statusCode).toBe(200);
    expect(mocks.record).toHaveBeenNthCalledWith(
      1,
      '12345',
      'mujian',
      'mujian_dzmm',
      expect.any(Number)
    );
    expect(mocks.record).toHaveBeenNthCalledWith(
      2,
      '12345',
      'mijing',
      'mujian_dzmm',
      expect.any(Number)
    );
  });
  it('records organic and existing channel launches without fallback to dzmm', async () => {
    await call(signed());
    expect(mocks.record.mock.calls[0]?.[2]).toBeNull();
    await call(signed('legacy_channel'), 'miniapp-entry');
    expect(mocks.record.mock.calls[1]?.[2]).toBe('legacy_channel');
  });
  it('rejects absent, forged, expired, future and duplicated identity even with development bypass', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    vi.stubEnv('MOCK_AUTH', '1');
    for (const raw of [
      undefined,
      signed().replace('12345', '99999'),
      signed(undefined, 86401),
      signed(undefined, -100),
      signed() + '&auth_date=1',
    ]) {
      expect((await call(raw)).statusCode).toBe(401);
    }
    expect(mocks.record).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it('never acknowledges failed persistence', async () => {
    mocks.record.mockRejectedValue(new Error('database unavailable'));
    const result = await call(signed());
    expect(result.statusCode).toBe(503);
    expect(result.json().success).toBe(false);
  });
});
