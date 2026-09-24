'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Check, Download, Expand, Eye, ImageIcon, Loader2, Lock, RefreshCw, X } from 'lucide-react';
import type {
  CreateMessageImageRequest,
  GetImageConfigData,
  ImageGenerationTier,
  MessageImageState,
} from '@miniapp/shared';
import { MAX_IMAGE_PROMPT_CHARS } from '@miniapp/shared';
import {
  formatMediaAttemptBillingLabel,
  formatMediaBillingPreview,
} from '@/components/chat/media-billing-label';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  captureImageCustomPromptOpened,
  captureImageDescriptionFailed,
  captureImageDescriptionPresented,
  captureImageDescriptionRequested,
  captureImageEntrySelected,
  captureImageGenerationSubmitFailed,
  captureImageGenerationSubmitted,
  captureImagePreviewOpened,
  captureImageSaveCompleted,
  captureImageSaveFailed,
  captureImageSaveRequested,
  useImageStatusTelemetry,
  type ImageTelemetryContext,
} from '@/lib/image-generation/telemetry';
import { requestTelegramFileDownload } from '@/lib/telegram/hooks';
import {
  advancedImageEntry,
  billingFailureAction,
  MAIN_WALLET_NOTICE,
} from '@/lib/vip/presentation';

type PromptSource = CreateMessageImageRequest['prompt_source'];

export interface MessageImageUiState {
  image: MessageImageState | undefined;
  /** 最新回复可首次生成；已有图片记录的历史回复也可重试或重新生成。 */
  canGenerate: boolean;
  config: GetImageConfigData | undefined;
  billingRefreshing: boolean;
  billingError: boolean;
  describe: (tier: ImageGenerationTier) => Promise<{ draftId: string; prompt: string }>;
  create: (request: CreateMessageImageRequest) => Promise<void>;
  onRecharge: () => void;
  telemetry: ImageTelemetryContext;
}

