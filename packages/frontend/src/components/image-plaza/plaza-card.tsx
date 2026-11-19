'use client';

import { useSetImagePlazaLikeMutation } from '@/lib/api/image-plaza';
import { supabasePublicImageSrcSet, supabasePublicImageUrl } from '@/lib/supabase-image';
import type { PlazaFeedItem } from '@miniapp/shared';
import { Copy, Heart, ImageIcon, LoaderCircle, Play } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

type PlazaCardProps = {
  work: PlazaFeedItem;
  eager: boolean;
  priority: boolean;
  imageWidths: readonly number[];
  imageQuality: number;
  useSamePending: boolean;
  interactionDisabled: boolean;
  onPreviewSettled: (id: string, outcome: 'loaded' | 'error' | 'absent') => void;
  onPrefetch: () => void;
  onOpen: () => void;
  onUseSame: () => void;
};

function plazaPreviewSource(props: PlazaCardProps) {
  const previewUrl =
    props.work.media_type === 'video' ? props.work.poster_url : props.work.image_url;
  const aspectRatio =
    props.work.width > 0 && props.work.height > 0
      ? `${props.work.width} / ${props.work.height}`
      : '2 / 3';
  const previewRatio = {
    width: props.work.width > 0 ? props.work.width : 2,
    height: props.work.height > 0 ? props.work.height : 3,
  };
  const maxWidth = props.imageWidths[props.imageWidths.length - 1] ?? 480;
  const transformedPreviewUrl = previewUrl
    ? supabasePublicImageUrl(previewUrl, {
        width: maxWidth,
        height: Math.round((maxWidth * previewRatio.height) / previewRatio.width),
        quality: props.imageQuality,
      })
    : null;
  const transformedPreviewSrcSet = previewUrl
    ? supabasePublicImageSrcSet(previewUrl, props.imageWidths, previewRatio, {
        quality: props.imageQuality,
      })
    : undefined;
  return { previewUrl, aspectRatio, transformedPreviewUrl, transformedPreviewSrcSet };
}

function usePlazaPreview(props: PlazaCardProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const { previewUrl, aspectRatio, transformedPreviewUrl, transformedPreviewSrcSet } =
    plazaPreviewSource(props);
  const [useOriginalPreview, setUseOriginalPreview] = useState(false);
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const previewSettled = useRef(false);
  const generation = useRef(0);
  const displayPreviewUrl = useOriginalPreview ? previewUrl : transformedPreviewUrl;

  const settledCallback = useRef(props.onPreviewSettled);
  settledCallback.current = props.onPreviewSettled;
  const settlePreview = useCallback(
    (outcome: 'loaded' | 'error' | 'absent') => {
      if (previewSettled.current) return;
      previewSettled.current = true;
      settledCallback.current(props.work.id, outcome);
    },
    [props.work.id]
  );
  const handlePreviewLoaded = useCallback(
    (node: HTMLImageElement) => {
      const owner = generation.current;
      void node
        .decode()
        .catch(() => undefined)
        .then(() => {
          if (owner !== generation.current || !node.isConnected) return;
          setImageState('loaded');
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (owner === generation.current && node.isConnected && !document.hidden)
                settlePreview('loaded');
            })
          );
        });
    },
    [settlePreview]
  );

  useEffect(() => {
    setUseOriginalPreview(false);
    setImageState('loading');
    previewSettled.current = false;
    const owner = ++generation.current;
    if (!previewUrl) {
      settlePreview('absent');
      return;
    }
    const node = imageRef.current;
    if (node?.complete && node.naturalWidth > 0) {
      handlePreviewLoaded(node);
    }
    return () => {
      generation.current = owner + 1;
    };
  }, [previewUrl, settlePreview, handlePreviewLoaded]);

  const handlePreviewError = () => {
    if (
      previewUrl &&
      !useOriginalPreview &&
      transformedPreviewUrl &&
      transformedPreviewUrl !== previewUrl
    ) {
      setUseOriginalPreview(true);
      setImageState('loading');
      return;
    }
    setImageState('error');
    settlePreview('error');
  };

  return {
    imageRef,
    aspectRatio,
    imageState,
    displayPreviewUrl,
    useOriginalPreview,
    transformedPreviewSrcSet,
    setImageState,
    settlePreview,
    handlePreviewError,
    handlePreviewLoaded,
  };
}

