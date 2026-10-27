'use client';

import { Copy, Download, LoaderCircle, RefreshCw, Share2 } from 'lucide-react';
import type { VideoPlazaArtifact, VideoPlazaAttemptStatus } from '@miniapp/shared';
import { requestTelegramFileDownload } from '@/lib/telegram/hooks';

export function StudioVideoCard(props: {
  artifact: VideoPlazaArtifact;
  status: VideoPlazaAttemptStatus;
  prompt: string;
  sharing?: boolean;
  onEdit: () => void;
  onRegenerate: () => void;
  onShare: () => void;
  onNotice: (message: string) => void;
}) {
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
      <video
        src={props.artifact.video_url}
        poster={props.artifact.poster_url ?? undefined}
        controls
        playsInline
        preload="metadata"
        className="aspect-video w-full bg-black object-contain"
      />
      <div className="grid grid-cols-5 gap-1 p-2 text-[11px]">
        {[
          { label: '编辑', icon: Copy, run: props.onEdit },
          { label: '重生成', icon: RefreshCw, run: props.onRegenerate },
          {
            label: '复制',
            icon: Copy,
            run: () =>
              void navigator.clipboard
                .writeText(props.prompt)
                .then(() => props.onNotice('提示词已复制')),
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
