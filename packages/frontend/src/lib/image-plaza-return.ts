'use client';

import type { ImagePlazaFeedSort } from '@miniapp/shared';

const SNAPSHOT_TTL_MS = 2 * 60 * 60_000;

export interface ImagePlazaBrowseState {
  search: string;
  tag?: string;
  tags?: string[];
  media?: 'all' | 'image' | 'video';
  sort: ImagePlazaFeedSort;
}

export interface ImagePlazaReturnSnapshot extends ImagePlazaBrowseState {
  createdAt: number;
  anchorId: string | null;
  anchorTop: number;
  nearbyCards: { id: string; top: number }[];
  scrollY: number;
}

// A same-document return aid, never a second cache of works or pagination cursors.
let snapshot: ImagePlazaReturnSnapshot | null = null;

function cards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-image-work-id]'));
}

export function saveImagePlazaReturn(state: ImagePlazaBrowseState, preferredWorkId?: string): void {
  if (typeof window === 'undefined') return;
  const headerBottom =
    document.querySelector<HTMLElement>('[data-image-plaza-header]')?.getBoundingClientRect()
      .bottom ?? 0;
  const visible = cards()
    .map((card) => ({ card, rect: card.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > headerBottom)
    .sort((a, b) => Math.abs(a.rect.top - headerBottom) - Math.abs(b.rect.top - headerBottom));
  const anchor =
    visible.find(({ card }) => card.dataset.imageWorkId === preferredWorkId) ?? visible[0];
  snapshot = {
    search: state.search.slice(0, 500),
    tag: state.tag,
    tags: state.tags ? [...state.tags] : undefined,
    media: state.media,
    sort: state.sort,
    createdAt: Date.now(),
    anchorId: anchor?.card.dataset.imageWorkId ?? null,
    anchorTop: anchor?.rect.top ?? 0,
    nearbyCards: visible
      .slice(0, 8)
      .flatMap(({ card, rect }) =>
        card.dataset.imageWorkId ? [{ id: card.dataset.imageWorkId, top: rect.top }] : []
      ),
    scrollY: window.scrollY,
  };
}

export function readImagePlazaReturn(): ImagePlazaReturnSnapshot | null {
  if (typeof window === 'undefined' || !snapshot) return null;
  const age = Date.now() - snapshot.createdAt;
  if (age < 0 || age > SNAPSHOT_TTL_MS) {
    snapshot = null;
    return null;
  }
  return {
    ...snapshot,
    tags: snapshot.tags ? [...snapshot.tags] : undefined,
    nearbyCards: snapshot.nearbyCards.map((card) => ({ ...card })),
  };
}

export function clearImagePlazaReturn(): void {
  snapshot = null;
}

export function restoreImagePlazaReturn(value: ImagePlazaReturnSnapshot): void {
  if (typeof window === 'undefined') return;
  const available = cards();
  const candidates = value.anchorId
    ? [{ id: value.anchorId, top: value.anchorTop }, ...value.nearbyCards]
    : value.nearbyCards;
  const anchor = candidates
    .map((candidate) => ({
      card: available.find((card) => card.dataset.imageWorkId === candidate.id),
      top: candidate.top,
    }))
    .find(({ card }) => card !== undefined);
  const target = anchor?.card
    ? window.scrollY + anchor.card.getBoundingClientRect().top - anchor.top
    : value.scrollY;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: Math.min(maxScroll, Math.max(0, target)), left: 0, behavior: 'auto' });
}
