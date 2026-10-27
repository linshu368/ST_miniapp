import { describe, expect, it } from 'vitest';
import type { VideoItem } from '@miniapp/shared';

import { resolveDramaSwipeDirection, resolveNextVideoId } from './drama-playback';

describe('resolveDramaSwipeDirection', () => {
  it('switches in opposite directions for upward and downward swipes', () => {
    expect(resolveDramaSwipeDirection(5, -100)).toBe(1);
    expect(resolveDramaSwipeDirection(5, 100)).toBe(-1);
  });

  it('ignores taps, short movements and predominantly horizontal drags', () => {
    expect(resolveDramaSwipeDirection(0, 0)).toBeNull();
    expect(resolveDramaSwipeDirection(0, 63)).toBeNull();
    expect(resolveDramaSwipeDirection(100, 100)).toBeNull();
    expect(resolveDramaSwipeDirection(-100, -100)).toBeNull();
  });
});

function video(id: string): VideoItem {
  return { id, title: '', tags: [], description: '', episode: null, playable: true };
}

describe('resolveNextVideoId', () => {
  const videos = [video('a'), video('b'), video('c')];

  it('returns the following video id', () => {
    expect(resolveNextVideoId(videos, 'a')).toBe('b');
    expect(resolveNextVideoId(videos, 'b')).toBe('c');
  });

  it('returns null after the last video', () => {
    expect(resolveNextVideoId(videos, 'c')).toBeNull();
  });

  it('returns null when current video is not in the list', () => {
    expect(resolveNextVideoId(videos, 'missing')).toBeNull();
  });

  it('returns null when there is no current video yet', () => {
    expect(resolveNextVideoId(videos, null)).toBeNull();
  });

  it('returns null for an empty video list', () => {
    expect(resolveNextVideoId([], 'a')).toBeNull();
  });
});
