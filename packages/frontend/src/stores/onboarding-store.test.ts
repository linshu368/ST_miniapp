import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  guideStorageKey,
  isGuideActive,
  isBasicGuideFinished,
  parseGuideProgress,
  useOnboardingStore,
} from './onboarding-store';

afterEach(() => {
  useOnboardingStore.setState({ accounts: {}, hydrated: {}, creatorReturns: {} });
  vi.unstubAllGlobals();
});
describe('newcomer guide persistence', () => {
  it('isolates accounts and preserves skipping even if eligibility arrives again', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => values.get(k) ?? null,
        setItem: (k: string, v: string) => values.set(k, v),
      },
    });
    const data = { eligible: true, expires_at: new Date(Date.now() + 60_000).toISOString() };
    const store = useOnboardingStore.getState();
    store.enroll('a', data);
    store.enroll('b', data);
    store.update('a', { skipped: true });
    store.enroll('a', data);
    expect(isGuideActive(useOnboardingStore.getState().accounts.a)).toBe(false);
    expect(isGuideActive(useOnboardingStore.getState().accounts.b)).toBe(true);
    expect(parseGuideProgress(values.get(guideStorageKey('a'))!)).toMatchObject({ skipped: true });
    useOnboardingStore.setState({ accounts: {}, hydrated: {} });
    store.hydrate('a');
    expect(isGuideActive(useOnboardingStore.getState().accounts.a)).toBe(false);
  });
  it('fails quietly for bad storage, expiry and unavailable storage', () => {
    expect(parseGuideProgress('{broken')).toBeUndefined();
    expect(parseGuideProgress('{"expiresAt":42}')).toBeUndefined();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw Error('denied');
        },
        setItem: () => {
          throw Error('denied');
        },
      },
    });
    const store = useOnboardingStore.getState();
    store.hydrate('a');
    store.enroll('a', { eligible: false, expires_at: null });
    expect(isGuideActive(useOnboardingStore.getState().accounts.a)).toBe(false);
    store.enroll('b', { eligible: true, expires_at: new Date(1).toISOString() });
    expect(isGuideActive(useOnboardingStore.getState().accounts.b)).toBe(false);
  });
  it('only arms real chat returns for enrolled accounts and remembers creator dismissal', () => {
    const store = useOnboardingStore.getState();
    store.enroll('new', {
      eligible: true,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    store.enroll('old', { eligible: false, expires_at: null });
    expect(store.takeCreatorReturn('new')).toBe(false);
    store.armCreatorReturn('old');
    expect(store.takeCreatorReturn('old')).toBe(false);
    store.armCreatorReturn('new');
    expect(store.takeCreatorReturn('new')).toBe(true);
    expect(store.takeCreatorReturn('new')).toBe(false);
    expect(isBasicGuideFinished(useOnboardingStore.getState().accounts.new)).toBe(false);
    store.update('new', { skipped: true });
    expect(isBasicGuideFinished(useOnboardingStore.getState().accounts.new)).toBe(true);
    store.update('new', { creatorInvite: 'dismissed', skipped: false });
    expect(useOnboardingStore.getState().accounts.new?.skipped).toBe(true);
    store.armCreatorReturn('new');
    expect(store.takeCreatorReturn('new')).toBe(false);
  });
  it('counts cross-card successful requests once and stops at ten, isolated from other accounts', () => {
    const store = useOnboardingStore.getState();
    const expires_at = new Date(Date.now() + 60_000).toISOString();
    store.enroll('a', { eligible: true, expires_at });
    store.enroll('b', { eligible: true, expires_at });
    store.recordCompletedTurn('a', 'session-1:request-1');
    store.recordCompletedTurn('a', 'session-1:request-1');
    expect(useOnboardingStore.getState().accounts.a?.completedTurns).toHaveLength(1);
    expect(useOnboardingStore.getState().accounts.b?.completedTurns).toBeUndefined();
    for (let i = 0; i < 20; i++) store.recordCompletedTurn('a', `session-${i}:request-${i}`);
    expect(useOnboardingStore.getState().accounts.a?.completedTurns).toHaveLength(10);
    store.update('b', { creatorStarted: true });
    store.recordCompletedTurn('b', 'session-b:request-b');
    expect(useOnboardingStore.getState().accounts.b?.completedTurns).toBeUndefined();
  });
});
