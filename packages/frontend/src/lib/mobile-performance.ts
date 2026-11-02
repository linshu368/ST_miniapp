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
  imagePlaza: {
    list: ListBudget;
    feedImageWidths: readonly number[];
    feedImageQuality: number;
    studioImageWidths: readonly number[];
    studioImageQuality: number;
    videoActivationRootMargin: string;
  };
  homePoster: {
    width: number;
    height: number;
    quality: number;
    videoPreload: 'auto' | 'metadata';
  };
  routePriority: ReadonlyArray<'characters' | 'home' | 'dramas' | 'other'>;
}

const IMAGE_PLAZA_FEED_WIDTHS = [240, 360, 480] as const;
const IMAGE_PLAZA_STUDIO_WIDTHS = [320, 480, 720] as const;

const POLICIES: Record<MobilePlatformGroup, MobilePerformancePolicy> = {
  android: {
    platform: 'android',
    characters: {
      initialRenderCount: 6,
      renderBatchSize: 6,
      renderMoreRootMargin: '200px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    dramas: {
      initialRenderCount: 6,
      renderBatchSize: 8,
      renderMoreRootMargin: '250px',
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    },
    imagePlaza: {
      list: {
        initialRenderCount: 6,
        renderBatchSize: 6,
        renderMoreRootMargin: '160px',
        eagerImageCount: 2,
        highPriorityImageCount: 1,
      },
      feedImageWidths: IMAGE_PLAZA_FEED_WIDTHS,
      feedImageQuality: 64,
      studioImageWidths: IMAGE_PLAZA_STUDIO_WIDTHS,
      studioImageQuality: 70,
      videoActivationRootMargin: '160px',
    },
    homePoster: { width: 480, height: 640, quality: 64, videoPreload: 'metadata' },
    routePriority: ['characters', 'home', 'dramas', 'other'],
  },
  ios: {
    platform: 'ios',
    characters: {
      initialRenderCount: 6,
      renderBatchSize: 8,
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
    imagePlaza: {
      list: {
        initialRenderCount: 6,
        renderBatchSize: 8,
        renderMoreRootMargin: '220px',
        eagerImageCount: 2,
        highPriorityImageCount: 1,
      },
      feedImageWidths: IMAGE_PLAZA_FEED_WIDTHS,
      feedImageQuality: 66,
      studioImageWidths: IMAGE_PLAZA_STUDIO_WIDTHS,
      studioImageQuality: 72,
      videoActivationRootMargin: '240px',
    },
    homePoster: { width: 480, height: 640, quality: 64, videoPreload: 'metadata' },
    routePriority: ['home', 'dramas', 'characters', 'other'],
  },
  other: {
    platform: 'other',
    characters: {
      initialRenderCount: 6,
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
    imagePlaza: {
      list: {
        initialRenderCount: 6,
        renderBatchSize: 8,
        renderMoreRootMargin: '300px',
        eagerImageCount: 2,
        highPriorityImageCount: 1,
      },
      feedImageWidths: IMAGE_PLAZA_FEED_WIDTHS,
      feedImageQuality: 68,
      studioImageWidths: IMAGE_PLAZA_STUDIO_WIDTHS,
      studioImageQuality: 72,
      videoActivationRootMargin: '320px',
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
