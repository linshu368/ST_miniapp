'use client';

import { usePageReady } from '@/lib/perf/page-ready';
import { ArrowLeft, Heart, LoaderCircle, RotateCcw, WandSparkles } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useTelegramBackButton } from '@/lib/telegram';
import { ApiClientError } from '@/lib/api/client';
import {
  useCreateImagePlazaConversationMutation,
  useImagePlazaWorkQuery,
  useSetImagePlazaLikeMutation,
  useVideoPlazaPlaybackMutation,
} from '@/lib/api/image-plaza';

export default function ImagePlazaWorkPage() {
  const params = useParams<{ workId: string }>();
  return <ImagePlazaWorkDetail key={params.workId} workId={params.workId} />;
}

function ImagePlazaWorkDetail({ workId }: { workId: string }) {
  const router = useRouter();
  const returnToGallery = useCallback(() => router.push('/create', { scroll: false }), [router]);
  useTelegramBackButton(returnToGallery);
  const query = useImagePlazaWorkQuery(workId);
  usePageReady('/create/work/:id', query.data !== undefined);
  const like = useSetImagePlazaLikeMutation(workId);
  const createConversation = useCreateImagePlazaConversationMutation();
  const [showReference, setShowReference] = useState(false);
  const work = query.data?.work;
  const videoWork = work?.media_type === 'video' ? work : null;
  const playback = useVideoPlazaPlaybackMutation(videoWork?.attempt_id ?? '');
  const imageWork = work?.media_type === 'image' ? work : null;
  const [displayedImage, setDisplayedImage] = useState<string | null>(imageWork?.image_url ?? null);
  const [failedImage, setFailedImage] = useState(false);
  const [retryImage, setRetryImage] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoRefreshAttempted, setVideoRefreshAttempted] = useState(false);
  const imageUrl =
    showReference && imageWork?.reference_image_url
      ? imageWork.reference_image_url
      : imageWork?.image_url;

  useEffect(() => {
    if (!imageUrl) return;
    let active = true;
    const image = new Image();
    setFailedImage(false);
    image.onload = async () => {
      await image.decode().catch(() => undefined);
      if (active) setDisplayedImage(imageUrl);
    };
    image.onerror = () => {
      if (active) setFailedImage(true);
    };
    image.src = imageUrl;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [imageUrl, retryImage]);

  useEffect(() => {
    if (videoWork?.video_url) setVideoUrl(videoWork.video_url);
  }, [videoWork?.video_url]);

  if (query.isLoading)
    return (
      <PageMessage>
        <LoaderCircle className="size-7 animate-spin" />
      </PageMessage>
    );
  if (query.isError || !work)
    return (
      <PageMessage>
        <div className="space-y-3 text-center">
          <p>
            {query.error instanceof ApiClientError && query.error.status === 404
              ? '作品不存在或已下架'
              : query.error instanceof ApiClientError && [401, 403].includes(query.error.status)
                ? '暂无访问权限，请重新进入应用'
                : '作品加载失败，请重试'}
          </p>
          <button type="button" onClick={() => void query.refetch()} className="text-primary">
            重新加载
          </button>
        </div>
      </PageMessage>
    );
  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl bg-background pb-32 text-foreground">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border/60 bg-background/90 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <button
          type="button"
          onClick={returnToGallery}
          aria-label="返回影像广场"
          className="grid size-10 place-items-center rounded-full bg-card ring-1 ring-border"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-black">{work.title}</p>
          <p className="text-xs text-muted-foreground">{work.model_name}</p>
        </div>
      </header>

      <section className="p-3">
        <div
          className="relative mx-auto overflow-hidden rounded-[1.75rem] bg-card ring-1 ring-border"
          style={{ aspectRatio: `${work.width} / ${work.height}`, maxHeight: '72vh' }}
        >
          {work.media_type === 'video' ? (
            <video
              src={videoUrl ?? work.video_url}
              poster={work.poster_url ?? undefined}
              controls
              playsInline
              preload="metadata"
              onError={() => {
                if (videoRefreshAttempted || playback.isPending) return;
                setVideoRefreshAttempted(true);
                playback.mutate(undefined, {
                  onSuccess: (fresh) => setVideoUrl(fresh.video_url),
                });
              }}
              className="h-full w-full object-contain"
            />
          ) : (
            <img
              src={displayedImage ?? work.image_url}
              alt={showReference ? `${work.title}参考图` : work.title}
              width={work.width}
              height={work.height}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-contain"
            />
          )}
          {work.media_type === 'image' && displayedImage !== imageUrl && !failedImage ? (
            <span
              role="status"
              className="absolute bottom-3 left-3 rounded-full bg-black/60 px-3 py-1 text-xs text-white"
            >
              图片加载中…
            </span>
          ) : null}
        </div>
        {work.media_type === 'image' && failedImage ? (
          <button
            type="button"
            className="mt-3 text-xs text-primary"
            onClick={() => {
              setRetryImage((value) => value + 1);
              void query.refetch();
            }}
          >
            图片加载失败，点击重试
          </button>
        ) : null}
        {work.media_type === 'image' && work.reference_image_url ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={() => setShowReference((value) => !value)}
              className="inline-flex items-center gap-2 rounded-full bg-card px-4 py-2 text-xs font-bold ring-1 ring-border"
            >
              <RotateCcw className="size-3.5" />
              {showReference ? '查看作品图片' : '查看参考图'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="space-y-4 px-5 py-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary/70">Prompt</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/90">
            {work.snapshot.prompt_zh?.trim() || work.snapshot.prompt}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            work.model_name,
            work.snapshot.aspect_ratio,
            work.snapshot.resolution,
            ...work.tags,
          ].map((label) => (
            <span
              key={label}
              className="rounded-full bg-card px-3 py-1.5 text-[11px] font-bold text-muted-foreground ring-1 ring-border"
            >
              {label}
            </span>
          ))}
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-[calc(5.8rem+env(safe-area-inset-bottom))] z-30 mx-auto flex w-[calc(100%-1.5rem)] max-w-xl items-center gap-2 rounded-[1.35rem] border border-border bg-card/95 p-2 shadow-2xl backdrop-blur-xl">
        <button
          type="button"
          disabled={like.isPending || query.isPlaceholderData}
          onClick={() => like.mutate(!work.liked)}
          className={`grid size-12 shrink-0 place-items-center rounded-2xl ${work.liked ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground'}`}
          aria-label={work.liked ? '取消点赞' : '点赞'}
        >
          <Heart className={`size-5 ${work.liked ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          disabled={createConversation.isPending}
          onClick={() =>
            createConversation.mutate(
              { source_work_id: work.id },
              { onSuccess: ({ conversation }) => router.push(`/create/studio/${conversation.id}`) }
            )
          }
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-black text-primary-foreground disabled:opacity-60"
        >
          {createConversation.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <WandSparkles className="size-4" />
          )}
          用同款
        </button>
      </div>
      {like.isError || createConversation.isError ? (
        <p
          role="alert"
          className="fixed inset-x-4 bottom-48 z-40 rounded-xl bg-destructive p-3 text-center text-xs text-destructive-foreground"
        >
          {like.isError
            ? '点赞结果未确认，请刷新后重试'
            : '创建会话未确认，请先检查创作历史，避免重复创建'}
        </p>
      ) : null}
    </main>
  );
}

function PageMessage({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <main className="grid min-h-screen place-items-center bg-background text-sm font-bold text-muted-foreground">
      <div className="flex flex-col items-center px-5 text-center">
        {children}
        <button
          type="button"
          onClick={() => router.push('/create', { scroll: false })}
          className="mt-5 min-h-10 rounded-full border border-border px-4 text-xs text-foreground"
        >
          返回影像广场
        </button>
      </div>
    </main>
  );
}
