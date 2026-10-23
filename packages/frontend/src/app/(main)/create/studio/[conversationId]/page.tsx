'use client';

import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ImagePlus,
  LoaderCircle,
  Plus,
  Settings2,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IMAGE_PLAZA_PROMPT_MAX_CHARS,
  type ImagePlazaArtifact,
  type ImagePlazaAspectRatio,
  type ImagePlazaMode,
  type ImagePlazaModel,
} from '@miniapp/shared';
import {
  fileToImagePlazaPayload,
  validateImagePlazaReference,
  useCreateImagePlazaConversationMutation,
  useImagePlazaConfigQuery,
  useImagePlazaConversationQuery,
  useImagePlazaQuoteMutation,
  useShareImagePlazaMutation,
  useSubmitImagePlazaAttemptMutation,
  useUploadImagePlazaReferenceMutation,
} from '@/lib/api/image-plaza';
import { StudioArtifactCard } from '@/components/image-plaza/studio-artifact-card';
import { StudioSettingsDialog } from '@/components/image-plaza/studio-settings-dialog';
import { ImagePlazaHistorySheet } from '@/components/image-plaza/image-plaza-history-sheet';
import { useMemoryDraft } from '@/hooks/use-memory-draft';
import { useTelegramBackButton } from '@/lib/telegram';
import { usePageReady } from '@/lib/perf/page-ready';
import { useVisualViewportHeight } from '@/lib/use-visual-viewport-height';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export default function ImagePlazaStudioPage() {
  const params = useParams<{ conversationId: string }>();
  // App Router may reuse the page when switching conversations; local uploads/settings must not survive.
  return <ImagePlazaStudio key={params.conversationId} conversationId={params.conversationId} />;
}

