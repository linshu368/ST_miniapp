'use client';

import { Copy, Download, RefreshCcw, Share2 } from 'lucide-react';
import type { ImagePlazaArtifact } from '@miniapp/shared';

interface StudioArtifactCardProps {
  artifact: ImagePlazaArtifact;
  prompt: string;
  rewardBadge: string | null;
  onRefresh: (prompt: string) => void;
  onShare: (artifact: ImagePlazaArtifact) => void;
  onNotice: (message: string) => void;
}

export function StudioArtifactCard(props: StudioArtifactCardProps) {
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(props.prompt);
      props.onNotice('已复制提示词');
    } catch {
      props.onNotice('复制失败，请手动复制提示词');
    }
  };

  return (
    <article>
      <div className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[1.75rem] border border-border bg-[#151115] shadow-inner">
        <img
          src={props.artifact.image_url}
          alt="生成结果"
          className="max-h-full w-full object-contain"
        />
      </div>
      <div className="mt-3 flex justify-end gap-2.5">
        <ArtifactButton label="重新生成" onClick={() => props.onRefresh(props.prompt)}>
          <RefreshCcw />
        </ArtifactButton>
        <ArtifactButton label="复制提示词" onClick={() => void copyPrompt()}>
          <Copy />
        </ArtifactButton>
        <ArtifactButton
          label="下载图片"
          onClick={() => window.open(props.artifact.image_url, '_blank', 'noopener,noreferrer')}
        >
          <Download />
        </ArtifactButton>
        <div className="relative">
          <ArtifactButton label="分享作品" accent onClick={() => props.onShare(props.artifact)}>
            <Share2 />
          </ArtifactButton>
          {props.rewardBadge ? (
            <span className="pointer-events-none absolute -right-2 -top-2 rounded-full bg-[#f2d49d] px-2 py-0.5 text-[10px] font-black text-[#3b2918] shadow-[0_0_16px_rgba(242,212,157,0.45)]">
              返{props.rewardBadge}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ArtifactButton(props: {
  label: string;
  accent?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
      className={`grid size-12 place-items-center rounded-2xl border text-muted-foreground shadow-sm transition active:scale-95 [&_svg]:size-5 ${
        props.accent
          ? 'border-primary/50 bg-primary/5 text-primary'
          : 'border-border bg-card hover:text-foreground'
      }`}
    >
      {props.children}
    </button>
  );
}
