'use client';

import { useEffect, useState } from 'react';

import { getTelegramPlatform } from '@/lib/perf/env-tags';

export type MobilePlatformGroup = 'android' | 'ios' | 'other';

interface ListBudget {
  initialRenderCount: number;
  renderBatchSize: number;
  renderMoreRootMargin: string;
  eagerImageCount: number;
  highPriorityImageCount: number;
}

export interface MobilePerformancePolicy {
  platform: MobilePlatformGroup;
  characters: ListBudget;
  dramas: ListBudget;
  homePoster: {
    width: number;
    height: number;
    quality: number;
    videoPreload: 'auto' | 'metadata';
  };
  routePriority: ReadonlyArray<'characters' | 'home' | 'dramas' | 'other'>;
}

const POLICIES: Record<MobilePlatformGroup, MobilePerformancePolicy> = {
  android: {
    platform: 'android',
    characters: {
      initialRenderCount: 4,
      renderBatchSize: 4,
      renderMoreRootMargin: '200px',
      eagerImageCount: 1,
      highPriorityImageCount: 1,
    },
    dramas: {
      initialRenderCount: 6,
      renderBatchSize: 8,
      renderMoreRootMargin: '250px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    homePoster: { width: 480, height: 640, quality: 64, videoPreload: 'metadata' },
    routePriority: ['characters', 'home', 'dramas', 'other'],
  },
  ios: {
    platform: 'ios',
    characters: {
      initialRenderCount: 4,
      renderBatchSize: 6,
      renderMoreRootMargin: '250px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    dramas: {
      initialRenderCount: 6,
      renderBatchSize: 6,
      renderMoreRootMargin: '150px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    homePoster: { width: 480, height: 640, quality: 64, videoPreload: 'metadata' },
    routePriority: ['home', 'dramas', 'characters', 'other'],
  },
  other: {
    platform: 'other',
    characters: {
      // Hydration starts on this shared policy before Telegram exposes the platform.
      // Keep it aligned with mobile so cached lists never mount six cards first.
      initialRenderCount: 4,
      renderBatchSize: 8,
      renderMoreRootMargin: '300px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    dramas: {
      initialRenderCount: 6,
      renderBatchSize: 8,
      renderMoreRootMargin: '300px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    homePoster: { width: 480, height: 640, quality: 64, videoPreload: 'auto' },
    routePriority: ['home', 'characters', 'dramas', 'other'],
  },
};

export function mobilePlatformGroup(platform: string): MobilePlatformGroup {
  if (platform === 'android' || platform === 'android_x') return 'android';
  if (platform === 'ios') return 'ios';
  return 'other';
}

/**
 * Keep platform tuning bounded and deterministic. It is resource scheduling only:
 * business data, cache ownership, and route semantics remain shared across clients.
 */
export function getMobilePerformancePolicy(
  platform = getTelegramPlatform()
): MobilePerformancePolicy {
  return POLICIES[mobilePlatformGroup(platform)];
}

/** Keep the server and hydration pass on the same conservative policy, then specialize. */
export function useMobilePerformancePolicy(): MobilePerformancePolicy {
  const [platform, setPlatform] = useState('unknown');
  useEffect(() => setPlatform(getTelegramPlatform()), []);
  return getMobilePerformancePolicy(platform);
}