function ImagePlazaStudio({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const viewportHeight = useVisualViewportHeight();
  const config = useImagePlazaConfigQuery();
  const conversation = useImagePlazaConversationQuery(conversationId);
  const data = conversation.data?.conversation;
  usePageReady('/create/studio/:id', conversation.data !== undefined);
  const createConversation = useCreateImagePlazaConversationMutation();
  const quote = useImagePlazaQuoteMutation();
  const submit = useSubmitImagePlazaAttemptMutation(conversationId);
  const upload = useUploadImagePlazaReferenceMutation();
  const share = useShareImagePlazaMutation();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const scrollDimensions = useRef({ height: 0, content: 0 });
  const scrollFrame = useRef<number | null>(null);
  const uploadToken = useRef(0);
  const localUrl = useRef<string | null>(null);
  const referenceFile = useRef<File | null>(null);
  const sending = useRef(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [referenceStatus, setReferenceStatus] = useState<
    'idle' | 'reading' | 'uploading' | 'ready' | 'error'
  >('idle');
  const {
    value: prompt,
    setValue: setPrompt,
    clearIfUnchanged,
  } = useMemoryDraft(`image-plaza:${conversationId}`, data?.snapshot?.prompt ?? '');
  const [modelId, setModelId] = useState('seedream-v5-pro');
  const [aspectRatio, setAspectRatio] = useState<ImagePlazaAspectRatio>('2:3');
  const [resolution, setResolution] = useState<'1K' | '2K' | 'fixed'>('1K');
  const [mode, setMode] = useState<ImagePlazaMode>('t2i');
  const [reasoning, setReasoning] = useState(false);
  const [autoOptimize, setAutoOptimize] = useState(true);
  const [reference, setReference] = useState<ImagePlazaArtifact | null>(null);
  const [referenceArtifactId, setReferenceArtifactId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [notice, setNotice] = useState('');
  const [shareArtifact, setShareArtifact] = useState<ImagePlazaArtifact | null>(null);
  const [shareTipOpen, setShareTipOpen] = useState(false);
  const [rewardBadgeVisible, setRewardBadgeVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [submittingSource, setSubmittingSource] = useState<string | null>(null);
  const returnToGallery = useCallback(() => router.push('/create', { scroll: false }), [router]);
  useTelegramBackButton(returnToGallery);

  const models = useMemo(() => config.data?.models ?? [], [config.data?.models]);
  const model = models.find((item) => item.id === modelId) ?? models[0];
  useEffect(() => {
    if (initialized || !data || models.length === 0) return;
    const snapshot = data.snapshot;
    const target =
      models.find((item) => item.id === snapshot?.model_id) ??
      models.find((item) => item.id === 'seedream-v5-pro') ??
      models[0];
    if (!target) return;
    setModelId(target.id);
    setAspectRatio(
      snapshot && target.aspect_ratios.includes(snapshot.aspect_ratio)
        ? snapshot.aspect_ratio
        : (target.aspect_ratios[0] ?? '1:1')
    );
    setResolution(
      snapshot && target.resolutions.some((item) => item.id === snapshot.resolution)
        ? snapshot.resolution
        : (target.resolutions[0]?.id ?? 'fixed')
    );
    setReasoning(snapshot?.reasoning ?? false);
    setAutoOptimize(snapshot?.auto_optimize ?? true);
    const canKeepReference = Boolean(snapshot?.reference_artifact_id && target.supports_i2i);
    setReferenceArtifactId(canKeepReference ? (snapshot?.reference_artifact_id ?? null) : null);
    setMode(canKeepReference ? (snapshot?.mode ?? 'i2i') : 't2i');
    if (snapshot?.reference_artifact_id && !target.supports_i2i) {
      setNotice('原模型已不可用，当前模型不支持参考图，已改为文生图');
      window.setTimeout(() => setNotice(''), 3200);
    }
    setInitialized(true);
  }, [data, initialized, models]);

  useEffect(() => {
    if (!initialized || !model) return;
    const actualMode = referenceArtifactId ? mode : 't2i';
    quote.mutate({
      model_id: model.id,
      aspect_ratio: aspectRatio,
      resolution,
      mode: actualMode,
    });
    // The mutation result itself is intentionally excluded so a quote response never requests another quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, model?.id, aspectRatio, resolution, mode, referenceArtifactId]);

  const selectModel = (next: ImagePlazaModel) => {
    // A response started with another model must not silently restore its reference.
    if (next.id !== model?.id && localPreview) clearReference();
    setModelId(next.id);
    setAspectRatio(
      next.aspect_ratios.includes(aspectRatio) ? aspectRatio : (next.aspect_ratios[0] ?? '1:1')
    );
    setResolution(
      next.resolutions.some((item) => item.id === resolution)
        ? resolution
        : (next.resolutions[0]?.id ?? 'fixed')
    );
    if ((referenceArtifactId || localPreview) && !next.supports_i2i) {
      clearReference();
      showNotice('该模型不支持参考图，已改为文生图');
    }
    if (mode === 'edit' && !next.supports_edit) setMode(next.supports_i2i ? 'i2i' : 't2i');
  };

  const resetSettings = () => {
    if (!model) return;
    setAspectRatio(model.aspect_ratios.includes('2:3') ? '2:3' : (model.aspect_ratios[0] ?? '1:1'));
    setResolution(
      model.resolutions.some((item) => item.id === '1K')
        ? '1K'
        : (model.resolutions[0]?.id ?? 'fixed')
    );
    setReasoning(false);
    setAutoOptimize(true);
  };

  const scrollToLatest = () => {
    const node = scrollRef.current;
    if (node) {
      scrollDimensions.current = { height: node.clientHeight, content: node.scrollHeight };
      if (followLatestRef.current) node.scrollTop = node.scrollHeight;
    }
  };

  const generate = async (nextPrompt = prompt, source = 'composer') => {
    if (
      !model ||
      !nextPrompt.trim() ||
      sending.current ||
      (localPreview && referenceStatus !== 'ready')
    )
      return;
    sending.current = true;
    setSubmittingSource(source);
    const clearSubmittedDraft = clearIfUnchanged;
    // 反馈 = 提交被受理、界面进入生成中；真正出图是后台任务，耗时另由请求指标覆盖。
    const action = startAction('image_generate');
    try {
      const actualMode: ImagePlazaMode = referenceArtifactId ? mode : 't2i';
      const freshQuote = await quote.mutateAsync({
        model_id: model.id,
        aspect_ratio: aspectRatio as never,
        resolution,
        mode: actualMode,
      });
      await submit.mutateAsync({
        prompt: nextPrompt.trim(),
        model_id: model.id,
        aspect_ratio: aspectRatio as never,
        resolution,
        reasoning,
        auto_optimize: autoOptimize,
        reference_artifact_id: referenceArtifactId,
        mode: actualMode,
        quote_id: freshQuote.quote_id,
        idempotency_key: crypto.randomUUID(),
      });
      // A historical retry must never replace the separate draft being edited below.
      if (source === 'composer') clearSubmittedDraft(nextPrompt);
      // Explicit submission restores following; polling itself never changes user intent.
      followLatestRef.current = true;
      scrollToLatest();
      feedbackAfterPaint(action);
    } catch (error) {
      // 失败也算有了反馈（出现了错误提示），不该再算成「点了没反应」。
      action.feedback();
      showNotice(error instanceof Error ? error.message : '提交失败，请重试');
    } finally {
      sending.current = false;
      setSubmittingSource(null);
    }
  };

  useEffect(() => {
    const node = scrollRef.current;
    const content = messagesRef.current;
    if (!node || !content) return;
    const schedule = () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null;
        scrollToLatest();
      });
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    };
  }, [data?.id, config.isLoading, conversation.isLoading]);

  useEffect(
    () => () => {
      uploadToken.current += 1;
      if (localUrl.current) URL.revokeObjectURL(localUrl.current);
      referenceFile.current = null;
    },
    []
  );

  const clearReference = () => {
    uploadToken.current += 1;
    if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    localUrl.current = null;
    referenceFile.current = null;
    setLocalPreview(null);
    setReferenceStatus('idle');
    setReference(null);
    setReferenceArtifactId(null);
    setMode('t2i');
  };

  const chooseReference = async (file?: File) => {
    if (!file || !model) return;
    if (!model.supports_i2i) {
      showNotice('当前模型不支持添加参考图');
      return;
    }
    let token: number;
    try {
      validateImagePlazaReference(file);
      const preview = URL.createObjectURL(file);
      clearReference();
      token = ++uploadToken.current;
      localUrl.current = preview;
      referenceFile.current = file;
      setLocalPreview(preview);
      setReferenceStatus('reading');
      setMode('i2i');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '无法预览图片');
      return;
    }
    try {
      const payload = await fileToImagePlazaPayload(file);
      if (token !== uploadToken.current) return;
      setReferenceStatus('uploading');
      const uploaded = await upload.mutateAsync(payload);
      if (token !== uploadToken.current) return;
      setReference(uploaded.artifact);
      setReferenceArtifactId(uploaded.artifact.id);
      setReferenceStatus('ready');
      referenceFile.current = null;
    } catch (error) {
      if (token !== uploadToken.current) return;
      setReferenceStatus('error');
      showNotice(error instanceof Error ? error.message : '上传失败');
    }
  };

  const requestShare = (artifact: ImagePlazaArtifact) => {
    setRewardBadgeVisible(false);
    setShareArtifact(artifact);
    if (config.data?.share_tip.enabled && !config.data.has_completed_first_share)
      setShareTipOpen(true);
    else void confirmShare(artifact);
  };

  const confirmShare = async (artifact = shareArtifact) => {
    if (!artifact) return;
    try {
      const result = await share.mutateAsync({
        artifact_id: artifact.id,
        title: (data?.title ?? '我的图片作品').slice(0, 80),
        tags: [],
      });
      setShareTipOpen(false);
      showNotice(
        result.already_shared
          ? '作品已在广场'
          : result.reward_credits > 0
            ? `分享成功，返还 ${result.reward_credits} 星尘`
            : '分享成功'
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '分享失败');
    }
  };

  const showNotice = (value: string) => {
    setNotice(value);
    window.setTimeout(() => setNotice(''), 3200);
  };

  if (config.isLoading || conversation.isLoading)
    return (
      <StudioMessage>
        <LoaderCircle className="size-7 animate-spin" />
      </StudioMessage>
    );
  if ((!config.data && config.isError) || (!data && conversation.isError))
    return (
      <StudioMessage>
        <p>生成记录暂时无法读取。</p>
        <button
          type="button"
          disabled={config.isFetching || conversation.isFetching}
          onClick={() => {
            void config.refetch();
            void conversation.refetch();
          }}
          className="mt-3 min-h-10 rounded-full bg-card px-4 text-primary disabled:opacity-50"
        >
          {config.isFetching || conversation.isFetching ? '正在读取…' : '重新读取'}
        </button>
      </StudioMessage>
    );
  if (!config.data?.enabled || !data || !model)
    return <StudioMessage>图片创作暂不可用</StudioMessage>;

  const tip = config.data.share_tip;
  const rate = `${Math.round(config.data.share_rebate_rate * 100)}%`;
  const formatTip = (text: string) =>
    text.replaceAll('{rate}', rate).replaceAll('{model}', model.name);

  return (
    <main
      style={{ height: viewportHeight ?? '100dvh' }}
      className="mx-auto flex w-full max-w-3xl flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border/60 bg-background/90 px-3 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={returnToGallery}
            aria-label="返回影像广场"
            className="grid size-10 place-items-center rounded-full bg-card ring-1 ring-border"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-black">{data.title}</h1>
            <p className="truncate text-[11px] text-muted-foreground">
              {model.name} · {aspectRatio} · {resolution}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={createConversation.isPending}
            onClick={() =>
              createConversation.mutate(
                {},
                {
                  onSuccess: ({ conversation: created }) =>
                    router.push(`/create/studio/${created.id}`),
                }
              )
            }
            aria-label="新建创作"
            className="flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-xl bg-card px-2 text-[10px] font-semibold ring-1 ring-border disabled:opacity-60"
          >
            <Plus className="size-4" aria-hidden />
            新建
          </button>
          <ImagePlazaHistorySheet activeId={conversationId} compact />
        </div>
      </header>

      <section
        ref={scrollRef}
        className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const node = event.currentTarget;
          // Layout/keyboard changes are not user intent; the observer preserves the previous mode.
          if (
            scrollDimensions.current.height !== node.clientHeight ||
            scrollDimensions.current.content !== node.scrollHeight
          )
            return;
          followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 120;
        }}
      >
        <div ref={messagesRef} className="space-y-5 px-3 py-5">
          {conversation.isError ? (
            <div
              role="alert"
              className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 text-xs"
            >
              <p>生成状态暂未同步，已有记录仍保留。</p>
              <button
                type="button"
                disabled={conversation.isFetching}
                onClick={() => void conversation.refetch()}
                className="mt-2 min-h-10 rounded-full bg-card px-3 font-semibold text-primary disabled:opacity-50"
              >
                {conversation.isFetching ? '正在同步…' : '刷新状态'}
              </button>
            </div>
          ) : null}
          {data.messages.length === 0 ? (
            <div className="mx-auto mt-16 max-w-sm text-center">
              <div className="mx-auto grid size-16 place-items-center rounded-[1.5rem] bg-primary/10 text-primary">
                <ImagePlus className="size-7" />
              </div>
              <h2 className="mt-5 text-xl font-black">把灵感变成图片</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                描述画面、选择模型，也可以添加一张参考图。
              </p>
            </div>
          ) : (
            data.messages.map((message, messageIndex) => (
              <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : ''}>
                {message.role === 'user' ? (
                  <p className="max-w-[86%] rounded-[1.35rem] rounded-br-md border border-border bg-card px-4 py-3 text-sm leading-6 text-foreground shadow-sm">
                    {message.content}
                  </p>
                ) : message.attempt ? (
                  <div className="space-y-5">
                    <AttemptCard
                      prompt={
                        data.messages
                          .slice(0, messageIndex)
                          .reverse()
                          .find((item) => item.role === 'user')?.content ?? ''
                      }
                      attempt={message.attempt}
                      onRefresh={(value) => void generate(value, message.id)}
                      regenerating={submittingSource === message.id}
                      regenerateDisabled={
                        submittingSource !== null || quote.isPending || submit.isPending
                      }
                      onShare={requestShare}
                      onNotice={showNotice}
                      sharingArtifactId={share.isPending && shareArtifact ? shareArtifact.id : null}
                      rewardBadge={
                        rewardBadgeVisible &&
                        !config.data.has_completed_first_share &&
                        config.data.share_rebate_rate > 0
                          ? rate
                          : null
                      }
                    />
                    <div className="flex items-center gap-4 text-[11px] text-muted-foreground/70">
                      <span className="h-px flex-1 bg-border" />
                      <span>新一轮生成</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <div className="z-20 shrink-0 bg-background/95 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur-xl">
        {localPreview || reference || referenceArtifactId ? (
          <div className="mb-2 flex items-center gap-2 rounded-2xl bg-card p-2 ring-1 ring-border">
            {localPreview || reference ? (
              <img
                src={localPreview ?? reference?.image_url}
                alt="参考图"
                className="size-12 rounded-xl object-cover"
              />
            ) : (
              <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-xs font-bold text-primary">
                同款
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p role="status" className="text-xs font-bold">
                {referenceStatus === 'reading'
                  ? '读取中…'
                  : referenceStatus === 'uploading'
                    ? '上传中…'
                    : referenceStatus === 'error'
                      ? '上传失败，请重试或移除'
                      : '已添加参考图'}
              </p>
              {referenceStatus === 'error' ? (
                <button
                  type="button"
                  className="text-xs text-primary"
                  onClick={() => void chooseReference(referenceFile.current ?? undefined)}
                >
                  重试上传
                </button>
              ) : null}
              <div className="mt-1 flex gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={() => setMode('i2i')}
                  className={mode === 'i2i' ? 'text-primary' : 'text-muted-foreground'}
                >
                  参考生成
                </button>
                {model.supports_edit ? (
                  <button
                    type="button"
                    onClick={() => setMode('edit')}
                    className={mode === 'edit' ? 'text-primary' : 'text-muted-foreground'}
                  >
                    编辑图片
                  </button>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={clearReference}
              aria-label="移除参考图"
              className="grid size-9 place-items-center rounded-full bg-background"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ) : null}

        <div className="rounded-[2rem] border border-border bg-card p-3 shadow-[0_-12px_50px_rgba(0,0,0,0.2)] min-[360px]:p-4">
          <textarea
            value={prompt}
            maxLength={IMAGE_PLAZA_PROMPT_MAX_CHARS}
            onChange={(event) =>
              setPrompt(event.target.value.slice(0, IMAGE_PLAZA_PROMPT_MAX_CHARS))
            }
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void generate();
              }
            }}
            rows={4}
            placeholder="描述你想生成的画面…"
            className="min-h-24 w-full resize-none bg-transparent text-base leading-7 outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-3 flex items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                void chooseReference(event.target.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={!model.supports_i2i}
              aria-label="添加参考图"
              title={model.supports_i2i ? '添加参考图' : '当前模型不支持参考图'}
              className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <ImagePlus className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="打开生成设置"
              title="生成设置"
              className="grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Settings2 className="size-5" aria-hidden />
            </button>
            <Sheet>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label={`选择模型，当前为 ${model.name}`}
                  title={model.name}
                  className="flex min-h-11 min-w-11 max-w-56 flex-1 items-center justify-center gap-0.5 rounded-full bg-background/45 px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 truncate">{model.name}</span>
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </SheetTrigger>
              <SheetContent
                side="bottom"
                overlayClassName="bg-black/80 backdrop-blur-none motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
                className="mx-auto flex max-h-[76dvh] w-full max-w-3xl flex-col gap-0 overflow-hidden rounded-t-[1.25rem] border-border bg-card p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-[0_-18px_42px_rgba(0,0,0,0.3)] motion-reduce:transition-none motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none"
              >
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-left">
                  <SheetTitle className="flex-1 text-base font-extrabold leading-none tracking-tight">
                    选择模型
                  </SheetTitle>
                  <SheetClose
                    type="button"
                    aria-label="关闭模型选择"
                    className="grid size-9 place-items-center rounded-lg text-muted-foreground transition active:bg-background"
                  >
                    <X className="size-5" />
                  </SheetClose>
                </div>
                <SheetDescription className="sr-only">
                  当前模型为 {model.name}，选择后自动关闭。
                </SheetDescription>
                <div className="chat-scroll-area min-h-0 space-y-1 overflow-y-auto overscroll-contain pt-2">
                  {models.map((item) => (
                    <SheetClose key={item.id} asChild>
                      <button
                        type="button"
                        aria-pressed={item.id === model.id}
                        onClick={() => selectModel(item)}
                        className={`w-full rounded-xl p-3 text-left ${item.id === model.id ? 'bg-primary/10 text-primary' : 'hover:bg-background'}`}
                      >
                        <span className="flex items-center justify-between gap-2 text-sm font-black">
                          <span className="min-w-0 break-words">{item.name}</span>
                          {item.id === model.id ? <Check className="size-4 shrink-0" /> : null}
                        </span>
                        <span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">
                          {item.description}
                        </span>
                      </button>
                    </SheetClose>
                  ))}
                </div>
              </SheetContent>
            </Sheet>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={
                !prompt.trim() ||
                submittingSource !== null ||
                submit.isPending ||
                quote.isPending ||
                Boolean(localPreview && referenceStatus !== 'ready')
              }
              aria-label="发送生成"
              aria-describedby="image-generation-quote"
              className="ml-auto inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-2.5 text-sm font-semibold text-primary-foreground shadow-[0_5px_16px_hsl(var(--primary)/0.15)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:opacity-40 min-[360px]:px-3"
            >
              {submittingSource !== null ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : null}
              <span className="whitespace-nowrap">
                {submittingSource !== null ? '提交中' : '生成'}
              </span>
              <span
                id="image-generation-quote"
                className="whitespace-nowrap text-xs font-medium tabular-nums opacity-75"
              >
                {quote.isPending ? '报价中' : quote.data ? `✦ ${quote.data.credits}` : '✦ --'}
              </span>
            </button>
          </div>
        </div>
      </div>

      <StudioSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        model={model}
        aspectRatio={aspectRatio}
        onAspectRatioChange={setAspectRatio}
        resolution={resolution}
        onResolutionChange={setResolution}
        reasoning={reasoning}
        onReasoningChange={setReasoning}
        autoOptimize={autoOptimize}
        onAutoOptimizeChange={setAutoOptimize}
        onReset={resetSettings}
      />

      {shareTipOpen && shareArtifact ? (
        <div
          className="fixed inset-0 z-50 grid place-items-end bg-black/65"
          onClick={() => setShareTipOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="分享作品"
            onClick={(event) => event.stopPropagation()}
            className="mx-auto w-full max-w-3xl overflow-hidden rounded-t-[1.75rem] bg-card shadow-[0_-18px_42px_rgba(0,0,0,0.3)]"
          >
            <div className="relative aspect-[4/3] bg-black">
              <img
                src={shareArtifact.image_url}
                alt="待分享作品"
                className="size-full object-contain"
              />
              <button
                type="button"
                onClick={() => setShareTipOpen(false)}
                aria-label="关闭"
                className="absolute right-3 top-3 grid size-9 place-items-center rounded-full bg-black/50 text-white"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="p-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] text-center">
              <h2 className="text-lg font-black">{formatTip(tip.title)}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {formatTip(tip.description)}
              </p>
              {referenceArtifactId && tip.reference_note ? (
                <p className="mt-2 text-xs text-primary/80">{formatTip(tip.reference_note)}</p>
              ) : null}
              <button
                type="button"
                onClick={() => void confirmShare()}
                disabled={share.isPending}
                className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-sm font-black text-primary-foreground disabled:opacity-60"
              >
                {share.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Share2 className="size-4" />
                )}
                {tip.button_label}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p
          role="status"
          className="fixed bottom-28 left-1/2 z-[60] w-max max-w-[90vw] -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-center text-xs font-bold text-background shadow-xl"
        >
          {notice}
        </p>
      ) : null}
    </main>
  );
}

function AttemptCard(props: {
  prompt: string;
  attempt: NonNullable<
    NonNullable<
      ReturnType<typeof useImagePlazaConversationQuery>['data']
    >['conversation']['messages'][number]['attempt']
  >;
  onRefresh: (prompt: string) => void;
  onShare: (artifact: ImagePlazaArtifact) => void;
  onNotice: (message: string) => void;
  sharingArtifactId: string | null;
  rewardBadge: string | null;
  regenerating: boolean;
  regenerateDisabled: boolean;
}) {
  const attempt = props.attempt;
  if (attempt.status === 'pending' || attempt.status === 'generating')
    return (
      <div className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-[1.5rem] bg-card px-4 text-center text-sm text-muted-foreground ring-1 ring-border">
        <p className="flex items-center gap-2">
          <LoaderCircle className="size-5 animate-spin" aria-hidden />
          正在生成…
        </p>
        <p className="text-xs leading-5">可返回广场，稍后从“我的生成”查看结果。</p>
      </div>
    );
  if (attempt.status === 'failed' || attempt.status === 'failed_unknown')
    return (
      <div className="rounded-[1.5rem] bg-card p-5 ring-1 ring-border">
        <p className="text-sm font-bold">
          {attempt.status === 'failed_unknown'
            ? '结果暂时未知，未扣除星尘'
            : '生成失败，未消耗星尘'}
        </p>
        {attempt.error_code ? (
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
            {attemptFailureMessage(attempt.error_code)}
          </p>
        ) : null}
        <button
          type="button"
          disabled={props.regenerateDisabled}
          onClick={() => props.onRefresh(props.prompt)}
          className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-black text-primary-foreground disabled:opacity-50"
        >
          {props.regenerating ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          {props.regenerating ? '正在提交…' : '按当前设置再生成'}
        </button>
      </div>
    );
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {attempt.artifacts.map((artifact) => (
        <StudioArtifactCard
          key={artifact.id}
          artifact={artifact}
          prompt={props.prompt}
          rewardBadge={props.rewardBadge}
          sharing={props.sharingArtifactId === artifact.id}
          regenerating={props.regenerating}
          regenerateDisabled={props.regenerateDisabled}
          onRefresh={props.onRefresh}
          onShare={props.onShare}
          onNotice={props.onNotice}
        />
      ))}
    </div>
  );
}

function attemptFailureMessage(errorCode: string): string {
  if (
    errorCode === 'image_plaza_provider_not_configured' ||
    errorCode === 'image_plaza_provider_unavailable'
  ) {
    return '图片生成服务尚未配置，请稍后再试';
  }
  if (errorCode.startsWith('image_plaza_provider_http_')) {
    return '图片服务暂未接受本次生成，请调整后重试';
  }
  if (errorCode.includes('reference')) return '参考图当前不可用，请重新添加后再试';
  return '图片服务未完成本次生成，请稍后重试';
}

function StudioMessage({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background text-sm font-bold text-muted-foreground">
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
