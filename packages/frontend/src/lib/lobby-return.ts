'use client';

import type { LobbySort } from '@miniapp/shared';

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_KEY = 'miniapp:lobby-return:v1';
const SNAPSHOT_TTL_MS = 2 * 60 * 60_000;

let documentToken: string | null = null;
let memorySnapshot: LobbyReturnSnapshot | null = null;

export interface LobbyReturnSnapshot {
  version: 1;
  documentToken: string;
  createdAt: number;
  sort: LobbySort;
  query: string;
  anchorCharacterId: string;
  neighborCharacterIds: string[];
  loadedCharacterIds: string[];
  anchorViewportTop: number;
  scrollY: number;
  viewportWidth: number;
}

export interface LobbyReturnSnapshotInput {
  sort: LobbySort;
  query: string;
  anchorCharacterId: string;
  neighborCharacterIds: string[];
  loadedCharacterIds: string[];
  anchorViewportTop: number;
  scrollY: number;
  viewportWidth: number;
}

function getDocumentToken(): string | null {
  if (typeof window === 'undefined') return null;
  if (!documentToken) {
    documentToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return documentToken;
}

function isLobbySort(value: unknown): value is LobbySort {
  return value === 'recommended' || value === 'latest';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validateSnapshot(value: unknown): LobbyReturnSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const token = getDocumentToken();
  const createdAt = toFiniteNumber(candidate.createdAt);
  const anchorViewportTop = toFiniteNumber(candidate.anchorViewportTop);
  const scrollY = toFiniteNumber(candidate.scrollY);
  const viewportWidth = toFiniteNumber(candidate.viewportWidth);

  if (
    candidate.version !== SNAPSHOT_VERSION ||
    !token ||
    candidate.documentToken !== token ||
    !createdAt ||
    Date.now() - createdAt > SNAPSHOT_TTL_MS ||
    !isLobbySort(candidate.sort) ||
    typeof candidate.query !== 'string' ||
    typeof candidate.anchorCharacterId !== 'string' ||
    !isStringArray(candidate.neighborCharacterIds) ||
    !isStringArray(candidate.loadedCharacterIds) ||
    anchorViewportTop === null ||
    scrollY === null ||
    viewportWidth === null
  ) {
    return null;
  }

  return {
    version: SNAPSHOT_VERSION,
    documentToken: token,
    createdAt,
    sort: candidate.sort,
    query: candidate.query,
    anchorCharacterId: candidate.anchorCharacterId,
    neighborCharacterIds: candidate.neighborCharacterIds,
    loadedCharacterIds: candidate.loadedCharacterIds,
    anchorViewportTop,
    scrollY,
    viewportWidth,
  };
}

function readStoredSnapshot(): LobbyReturnSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    const snapshot = validateSnapshot(parsed);
    if (!snapshot) clearLobbyReturnSnapshot();
    return snapshot;
  } catch {
    clearLobbyReturnSnapshot();
    return null;
  }
}

export function readLobbyReturnSnapshot(): LobbyReturnSnapshot | null {
  const memory = validateSnapshot(memorySnapshot);
  if (memory) return memory;
  if (memorySnapshot) memorySnapshot = null;
  return readStoredSnapshot();
}

export function saveLobbyReturnSnapshot(input: LobbyReturnSnapshotInput): void {
  const token = getDocumentToken();
  if (!token) return;

  const snapshot: LobbyReturnSnapshot = {
    version: SNAPSHOT_VERSION,
    documentToken: token,
    createdAt: Date.now(),
    ...input,
  };
  memorySnapshot = snapshot;

  try {
    window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // sessionStorage can fail in private modes or quota pressure; memory keeps
    // the current SPA document return path working without blocking navigation.
  }
}

export function clearLobbyReturnSnapshot(): void {
  memorySnapshot = null;
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    // Storage cleanup is best-effort only.
  }
}

export function returnToLobby(push: (href: string) => void): void {
  push('/');
}
