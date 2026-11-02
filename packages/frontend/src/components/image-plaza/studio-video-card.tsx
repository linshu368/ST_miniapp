'use client';

import { Copy, Download, LoaderCircle, Play, RefreshCw, Share2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { VideoPlazaArtifact, VideoPlazaAttemptStatus } from '@miniapp/shared';
import { requestTelegramFileDownload } from '@/lib/telegram/hooks';
import { useMobilePerformancePolicy } from '@/lib/mobile-performance';
import { supabasePublicImageSrcSet, supabasePublicImageUrl } from '@/lib/supabase-image';

export function StudioVideoCard(props: {
  artifact: VideoPlazaArtifact;
  status: VideoPlazaAttemptStatus;
  prompt: string;
  sharing?: boolean;
  onEdit: () => void;
  onRegenerate: () => void;
  onShare: () => void;
  onNotice: (message: string) => void;
  onSettled?: (outcome: 'loaded' | 'error' | 'absent') => void;
  priority?: boolean;
}) {
  const performancePolicy = useMobilePerformancePolicy();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const settled = useRef(false);
  const [active, setActive] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [posterSettled, setPosterSettled] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const [useOriginalPoster, setUseOriginalPoster] = useState(false);
  const posterUrl = props.artifact.poster_url;
  const posterWidths = performancePolicy.imagePlaza.studioImageWidths;
  const posterMaxWidth = posterWidths[posterWidths.length - 1] ?? 720;
  const transformedPoster = posterUrl
    ? supabasePublicImageUrl(posterUrl, {
        width: posterMaxWidth,
        height: Math.round((posterMaxWidth * 9) / 16),
        quality: performancePolicy.imagePlaza.studioImageQuality,
      })
    : null;
  const posterSrcSet = posterUrl
    ? supabasePublicImageSrcSet(
        posterUrl,
        posterWidths,
        { width: 16, height: 9 },
        {
          quality: performancePolicy.imagePlaza.studioImageQuality,
        }
      )
    : undefined;
  const displayPoster = useOriginalPoster ? posterUrl : transformedPoster;

  const settle = (outcome: 'loaded' | 'error' | 'absent') => {
    if (settled.current) return;
    settled.current = true;
    props.onSettled?.(outcome);
  };

  useEffect(() => {
    settled.current = false;
    setActive(false);
    setMediaReady(false);
    setPosterSettled(false);
    setPosterFailed(false);
    setUseOriginalPoster(false);
    if (!posterUrl) settle('absent');
    // The artifact identity owns this lifecycle; callback changes must not reload media.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.artifact.id, posterUrl]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || active) return;
    if (typeof IntersectionObserver === 'undefined') {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setActive(true);
      },
      { rootMargin: performancePolicy.imagePlaza.videoActivationRootMargin }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, performancePolicy.imagePlaza.videoActivationRootMargin]);

  const activateAndPlay = () => {
    const node = videoRef.current;
    if (!node) return;
    if (!active) {
      // Bind synchronously inside the user gesture so iOS/Android WebView can honor play().
      node.src = props.artifact.video_url;
      node.load();
      setActive(true);
    }
    void node.play().catch(() => {
      // Native controls remain available when autoplay policy rejects the first play().
    });
  };

  const handlePosterError = () => {
    if (!posterUrl) return;
    if (!useOriginalPoster && transformedPoster !== posterUrl) {
      setUseOriginalPoster(true);
      return;
    }
    setPosterSettled(true);
    setPosterFailed(true);
    settle('error');
  };

  const download = async () => {
    try {
      const accepted = await requestTelegramFileDownload(
        props.artifact.video_url,
        `video-${props.artifact.id}.mp4`
      );
      if (!accepted) window.open(props.artifact.video_url, '_blank', 'noopener,noreferrer');
    } catch {
      props.onNotice('下载未完成，已为你打开原视频');
      window.open(props.artifact.video_url, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <article className="overflow-hidden rounded-3xl bg-card ring-1 ring-border">
      <div ref={containerRef} className="relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          src={active ? props.artifact.video_url : undefined}
          poster={displayPoster ?? undefined}
          controls={active}
          playsInline
          preload={active ? 'metadata' : 'none'}
          onLoadedMetadata={() => setMediaReady(true)}
          className="absolute inset-0 size-full object-contain"
        />
        {displayPoster && !posterFailed && (!mediaReady || !posterSettled) ? (
          <img
            src={displayPoster}
            srcSet={useOriginalPoster ? undefined : posterSrcSet}
            sizes="(max-width: 640px) calc(100vw - 24px), 50vw"
            alt="视频预览"
            width={1280}
            height={720}
            loading={props.priority ? 'eager' : 'lazy'}
            fetchPriority={props.priority ? 'high' : 'auto'}
            decoding="async"
            onLoad={() => {
              setPosterSettled(true);
              settle('loaded');
            }}
            onError={handlePosterError}
            className="pointer-events-none absolute inset-0 size-full object-cover"
          />
        ) : null}
        {!active ? (
          <button
            type="button"
            onClick={activateAndPlay}
            aria-label="播放视频"
            className="absolute inset-0 grid place-items-center bg-black/15 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          >
            <span className="grid size-14 place-items-center rounded-full bg-black/65 shadow-lg backdrop-blur-sm">
              <Play className="ml-0.5 size-6 fill-current" aria-hidden />
            </span>
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-5 gap-1 p-2 text-[11px]">
        {[
          { label: '编辑', icon: Copy, run: props.onEdit },
          { label: '重新生成', icon: RefreshCw, run: props.onRegenerate },
          {
            label: '复制',
            icon: Copy,
            run: () =>
              void navigator.clipboard
                .writeText(props.prompt)
                .then(() => props.onNotice('提示词已复制'))
                .catch(() => props.onNotice('复制失败，请手动复制提示词')),
          },
          { label: '下载', icon: Download, run: () => void download() },
          { label: '分享', icon: props.sharing ? LoaderCircle : Share2, run: props.onShare },
        ].map(({ label, icon: Icon, run }) => (
          <button
            key={label}
            type="button"
            onClick={run}
            disabled={props.sharing && label === '分享'}
            className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-xl hover:bg-background disabled:opacity-50"
          >
            <Icon className={`size-4 ${props.sharing && label === '分享' ? 'animate-spin' : ''}`} />
            {label}
          </button>
        ))}
      </div>
    </article>
  );
}
