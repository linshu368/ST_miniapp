/*
 * @Author: whc 952987912@qq.com
 * @Date: 2026-11-04 09:34:09
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-11-04 09:34:36
 * @FilePath: \ST_miniapp\packages\frontend\src\lib\mobile-performance.test.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
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
    expect(android.routeWarmupOrder.slice(0, 2)).toEqual(['/characters', '/profile']);
    expect(ios.routeWarmupOrder.slice(0, 2)).toEqual(['/profile', '/characters']);
    expect(android.characters).toMatchObject({
      initialRenderCount: 4,
      renderBatchSize: 4,
      eagerImageCount: 1,
      highPriorityImageCount: 1,
    });
    expect(ios.characters).toMatchObject({
      initialRenderCount: 4,
      renderBatchSize: 6,
      eagerImageCount: 2,
      highPriorityImageCount: 1,
    });
    expect(getMobilePerformancePolicy('unknown').characters.initialRenderCount).toBe(4);
    expect(ios.dramas.initialRenderCount).toBeLessThanOrEqual(6);
  });

  it.each(['android', 'android_x', 'ios', 'unknown'])('keeps %s work bounded', (platform) => {
    const policy = getMobilePerformancePolicy(platform);
    for (const budget of [policy.characters, policy.dramas]) {
      expect(budget.initialRenderCount).toBeGreaterThan(0);
      expect(budget.renderBatchSize).toBeGreaterThan(0);
      expect(budget.eagerImageCount).toBeGreaterThanOrEqual(budget.highPriorityImageCount);
      expect(budget.highPriorityImageCount).toBe(1);
    }
  });
});
