import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetRequestConcurrencyForTests,
  getRequestConcurrencyStats,
  withRequestSlot,
} from './request-concurrency';

describe('withRequestSlot', () => {
  afterEach(() => {
    __resetRequestConcurrencyForTests(3);
  });

  it('caps concurrent short requests and wakes critical before background', async () => {
    __resetRequestConcurrencyForTests(1);

    let releaseHold!: () => void;
    const hold = withRequestSlot(
      'normal',
      undefined,
      () =>
        new Promise<string>((resolve) => {
          releaseHold = () => resolve('held');
        })
    );
    await Promise.resolve();
    expect(getRequestConcurrencyStats().inFlight).toBe(1);

    const order: string[] = [];
    const background = withRequestSlot('background', undefined, async () => {
      order.push('background');
      return 'bg';
    });
    const critical = withRequestSlot('critical', undefined, async () => {
      order.push('critical');
      return 'c';
    });
    await Promise.resolve();
    expect(getRequestConcurrencyStats().waiting).toBe(2);

    releaseHold();
    await hold;
    await expect(critical).resolves.toBe('c');
    await expect(background).resolves.toBe('bg');
    expect(order).toEqual(['critical', 'background']);
  });

  it('bypass does not take a slot', async () => {
    __resetRequestConcurrencyForTests(1);
    let releaseHold!: () => void;
    const hold = withRequestSlot(
      'normal',
      undefined,
      () =>
        new Promise<string>((resolve) => {
          releaseHold = () => resolve('held');
        })
    );
    await Promise.resolve();
    expect(getRequestConcurrencyStats().inFlight).toBe(1);

    const bypassed = await withRequestSlot('bypass', undefined, async () => 'ok');
    expect(bypassed).toBe('ok');
    expect(getRequestConcurrencyStats().inFlight).toBe(1);
    releaseHold();
    await hold;
  });

  it('aborts while waiting without occupying a slot', async () => {
    __resetRequestConcurrencyForTests(1);
    let releaseHold!: () => void;
    const hold = withRequestSlot(
      'normal',
      undefined,
      () =>
        new Promise<string>((resolve) => {
          releaseHold = () => resolve('held');
        })
    );
    await Promise.resolve();

    const controller = new AbortController();
    const waiting = withRequestSlot('normal', controller.signal, async () => 'should-not-run');
    await Promise.resolve();
    expect(getRequestConcurrencyStats().waiting).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(getRequestConcurrencyStats().waiting).toBe(0);
    expect(getRequestConcurrencyStats().inFlight).toBe(1);
    releaseHold();
    await hold;
  });
});
