'use client';

import { ArrowLeft, Heart, LoaderCircle, RotateCcw, WandSparkles } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  useCreateImagePlazaConversationMutation,
  useImagePlazaWorkQuery,
  useSetImagePlazaLikeMutation,
} from '@/lib/api/image-plaza';

export default function ImagePlazaWorkPage() {
  const params = useParams<{ workId: string }>();
  const router = useRouter();
  const query = useImagePlazaWorkQuery(params.workId);
  const like = useSetImagePlazaLikeMutation(params.workId);
  const createConversation = useCreateImagePlazaConversationMutation();
  const [showReference, setShowReference] = useState(false);
  const work = query.data?.work;

  if (query.isLoading)
    return (
      <PageMessage>
        <LoaderCircle className="size-7 animate-spin" />
      </PageMessage>
    );
  if (!work || query.isError) return <PageMessage>作品不存在或已下架</PageMessage>;

  const imageUrl =
    showReference && work.reference_image_url ? work.reference_image_url : work.image_url;
  return (
    <main className="mx-auto min-h-screen w-full max-w-2xl bg-background pb-32 text-foreground">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border/60 bg-background/90 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="返回"
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
        <div className="overflow-hidden rounded-[1.75rem] bg-card ring-1 ring-border">
          <img
            src={imageUrl}
            alt={showReference ? `${work.title}参考图` : work.title}
            className="h-auto max-h-[72vh] w-full object-contain"
          />
        </div>
        {work.reference_image_url ? (
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
            {work.snapshot.prompt}
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
          disabled={like.isPending}
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
    </main>
  );
}

function PageMessage({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background text-sm font-bold text-muted-foreground">
      {children}
    </main>
  );
}