export function ChatMessageImageFooter({
  image,
  children,
}: {
  image: MessageImageUiState | null;
  /** 将图片入口交给消息操作行渲染，同时由本组件保留 Sheet 状态。 */
  children?: (imageAction: ReactNode) => ReactNode;
}) {
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [saveError, setSaveError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [source, setSource] = useState<PromptSource>('generated');
  const [tier, setTier] = useState<ImageGenerationTier>('basic');
  const [stage, setStage] = useState<
    'idle' | 'describing' | 'confirming' | 'creating' | 'failed' | 'insufficient' | 'vip_required'
  >('idle');
  const [error, setError] = useState('');
  // 只让“本次从 Sheet 发起”的任务终态驱动 Sheet；否则打开已有 ready/failed 图片时，
  // 会被会话查询中的旧终态立刻关闭或覆盖，用户看不到重新写稿流程。
  const generationStartedRef = useRef(false);

  const latest = image?.image?.latest ?? null;
  const current = image?.image?.current ?? null;
  const ready = current?.status === 'ready' ? current : null;
  const busy = latest?.status === 'pending' || latest?.status === 'generating';
  const selectedTierConfig = image?.config?.tiers[tier] ?? image?.config?.tiers.basic;
  const failedAttempt =
    latest?.status === 'failed' || latest?.status === 'failed_unknown' ? latest : null;
  const priceLabel =
    failedAttempt && failedAttempt.tier === tier && (stage === 'failed' || stage === 'confirming')
      ? formatMediaAttemptBillingLabel(
          failedAttempt,
          image?.config?.tiers[failedAttempt.tier].next_billing.free_trial_limit,
          failedAttempt.tier !== 'advanced'
        )
      : formatMediaBillingPreview(
          selectedTierConfig?.next_billing,
          image?.billingRefreshing ?? true,
          image?.billingError ?? false,
          tier !== 'advanced'
        );
  const advancedEntry = advancedImageEntry(image?.config?.tiers.advanced);
  const maxChars = image?.config?.limits.max_prompt_chars ?? MAX_IMAGE_PROMPT_CHARS;
  const telemetry = image?.telemetry ?? null;

  useImageStatusTelemetry(telemetry, latest);

  const failureHint = useMemo(() => {
    const code = latest?.error_code;
    if (!code) return '';
    if (code === 'image_provider_timeout_unknown') {
      return (
        image?.config?.hints.failed_unknown ??
        '本次没有消耗星尘。可以直接重试，或者把描述改一改再试。'
      );
    }
    return (
      image?.config?.hints.generation_failed ??
      '本次没有消耗星尘。可以直接重试，或者把描述改一改再试。'
    );
  }, [
    image?.config?.hints.failed_unknown,
    image?.config?.hints.generation_failed,
    latest?.error_code,
  ]);

  useEffect(() => {
    if (!sheetOpen) return;
    if (busy && generationStartedRef.current) setStage('creating');
    if (latest?.status === 'ready' && generationStartedRef.current) {
      generationStartedRef.current = false;
      setSheetOpen(false);
    }
    if (
      generationStartedRef.current &&
      (latest?.status === 'failed' || latest?.status === 'failed_unknown')
    ) {
      generationStartedRef.current = false;
      setError(failureHint);
      setStage('failed');
    }
  }, [busy, failureHint, latest?.status, sheetOpen]);

  // 非最后一条消息没有图片能力，但仍须把同一操作行里的语音/重生成渲染出来。
  if (!image) return children ? children(null) : null;

  const openDefaultFlow = async (
    entrySource: 'default' | 'regenerate_ready' = 'default',
    nextTier: ImageGenerationTier = 'basic'
  ) => {
    if (telemetry) {
      captureImageEntrySelected({
        context: telemetry,
        entrySource,
        latestStatus: latest?.status,
        hasReadyImage: Boolean(ready),
      });
    }
    // config 尚在加载时不能误判为关闭；真正是否受理由后端继续做权威校验。
    if (image.config?.enabled === false) {
      setError('图片生成功能暂未开放');
      setStage('failed');
      setSheetOpen(true);
      return;
    }
    const nextTierConfig = image.config?.tiers[nextTier];
    if (nextTier === 'advanced') {
      const entry = advancedImageEntry(nextTierConfig);
      if (entry === 'hidden') return;
      if (entry === 'vip_locked') {
        setTier(nextTier);
        setError('高级图片需要有效 VIP。开通后仍按价格扣费。');
        setStage('vip_required');
        setSheetOpen(true);
        return;
      }
    }
    setTier(nextTier);
    generationStartedRef.current = false;
    setDraftId(null);
    setPrompt('');
    setSheetOpen(true);
    setError('');
    setStage('describing');
    const startedAt = Date.now();
    if (telemetry) captureImageDescriptionRequested(telemetry);
    try {
      const description = await image.describe(nextTier);
      setDraftId(description.draftId);
      setPrompt(description.prompt);
      setSource('generated');
      setStage('confirming');
      if (telemetry) {
        captureImageDescriptionPresented({
          context: telemetry,
          attemptId: description.draftId,
          promptChars: description.prompt.length,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '这次没有写出合适的画面描述');
      setStage('failed');
      if (telemetry) {
        captureImageDescriptionFailed({ context: telemetry, error: err, startedAt });
      }
    }
  };

  const openRetryFlow = () => {
    if (telemetry) {
      captureImageEntrySelected({
        context: telemetry,
        entrySource: 'retry',
        latestStatus: latest?.status,
        hasReadyImage: Boolean(ready),
      });
    }
    generationStartedRef.current = false;
    setDraftId(null);
    setTier(latest?.tier ?? 'basic');
    setPrompt(latest?.prompt_cn ?? '');
    setSource(latest?.prompt_source ?? 'custom');
    setError('');
    setStage('confirming');
    setSheetOpen(true);
  };

  const openCustomFlow = () => {
    if (telemetry) {
      captureImageCustomPromptOpened({ context: telemetry, entrySource: 'custom_edit' });
    }
    setSource('custom');
    setError('');
    setStage('confirming');
  };

  const saveImage = async () => {
    if (!ready?.image_url || saveState === 'saving') return;

    if (telemetry) captureImageSaveRequested({ context: telemetry, attempt: ready });
    setSaveState('saving');
    setSaveError('');
    const startedAt = Date.now();
    try {
      const pathname = new URL(ready.image_url).pathname;
      const extension = pathname.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase() ?? 'png';
      const requested = await requestTelegramFileDownload(
        ready.image_url,
        `mijing-image-${ready.id}.${extension}`
      );
      if (!requested) {
        setSaveState('failed');
        setSaveError('当前 Telegram 版本暂不支持文件下载，请升级后重试');
        if (telemetry) {
          captureImageSaveFailed({
            context: telemetry,
            attempt: ready,
            startedAt,
            failureKind: 'business',
          });
        }
        return;
      }
      setSaveState('saved');
      if (telemetry) captureImageSaveCompleted({ context: telemetry, attempt: ready, startedAt });
    } catch {
      setSaveState('failed');
      setSaveError('图片保存未完成，请重试');
      if (telemetry) captureImageSaveFailed({ context: telemetry, attempt: ready, startedAt });
    }
  };

  const submit = async () => {
    const value = prompt.trim();
    if (!value) {
      setError('描述不能为空');
      return;
    }
    if (value.length > maxChars) {
      setError(image.config?.hints.prompt_over_limit ?? `描述最多 ${maxChars} 字`);
      return;
    }
    setError('');
    generationStartedRef.current = true;
    setStage('creating');
    const startedAt = Date.now();
    if (telemetry) {
      captureImageGenerationSubmitted({
        context: telemetry,
        promptSource: source,
        promptChars: value.length,
      });
    }
    try {
      await image.create({
        ...(draftId ? { draft_id: draftId } : {}),
        prompt_cn: value,
        prompt_source: source,
        tier,
      });
      // 202 只表示任务已受理；Sheet 保持生成中，直到会话图片轮询拿到终态。
      setStage('creating');
    } catch (err) {
      generationStartedRef.current = false;
      const candidate = err as { code?: string; status?: number; message?: string };
      const action = billingFailureAction(candidate.code);
      if (telemetry) {
        captureImageGenerationSubmitFailed({
          context: telemetry,
          promptSource: source,
          promptChars: value.length,
          error: err,
          startedAt,
        });
      }
      if (action.type === 'vip') {
        setStage('vip_required');
        setError('高级图片需要有效 VIP。开通后仍按价格扣费。');
        return;
      }
      if (action.type === 'main_wallet') {
        setStage('failed');
        setError(MAIN_WALLET_NOTICE);
        return;
      }
      if (action.type === 'unavailable') {
        setStage('failed');
        setError('这个图片档位暂不可用');
        return;
      }
      if (candidate.status === 402 || action.type === 'recharge') {
        setStage('insufficient');
        setError('星尘余额不足，请先充值后再生成。');
        return;
      }
      setStage('failed');
      setError(candidate.message ?? '图片生成没能开始，请重试');
    }
  };

  const imageAction = busy ? (
    <span className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      正在出图
    </span>
  ) : image.canGenerate ? (
    <span className="flex items-center gap-1">
      <button
        type="button"
        onClick={() =>
          latest?.status === 'failed' || latest?.status === 'failed_unknown'
            ? openRetryFlow()
            : void openDefaultFlow('default', 'basic')
        }
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-secondary"
      >
        <Eye className="size-3.5" aria-hidden />
        {latest?.status === 'failed' || latest?.status === 'failed_unknown' ? '重试出图' : '看看TA'}
      </button>
      {image.config && advancedEntry !== 'hidden' ? (
        <button
          type="button"
          onClick={() => void openDefaultFlow('default', 'advanced')}
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-secondary"
        >
          {advancedEntry === 'vip_locked' ? (
            <Lock className="size-3.5" aria-hidden />
          ) : (
            <ImageIcon className="size-3.5" aria-hidden />
          )}
          高级图
        </button>
      ) : null}
    </span>
  ) : null;

  return (
    <div className="space-y-2">
      {children ? children(imageAction) : imageAction}

      {ready?.image_url ? (
        <button
          type="button"
          onClick={() => {
            setSaveState('idle');
            setSaveError('');
            if (telemetry) captureImagePreviewOpened({ context: telemetry, attempt: ready });
            setViewerOpen(true);
          }}
          className="group relative ml-2 block w-full max-w-[224px] overflow-hidden rounded-xl border border-border bg-card text-left"
        >
          <Image
            src={ready.image_url}
            alt={ready.prompt_cn}
            width={ready.width}
            height={ready.height}
            unoptimized
            className="aspect-[2/3] w-full object-cover"
            loading="lazy"
          />
          <span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
            <Expand className="size-4" aria-hidden />
          </span>
        </button>
      ) : null}

      {ready && image.canGenerate ? (
        <div className="ml-2 space-y-1.5 text-[11px]">
          <p className="text-muted-foreground">
            {formatMediaAttemptBillingLabel(
              ready,
              image.config?.tiers[ready.tier].next_billing.free_trial_limit,
              ready.tier !== 'advanced'
            )}
          </p>
          <button
            type="button"
            onClick={() => void openDefaultFlow('regenerate_ready', ready.tier)}
            className="flex items-center gap-1.5 text-primary"
          >
            <Eye className="size-3.5" aria-hidden />
            重新生成 ·{' '}
            {formatMediaBillingPreview(
              image.config?.tiers[ready.tier].next_billing,
              image.billingRefreshing,
              image.billingError,
              ready.tier !== 'advanced'
            )}
          </button>
          <p className="border-l border-border pl-2 text-muted-foreground">
            已按你确认的描述生成，再点一次「看看TA」可以换一张。
          </p>
        </div>
      ) : null}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          overlayClassName="bg-black/70 backdrop-blur-none"
          className="max-h-[86vh] rounded-t-3xl border-border bg-card px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-3"
        >
          <div className="mx-auto w-full max-w-md space-y-4">
            <div className="mx-auto h-1 w-9 rounded-full bg-muted-foreground/40" />

            {stage === 'describing' ? (
              <div className="flex items-center gap-3 px-1 py-2">
                <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                </span>
                <div>
                  <SheetTitle className="text-[16px] font-bold">正在看看 TA 此刻的样子</SheetTitle>
                  <SheetDescription className="mt-1">按刚才这段对话写一句画面描述</SheetDescription>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    这一步不消耗星尘，确认后才出图
                  </p>
                </div>
              </div>
            ) : stage === 'creating' ? (
              <div className="space-y-4">
                <div>
                  <SheetTitle className="text-[17px] font-bold">正在出图</SheetTitle>
                  <SheetDescription className="mt-1">
                    大约需要十几秒，可以先看别的，回来还在这里。
                  </SheetDescription>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-secondary">
                  <div className="h-full w-3/5 animate-pulse rounded-full bg-primary" />
                </div>
                <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
                  <span>生成完成后更新费用与额度</span>
                  <span>失败不消耗</span>
                </div>
                <button
                  type="button"
                  disabled
                  className="w-full rounded-xl bg-secondary px-4 py-3 text-sm font-semibold text-muted-foreground"
                >
                  生成中…
                </button>
              </div>
            ) : stage === 'vip_required' ? (
              <div className="space-y-3">
                <SheetTitle className="text-[18px] font-bold">高级图片需要 VIP</SheetTitle>
                <SheetDescription>{error}</SheetDescription>
                <button
                  type="button"
                  onClick={() => router.push('/vip')}
                  className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
                >
                  前往 VIP
                </button>
              </div>
            ) : stage === 'insufficient' ? (
              <div className="space-y-3">
                <span className="inline-flex rounded-full bg-primary/10 px-2 py-1 text-[11px] text-primary">
                  星尘不够
                </span>
                <SheetTitle className="text-[18px] font-bold">还差一点才能出图</SheetTitle>
                <SheetDescription>{error} 充值后会回到这段对话继续，不用重新找。</SheetDescription>
                <button
                  type="button"
                  onClick={image.onRecharge}
                  className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
                >
                  去充值
                </button>
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  className="w-full rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground"
                >
                  先不要了
                </button>
              </div>
            ) : stage === 'failed' ? (
              <div className="space-y-3">
                <span className="inline-flex rounded-full bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  这张没出来
                </span>
                <SheetTitle className="text-[18px] font-bold">生成没有成功</SheetTitle>
                <SheetDescription>
                  {error || '本次没有消耗星尘。可以直接重试，或者把描述改一改再试。'}
                </SheetDescription>
                <button
                  type="button"
                  onClick={() =>
                    prompt.trim() ? void submit() : void openDefaultFlow('default', tier)
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
                >
                  <RefreshCw className="size-4" aria-hidden />
                  重试{priceLabel ? ` · ${priceLabel}` : ''}
                </button>
                <button
                  type="button"
                  onClick={openCustomFlow}
                  className="w-full rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground"
                >
                  改一改描述
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <SheetTitle className="text-[17px] font-bold">
                    {source === 'generated' ? 'TA 此刻的样子' : '改成你想要的样子'}
                  </SheetTitle>
                  <SheetDescription className="mt-1">
                    {source === 'generated' ? '' : '写完直接出图，系统不会替换或补充你写的内容。'}
                  </SheetDescription>
                </div>
                {source === 'generated' ? (
                  <p className="min-h-[78px] rounded-xl border border-border bg-background/40 px-3 py-3 text-[14px] leading-relaxed text-foreground">
                    {prompt}
                  </p>
                ) : (
                  <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    maxLength={maxChars}
                    rows={5}
                    autoFocus
                    className="resize-none bg-background/40 text-[14px] leading-relaxed"
                  />
                )}
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{source === 'custom' ? `共 ${prompt.trim().length} 字` : ''}</span>
                  <span>上限 {maxChars} 字</span>
                </div>
                {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
                <button
                  type="button"
                  onClick={() => void submit()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
                >
                  {source === 'generated' ? (
                    <Check className="size-4" aria-hidden />
                  ) : (
                    <ImageIcon className="size-4" aria-hidden />
                  )}
                  {source === 'generated' ? '确认，生成图片' : '按我写的生成图片'}
                  {priceLabel ? ` · ${priceLabel}` : ''}
                </button>
                {source === 'generated' ? (
                  <button
                    type="button"
                    onClick={openCustomFlow}
                    className="w-full rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground"
                  >
                    我来改改
                  </button>
                ) : null}
                <p className="text-center text-[11px] text-muted-foreground">出图失败不消耗</p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent
          className="flex h-[100dvh] w-screen max-w-none flex-col items-center justify-center border-0 bg-background p-5 shadow-none"
          showCloseButton={false}
        >
          <DialogTitle className="absolute left-1/2 top-7 -translate-x-1/2 rounded-full bg-primary/15 px-3 py-1 text-[11px] text-primary">
            已生成
          </DialogTitle>
          <button
            type="button"
            onClick={() => setViewerOpen(false)}
            aria-label="关闭图片预览"
            className="absolute right-5 top-6 text-foreground"
          >
            <X className="size-5" aria-hidden />
          </button>
          {ready?.image_url ? (
            <Image
              src={ready.image_url}
              alt={ready.prompt_cn}
              width={ready.width}
              height={ready.height}
              unoptimized
              className="max-h-[72vh] w-auto max-w-full rounded-2xl object-contain"
            />
          ) : null}
          <div className="absolute bottom-8 flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => void saveImage()}
              disabled={saveState === 'saving'}
              className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {saveState === 'saving' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              {saveState === 'saving' ? '正在保存…' : saveState === 'saved' ? '已保存' : '保存图片'}
            </button>
            {saveError ? (
              <p className="max-w-[80vw] text-center text-[12px] leading-relaxed text-destructive">
                {saveError}
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
