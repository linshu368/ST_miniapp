import type { DramaPlayback } from '@miniapp/shared';

const owners = new WeakMap<HTMLVideoElement, string>();

export function ownsDramaSource(video: HTMLVideoElement, source: string): boolean {
  return (video.currentSrc || video.src) === source || owners.get(video) === source;
}

/** The cleanup invalidates pending imports before touching the shared video element. */
export function loadDramaSource(
  video: HTMLVideoElement,
  playback: DramaPlayback,
  ready: () => void,
  failed: () => void
) {
  const source = playback.play_url!;
  let disposed = false;
  let destroy: (() => void) | undefined;
  owners.set(video, source);
  if (playback.format !== 'hls' || video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = source;
    ready();
  } else {
    void import('hls.js')
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          failed();
          return;
        }
        const hls = new Hls({ manifestLoadingTimeOut: 10000, fragLoadingTimeOut: 15000 });
        destroy = () => hls.destroy();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && !disposed) failed();
        });
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          if (disposed) return;
          hls.loadSource(source);
          ready();
        });
        hls.attachMedia(video);
      })
      .catch(() => {
        if (!disposed) failed();
      });
  }
  return () => {
    disposed = true;
    if (owners.get(video) === source) owners.delete(video);
    destroy?.();
  };
}
