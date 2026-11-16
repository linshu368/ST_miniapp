import Fastify, { type FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  ChatFolderRepository,
  ChatFolderRepositoryError,
} from '../infrastructure/repositories/ChatFolderRepository.js';
const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  summary: vi.fn(),
  displayName: vi.fn(),
  user: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireTelegramAuth: async (request: FastifyRequest) => {
    if (request.headers['x-test-auth'] !== 'missing')
      request.user = { id: 12345, first_name: 'Fixture' };
  },
}));
vi.mock('../lib/user.js', () => ({ getOrCreateDbUser: mocks.user }));
vi.mock(
  '../features/conversations/index.js',
  async () => import('../features/conversations/user-placeholder.js')
);
import {
  registerConversationGroups,
  readFolderSummary,
  FOLDER_SUMMARY_TIMEOUT_MS,
} from './conversation-folders.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { ChatSessionRepository } from '../infrastructure/repositories/ChatSessionRepository.js';
import { registerConversationList } from './conversation-sessions.js';

const app = Fastify({ logger: false });
const folders = new ChatFolderRepository();
const settings = new MiniappUserSettingsRepository();
const sessions = new ChatSessionRepository();
const summary = { all: 1, ungrouped: 1, folders: [] };
beforeEach(() => {
  vi.spyOn(folders, 'listGroups').mockImplementation(mocks.listGroups);
  vi.spyOn(folders, 'summary').mockImplementation(mocks.summary);
  vi.spyOn(settings, 'getDisplayName').mockImplementation(mocks.displayName);
  vi.spyOn(sessions, 'listSessions').mockResolvedValue({ sessions: [], total: 0 });
  mocks.user.mockResolvedValue({ id: 'fixture-user' });
  mocks.displayName.mockResolvedValue('Fixture');
  mocks.listGroups.mockResolvedValue({ groups: [], total: 0 });
  mocks.summary.mockResolvedValue(summary);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  vi.useRealTimers();
});
registerConversationGroups(app, { folders, settings });
registerConversationList(app, { folders, settings, sessions });
afterAll(() => app.close());

describe('groups response and optional summary budget', () => {
  it('keeps the flat fallback response usable when the same summary dependency fails', async () => {
    mocks.summary.mockRejectedValue(new Error('Synthetic summary failure'));
    const response = await app.inject('/api/v1/conversations?summary=1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ sessions: [], total: 0 });
    expect(sessions.listSessions).toHaveBeenCalledOnce();
    expect(mocks.listGroups).not.toHaveBeenCalled();
  });
  it('keeps the existing success/summary contract', async () => {
    const response = await app.inject('/api/v1/conversations/groups?summary=1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.folder_summary).toEqual(summary);
    expect(mocks.summary).toHaveBeenCalledWith('fixture-user', expect.any(AbortSignal));
  });
  it('returns the existing 503 contract for unavailable groups', async () => {
    mocks.listGroups.mockRejectedValue(
      new ChatFolderRepositoryError('folders_unavailable', 'Fixture deadline')
    );
    const response = await app.inject('/api/v1/conversations/groups');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('folders_unavailable');
  });
  it('preserves unknown 500 and auth failures', async () => {
    mocks.listGroups.mockRejectedValue(new Error('Synthetic programming error'));
    expect((await app.inject('/api/v1/conversations/groups')).statusCode).toBe(500);
    mocks.listGroups.mockClear();
    expect(
      (
        await app.inject({
          url: '/api/v1/conversations/groups',
          headers: { 'x-test-auth': 'missing' },
        })
      ).statusCode
    ).toBe(401);
    expect(mocks.listGroups).not.toHaveBeenCalled();
  });
  it('skips optional summary outside the first page', async () => {
    const response = await app.inject('/api/v1/conversations/groups?summary=1&offset=20');
    expect(response.statusCode).toBe(200);
    expect(mocks.summary).not.toHaveBeenCalled();
  });
  it('returns primary groups without a slow summary', async () => {
    let signal: AbortSignal | undefined;
    mocks.summary.mockImplementation((_user: string, value: AbortSignal) => {
      signal = value;
      return new Promise(() => {});
    });
    const response = await app.inject('/api/v1/conversations/groups?summary=1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).not.toHaveProperty('folder_summary');
    expect(signal?.aborted).toBe(true);
  });
  it('bounds even a non-cooperative summary, observes late failure and clears timers', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    mocks.summary.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    const read = readFolderSummary(folders, 'fixture-user', app.log as FastifyBaseLogger);
    await vi.advanceTimersByTimeAsync(FOLDER_SUMMARY_TIMEOUT_MS);
    expect(await read).toBeNull();
    reject(new Error('Synthetic late failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
