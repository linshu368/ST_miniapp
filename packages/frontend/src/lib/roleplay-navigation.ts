import type { LobbySort } from '@miniapp/shared';

export type RoleplayView = '/' | '/chats';
export type RoleplaySource = 'discover' | 'conversations';

const VIEW_KEY = 'miniapp:roleplay-view:v1';
const DISCOVERY_KEY = 'miniapp:roleplay-discovery:v1';
const SCROLL_PREFIX = 'miniapp:roleplay-scroll:v1:';

function read(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(key, value);
  } catch {
    // A blocked storage API must not block navigation.
  }
}

export function resolveRoleplaySource(value: string | null | undefined): RoleplaySource {
  return value === 'conversations' ? 'conversations' : 'discover';
}

export function roleplayReturnPath(source: string | null | undefined): RoleplayView {
  return resolveRoleplaySource(source) === 'conversations' ? '/chats' : '/';
}

export function readRoleplayView(): RoleplayView {
  return read(VIEW_KEY) === '/chats' ? '/chats' : '/';
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

export function readRoleplayDiscovery(): RoleplayDiscoveryState {
  const fallback: RoleplayDiscoveryState = { sort: 'recommended', query: '', favoritesOnly: false };
  try {
    const raw = read(DISCOVERY_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const value = parsed as Partial<Record<keyof RoleplayDiscoveryState, unknown>>;
    return {
      sort: value.sort === 'latest' ? 'latest' : 'recommended',
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
