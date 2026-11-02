import { describe, expect, it } from 'vitest';

import { getMobilePerformancePolicy, mobilePlatformGroup } from './mobile-performance';

describe('mobile performance policy', () => {
  it('groups Android variants together and safely falls back for unsupported clients', () => {
    expect(mobilePlatformGroup('android')).toBe('android');
    expect(mobilePlatformGroup('android_x')).toBe('android');
    expect(mobilePlatformGroup('ios')).toBe('ios');
    expect(mobilePlatformGroup('web')).toBe('other');
    expect(mobilePlatformGroup('PRIVATE_DEVICE')).toBe('other');
  });

  it('prioritizes the routes and list budgets observed slow on each platform', () => {
    const android = getMobilePerformancePolicy('android');
    const ios = getMobilePerformancePolicy('ios');

    expect(android.routePriority.slice(0, 2)).toEqual(['characters', 'home']);
    expect(ios.routePriority.slice(0, 2)).toEqual(['home', 'dramas']);
    expect(android.characters.initialRenderCount).toBeLessThanOrEqual(6);
    expect(ios.dramas.initialRenderCount).toBeLessThanOrEqual(6);
    expect(android.imagePlaza.list.initialRenderCount).toBeLessThanOrEqual(6);
    expect(ios.imagePlaza.list.initialRenderCount).toBeLessThanOrEqual(6);
    expect(android.imagePlaza.videoActivationRootMargin).not.toBe(
      ios.imagePlaza.videoActivationRootMargin
    );
  });

  it.each(['android', 'android_x', 'ios', 'unknown'])('keeps %s work bounded', (platform) => {
    const policy = getMobilePerformancePolicy(platform);
    for (const budget of [policy.characters, policy.dramas, policy.imagePlaza.list]) {
      expect(budget.initialRenderCount).toBeGreaterThan(0);
      expect(budget.renderBatchSize).toBeGreaterThan(0);
      expect(budget.eagerImageCount).toBeGreaterThanOrEqual(budget.highPriorityImageCount);
      expect(budget.highPriorityImageCount).toBe(1);
    }
    expect(policy.imagePlaza.feedImageWidths).toEqual([240, 360, 480]);
    expect(policy.imagePlaza.studioImageWidths).toEqual([320, 480, 720]);
    expect(policy.imagePlaza.videoActivationRootMargin).toMatch(/^\d+px$/);
  });
});
