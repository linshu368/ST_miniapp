// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const warm = vi.hoisted(() => vi.fn());
vi.mock('@/lib/drama-stream-origin', () => ({ warmDramaStreamOrigin: warm }));
vi.mock('@/lib/api/connection-warmth', () => ({ warmApiConnection: vi.fn() }));
import { useDramaStreamWarmth } from './use-connection-warmth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let visibility: DocumentVisibilityState;

function Probe() {
  useDramaStreamWarmth();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  warm.mockClear();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('warms on mount and every 5s while the drama page is visible', () => {
  expect(warm).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(15_000);
  expect(warm).toHaveBeenCalledTimes(4);
});

it('does not warm a hidden page, and re-warms as soon as it becomes visible', () => {
  visibility = 'hidden';
  vi.advanceTimersByTime(10_000);
  expect(warm).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(warm).toHaveBeenCalledTimes(2);
});

it('stops the heartbeat after 5 minutes without activity, and resumes on a touch', () => {
  vi.advanceTimersByTime(5 * 60_000);
  const calls = warm.mock.calls.length;
  vi.advanceTimersByTime(30_000);
  expect(warm).toHaveBeenCalledTimes(calls);
  window.dispatchEvent(new Event('pointerdown'));
  expect(warm).toHaveBeenCalledTimes(calls + 1);
});

it('stops warming once the drama page unmounts', () => {
  act(() => root.unmount());
  root = createRoot(document.createElement('div'));
  vi.advanceTimersByTime(30_000);
  expect(warm).toHaveBeenCalledTimes(1);
});
