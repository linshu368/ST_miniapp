import type { LobbySort } from '@miniapp/shared';
import { lobbyViewerScope } from './lobby-recommendation-state';

export type RoleplayView = '/characters' | '/chats';
export type RoleplaySource =
  | 'discover'
  | 'conversations'
  | 'space'
  | 'created'
  | `creator.${string}`;

const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
let creatorOpener: { id: string; path: string; scroll?: number } | null = null;

// Keep the caller within this document; shared creator URLs never carry private session IDs.
export function rememberPublicCreatorOpener(id: string) {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  let path = '/characters';
  if (/^\/chat\/[^/]+$/.test(pathname) && UUID.test(pathname.slice(6))) {
    const chatParams = new URLSearchParams({ from: resolveRoleplaySource(params.get('from')) });
    const session = params.get('session');
    if (session && UUID.test(session)) chatParams.set('session', session);
    path = pathname + '?' + chatParams;
  } else if (pathname === '/creation') {
    path = roleplayReturnPath(params.get('tab') === 'created' ? 'created' : 'space');
  } else if (pathname === '/chats') {
    path = '/chats';
  }
  creatorOpener = { id, path };
}

export function publicCreatorBackHref(id: string) {
  return creatorOpener?.id === id ? creatorOpener.path : '/characters';
}

export function rememberCreatorWorksScroll(id: string) {
  creatorOpener = { id, path: publicCreatorBackHref(id), scroll: window.scrollY };
}

export function restoreCreatorWorksScroll(id: string) {
  if (creatorOpener?.id !== id || creatorOpener.scroll === undefined) return;
  window.scrollTo({ top: creatorOpener.scroll, behavior: 'instant' });
  delete creatorOpener.scroll;
}

const VIEW_KEY = 'miniapp:roleplay-view:v1';
const DISCOVERY_KEY = 'miniapp:roleplay-discovery:v1';
const SCROLL_PREFIX = 'miniapp:roleplay-scroll:v1:';

function read(key: string): string | null {
  try {
    return typeof window === 'undefined'
      ? null
      : window.sessionStorage.getItem(`${key}:${lobbyViewerScope()}`);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined')
      window.sessionStorage.setItem(`${key}:${lobbyViewerScope()}`, value);
  } catch {
    // A blocked storage API must not block navigation.
  }
}

export function resolveRoleplaySource(value: string | null | undefined): RoleplaySource {
  if (value?.startsWith('creator.') && UUID.test(value.slice(8)))
    return `creator.${value.slice(8)}`;
  return value === 'conversations' || value === 'space' || value === 'created' ? value : 'discover';
}

export function roleplayReturnPath(
  source: string | null | undefined
): RoleplayView | '/creation?tab=favorites' | '/creation?tab=created' | `/creators/${string}` {
  const origin = resolveRoleplaySource(source);
  if (origin.startsWith('creator.')) return `/creators/${origin.slice(8)}`;
  if (origin === 'created') return '/creation?tab=created';
  if (origin === 'space') return '/creation?tab=favorites';
  return origin === 'conversations' ? '/chats' : '/characters';
}

export function readRoleplayView(): RoleplayView {
  return read(VIEW_KEY) === '/chats' ? '/chats' : '/characters';
}

export function rememberRoleplayView(path: RoleplayView): void {
  write(VIEW_KEY, path);
}

export function rememberRoleplayScroll(path: RoleplayView): void {
  if (typeof window !== 'undefined') write(SCROLL_PREFIX + path, String(window.scrollY));
}

export function readRoleplayScroll(path: RoleplayView): number {
  const value = Number(read(SCROLL_PREFIX + path));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function restoreRoleplayScroll(path: RoleplayView): void {
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: readRoleplayScroll(path), left: 0, behavior: 'auto' });
  }
}

export interface RoleplayDiscoveryState {
  sort: LobbySort;
  query: string;
  favoritesOnly: boolean;
}

export function readRoleplayDiscovery(
  defaultSort: LobbySort = 'recommended'
): RoleplayDiscoveryState {
  const fallback: RoleplayDiscoveryState = { sort: defaultSort, query: '', favoritesOnly: false };
  try {
    const raw = read(DISCOVERY_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const value = parsed as Partial<Record<keyof RoleplayDiscoveryState, unknown>>;
    return {
      sort: value.sort === 'latest' || value.sort === 'recommended' ? value.sort : defaultSort,
      query: typeof value.query === 'string' ? value.query.slice(0, 500) : '',
      favoritesOnly: value.favoritesOnly === true,
    };
  } catch {
    return fallback;
  }
}

export function rememberRoleplayDiscovery(value: RoleplayDiscoveryState): void {
  write(DISCOVERY_KEY, JSON.stringify(value));
}
