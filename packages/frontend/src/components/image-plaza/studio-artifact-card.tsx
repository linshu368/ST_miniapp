'use client';

import { Copy, Download, LoaderCircle, RefreshCcw, Share2, Video } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ImagePlazaArtifact } from '@miniapp/shared';
import { requestTelegramFileDownload } from '@/lib/telegram/hooks';

interface StudioArtifactCardProps {
  artifact: ImagePlazaArtifact;
  prompt: string;
  rewardBadge: string | null;
  sharing?: boolean;
  regenerating: boolean;
  regenerateDisabled: boolean;
  onRefresh: (prompt: string) => void;
  onShare: (artifact: ImagePlazaArtifact) => void;
  onUseAsVideoReference: (artifact: ImagePlazaArtifact) => void;
  creatingVideoReference: boolean;
  videoReferenceDisabled: boolean;
  onNotice: (message: string) => void;
  onLoad?: () => void;
}

export function StudioArtifactCard(props: StudioArtifactCardProps) {
  const sharing = props.sharing === true;
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);

  const saveImage = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFeedback('');
    setShowOriginal(false);
    try {
      const extension =
        new URL(props.artifact.image_url).pathname.match(/\.(png|jpe?g|webp)$/i)?.[1] ?? 'png';
      const requested = await requestTelegramFileDownload(
        props.artifact.image_url,
        `mijing-image-${props.artifact.id}.${extension}`
      );
      if (requested) {
        setSaveFeedback('已发起保存，请在客户端确认。');
      } else {
        setSaveFeedback('当前环境请打开原图后保存。');
        setShowOriginal(true);
      }
    } catch {
      setSaveFeedback('保存未能发起，请重试，或打开原图保存。');
      setShowOriginal(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

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
      <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[1.75rem] border border-border bg-[#151115] shadow-inner">
        <img
          src={props.artifact.image_url}
          alt="生成结果"
          width={props.artifact.width}
          height={props.artifact.height}
          loading="lazy"
          decoding="async"
          className={`max-h-full w-full object-contain transition ${sharing ? 'opacity-40' : ''}`}
          onLoad={props.onLoad}
        />
        {sharing ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="正在分享"
            className="absolute inset-0 grid place-items-center bg-black/35 backdrop-blur-[1px]"
          >
            <LoaderCircle className="size-9 animate-spin text-white drop-shadow" />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        disabled={props.regenerateDisabled}
        onClick={() => props.onRefresh(props.prompt)}
        className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-semibold text-muted-foreground disabled:opacity-50"
      >
        {props.regenerating ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <RefreshCcw className="size-4" aria-hidden />
        )}
        {props.regenerating ? '正在提交…' : '按当前设置再生成'}
      </button>
      <button
        type="button"
        disabled={props.videoReferenceDisabled}
        onClick={() => props.onUseAsVideoReference(props.artifact)}
        className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/5 px-3 text-xs font-semibold text-primary disabled:opacity-50"
      >
        {props.creatingVideoReference ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <Video className="size-4" aria-hidden />
        )}
        {props.creatingVideoReference ? '正在设置…' : '用这张图生成视频'}
      </button>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <ArtifactButton label="复制提示词" onClick={() => void copyPrompt()}>
          <Copy />
        </ArtifactButton>
        <ArtifactButton
          label={saving ? '正在保存' : '保存图片'}
          disabled={saving}
          onClick={() => void saveImage()}
        >
          {saving ? <LoaderCircle className="animate-spin" /> : <Download />}
        </ArtifactButton>
        <div className="relative">
          <ArtifactButton
            label="分享作品"
            accent
            disabled={sharing}
            onClick={() => props.onShare(props.artifact)}
          >
            {sharing ? <LoaderCircle className="animate-spin" /> : <Share2 />}
          </ArtifactButton>
          {props.rewardBadge ? (
            <span className="pointer-events-none absolute -right-2 -top-2 rounded-full bg-[#f2d49d] px-2 py-0.5 text-[10px] font-black text-[#3b2918] shadow-[0_0_16px_rgba(242,212,157,0.45)]">
              返{props.rewardBadge}
            </span>
          ) : null}
        </div>
      </div>
      {saveFeedback ? (
        <p role="status" className="mt-2 text-xs leading-5 text-muted-foreground">
          {saveFeedback}
          {showOriginal ? (
            <a
              href={props.artifact.image_url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 inline-flex min-h-10 items-center font-semibold text-primary underline underline-offset-2"
            >
              打开原图保存
            </a>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

function ArtifactButton(props: {
  label: string;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-[10px] text-muted-foreground shadow-sm transition active:scale-95 disabled:pointer-events-none disabled:opacity-60 [&_svg]:size-4 ${
        props.accent
          ? 'border-primary/50 bg-primary/5 text-primary'
          : 'border-border bg-card hover:text-foreground'
      }`}
    >
      {props.children}
      <span>{props.label}</span>
    </button>
  );
}
