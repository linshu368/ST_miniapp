import Fastify, { type FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(),
  claimed: vi.fn(),
  submit: vi.fn(),
  dismiss: vi.fn(),
  user: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    if (request.headers['x-test-auth'] !== 'missing')
      request.user = { id: 123, first_name: 'Synthetic' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock('../features/drama-survey/repository.js', async (original) => ({
  ...(await original<typeof import('../features/drama-survey/repository.js')>()),
  DramaSurveyRepository: class {
    isEnabled = mocks.enabled;
    hasClaimed = mocks.claimed;
    submit = mocks.submit;
    dismiss = mocks.dismiss;
  },
}));
import routes from './drama-survey.js';

const engagement = { engaged_dramas: 2, max_episode: 3 };
const answers = { open_reasons: ['chat_only'], watch_reasons: ['slow_start'], engagement };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockResolvedValue(true);
  mocks.claimed.mockResolvedValue(false);
  mocks.user.mockResolvedValue({ id: 'verified-owner' });
  mocks.submit.mockResolvedValue({ status: 'rewarded', credits: 200 });
  mocks.dismiss.mockResolvedValue(undefined);
});

async function request(
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  authenticated = true
) {
  const app = Fastify();
  await app.register(routes);
  try {
    return await app.inject({
      method,
      url,
      payload,
      headers: authenticated ? {} : { 'x-test-auth': 'missing' },
    });
  } finally {
    await app.close();
  }
}

describe('drama survey routes', () => {
  it('is eligible only while enabled and unclaimed', async () => {
    let response = await request('GET', '/api/v1/drama-survey');
    expect(response.json().data).toEqual({
      survey_key: 'drama_reason_v1',
      eligible: true,
      reward_credits: 200,
    });
    expect(mocks.claimed).toHaveBeenCalledWith('verified-owner');

    mocks.claimed.mockResolvedValue(true);
    response = await request('GET', '/api/v1/drama-survey');
    expect(response.json().data.eligible).toBe(false);

    mocks.enabled.mockResolvedValue(false);
    mocks.claimed.mockClear();
    response = await request('GET', '/api/v1/drama-survey');
    expect(response.json().data.eligible).toBe(false);
    expect(mocks.claimed).not.toHaveBeenCalled();
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('submits for the authenticated owner with the fixed reward', async () => {
    const response = await request('POST', '/api/v1/drama-survey', {
      ...answers,
      watch_reasons: ['slow_start', 'other'],
      watch_other_text: '  加载太慢 ',
      platform: 'ios',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ status: 'rewarded', credits: 200 });
    expect(mocks.submit).toHaveBeenCalledWith(
      'verified-owner',
      {
        open_reasons: ['chat_only'],
        open_other_text: '',
        watch_reasons: ['slow_start', 'other'],
        watch_other_text: '加载太慢',
        comment: '',
        platform: 'ios',
        engagement,
      },
      200
    );
  });

  it.each([
    {},
    { ...answers, open_reasons: [] },
    { ...answers, watch_reasons: [] },
    { ...answers, open_reasons: ['slow_start'] },
    { open_reasons: ['chat_only'], watch_reasons: ['slow_start'] },
    { ...answers, reward_credits: 9999 },
  ])('rejects invalid answers before DB work: %j', async (body) => {
    expect((await request('POST', '/api/v1/drama-survey', body)).statusCode).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('refuses submit and dismiss once the survey is closed', async () => {
    mocks.enabled.mockResolvedValue(false);
    expect((await request('POST', '/api/v1/drama-survey', answers)).statusCode).toBe(409);
    expect((await request('POST', '/api/v1/drama-survey/dismiss', { engagement })).statusCode).toBe(
      409
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it('records dismissal', async () => {
    const response = await request('POST', '/api/v1/drama-survey/dismiss', {
      platform: 'android',
      engagement,
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.dismiss).toHaveBeenCalledWith('verified-owner', {
      platform: 'android',
      engagement,
    });
    expect((await request('POST', '/api/v1/drama-survey/dismiss', {})).statusCode).toBe(400);
  });

  it('rejects missing authentication', async () => {
    expect((await request('GET', '/api/v1/drama-survey', undefined, false)).statusCode).toBe(401);
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it('maps database failures to 503 without leaking details', async () => {
    mocks.submit.mockRejectedValue(new Error('row contains 用户填写的文字'));
    const response = await request('POST', '/api/v1/drama-survey', answers);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('用户填写的文字');
  });
});