export function PlazaCard(props: PlazaCardProps) {
  const like = useSetImagePlazaLikeMutation(props.work.id);
  const {
    imageRef,
    aspectRatio,
    imageState,
    displayPreviewUrl,
    useOriginalPreview,
    transformedPreviewSrcSet,
    handlePreviewError,
    handlePreviewLoaded,
  } = usePlazaPreview(props);
  return (
    <article
      data-image-work-id={props.work.id}
      data-media-type={props.work.media_type}
      className="group relative overflow-hidden rounded-[1.5rem] bg-card ring-1 ring-border/70"
    >
      {like.isError ? (
        <p
          role="alert"
          className="absolute inset-x-0 top-0 z-10 bg-destructive p-2 text-xs text-destructive-foreground"
        >
          点赞未确认，请刷新后重试
        </p>
      ) : null}
      <Link
        href={`/create/work/${props.work.id}`}
        prefetch={false}
        aria-label={`查看作品：${props.work.title}`}
        onPointerEnter={props.onPrefetch}
        onFocus={props.onPrefetch}
        onTouchStart={props.onPrefetch}
        onClick={props.onOpen}
        className="block"
      >
        <div className="relative w-full overflow-hidden bg-muted/50" style={{ aspectRatio }}>
          {imageState === 'loading' ? (
            <div aria-hidden className="absolute inset-0 animate-pulse bg-muted" />
          ) : null}
          {displayPreviewUrl && imageState !== 'error' ? (
            <img
              ref={imageRef}
              src={displayPreviewUrl}
              srcSet={useOriginalPreview ? undefined : transformedPreviewSrcSet}
              sizes="(max-width: 768px) calc(50vw - 18px), 300px"
              alt={props.work.title}
              width={props.work.width}
              height={props.work.height}
              loading={props.eager ? 'eager' : 'lazy'}
              fetchPriority={props.priority ? 'high' : 'auto'}
              decoding="async"
              onLoad={(event) => handlePreviewLoaded(event.currentTarget)}
              onError={handlePreviewError}
              className={`absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.02] ${
                imageState === 'loaded' ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center bg-muted text-muted-foreground">
              {props.work.media_type === 'video' ? (
                <Play className="size-8" aria-hidden />
              ) : (
                <ImageIcon className="size-8" aria-hidden />
              )}
            </div>
          )}
          {props.work.media_type === 'video' ? (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/65 px-2 py-1 text-[10px] font-bold text-white">
              <Play className="size-3 fill-current" aria-hidden />
              {Math.ceil(props.work.duration_ms / 1000)}s
            </span>
          ) : null}
        </div>
      </Link>
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/90 via-black/35 to-transparent p-2 pt-16 text-white sm:p-3 sm:pt-16">
        <button
          type="button"
          disabled={like.isPending}
          onClick={() => like.mutate(!props.work.liked)}
          aria-label={
            props.work.liked ? `取消点赞：${props.work.title}` : `点赞：${props.work.title}`
          }
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-full text-xs font-black drop-shadow-md disabled:opacity-60"
        >
          <Heart className={`size-4 ${props.work.liked ? 'fill-current' : ''}`} />
          {props.work.like_count}
        </button>
        <button
          type="button"
          disabled={props.interactionDisabled}
          onClick={props.onUseSame}
          aria-label={`用同款：${props.work.title}`}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-xl border border-white/10 bg-black/45 px-2 text-[11px] font-black text-[#d8c1aa] shadow-lg backdrop-blur-md transition active:scale-95 sm:h-11 sm:gap-1.5 sm:px-3 sm:text-xs"
        >
          {props.useSamePending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Copy className="size-4" />
          )}
          {props.useSamePending ? '正在打开' : '用同款'}
        </button>
      </div>
    </article>
  );
}
