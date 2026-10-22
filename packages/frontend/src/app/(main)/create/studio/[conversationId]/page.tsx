'use client';

import * as Sentry from '@sentry/nextjs';
import { feedbackAfterPaint, startAction } from '@/lib/perf/action-tracker';
import { getMetricDimensions } from '@/lib/perf/env-tags';
import {
  ArrowUp,
  ArrowLeft,
  Check,
  History,
  ImagePlus,
  LoaderCircle,
  Plus,
  Settings2,
  Share2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  useImagePlazaConversationsQuery,
  useImagePlazaQuoteMutation,
  useShareImagePlazaMutation,
  useSubmitImagePlazaAttemptMutation,
  useUploadImagePlazaReferenceMutation,
} from '@/lib/api/image-plaza';
import { StudioArtifactCard } from '@/components/image-plaza/studio-artifact-card';
import { StudioSettingsDialog } from '@/components/image-plaza/studio-settings-dialog';
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
  const conversations = useImagePlazaConversationsQuery();
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
  // 从点击生成到图片真正解码展示出来的耗时；只算最新这一次生成，图片 onLoad 消费后清掉。
  const genStartedAt = useRef<number | null>(null);
  const genReported = useRef(false);
  const reportArtifactVisible = () => {
    if (genReported.current || genStartedAt.current === null) return;
    genReported.current = true;
    try {
      Sentry.metrics.distribution(
        'image.display.duration',
        performance.now() - genStartedAt.current,
        {
          unit: 'millisecond',
          attributes: getMetricDimensions(),
        }
      );
    } catch {
      // 监控自身失败不能影响页面。
    }
  };
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [referenceStatus, setReferenceStatus] = useState<
    'idle' | 'reading' | 'uploading' | 'ready' | 'error'
  >('idle');
  const [prompt, setPrompt] = useState('');
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

  const data = conversation.data?.conversation;
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
    setPrompt(snapshot?.prompt ?? '');
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

  const generate = async (nextPrompt = prompt) => {
    if (
      !model ||
      !nextPrompt.trim() ||
      sending.current ||
      (localPreview && referenceStatus !== 'ready')
    )
      return;
    sending.current = true;
    // 反馈 = 提交被受理、界面进入生成中；真正出图是后台任务，耗时另由请求指标覆盖。
    const action = startAction('image_generate');
    genStartedAt.current = performance.now();
    genReported.current = false;
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
      setPrompt('');
      // Explicit submission restores following; polling itself never changes user intent.
      followLatestRef.current = true;
      scrollToLatest();
      feedbackAfterPaint(action);
    } catch (error) {
      // 提交阶段就失败了，不会再有图片加载，清掉起点避免被后面某张无关图片的 onLoad 冒领。
      genStartedAt.current = null;
      // 失败也算有了反馈（出现了错误提示），不该再算成「点了没反应」。
      action.feedback();
      showNotice(error instanceof Error ? error.message : '提交失败，请重试');
    } finally {
      sending.current = false;
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
            onClick={() => router.push('/create')}
            aria-label="返回广场"
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
            className="grid size-10 place-items-center rounded-full bg-card ring-1 ring-border disabled:opacity-60"
          >
            <Plus className="size-4" />
          </button>
          <details className="relative">
            <summary
              aria-label="创作历史"
              className="grid size-10 cursor-pointer list-none place-items-center rounded-full bg-card ring-1 ring-border"
            >
              <History className="size-4" />
            </summary>
            <div className="absolute right-0 top-12 z-40 max-h-72 w-72 overflow-auto rounded-2xl border border-border bg-card p-2 shadow-2xl">
              <p className="px-2 pb-2 text-xs font-black">创作历史</p>
              {conversations.data?.conversations.length ? (
                conversations.data.conversations.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => router.push(`/create/studio/${item.id}`)}
                    className={`block w-full rounded-xl px-2 py-2 text-left ${item.id === data.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-background'}`}
                  >
                    <span className="block truncate text-xs font-bold">{item.title}</span>
                    <span className="mt-1 block text-[10px]">
                      {new Date(item.updated_at).toLocaleString()}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-2 py-2 text-xs text-muted-foreground">还没有创作记录</p>
              )}
            </div>
          </details>
        </div>
      </header>

      <section
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
                      onRefresh={(value) => void generate(value)}
                      onShare={requestShare}
                      onNotice={showNotice}
                      sharingArtifactId={share.isPending && shareArtifact ? shareArtifact.id : null}
                      onArtifactVisible={
                        messageIndex === data.messages.length - 1
                          ? reportArtifactVisible
                          : undefined
                      }
                      rewardBadge={
                        rewardBadgeVisible && !config.data.has_completed_first_share ? rate : null
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

        <div className="rounded-[2rem] border border-border bg-card p-4 shadow-[0_-12px_50px_rgba(0,0,0,0.2)]">
          <textarea
            value={prompt}
            maxLength={IMAGE_PLAZA_PROMPT_MAX_CHARS}
            onChange={(event) =>
              setPrompt(event.target.value.slice(0, IMAGE_PLAZA_PROMPT_MAX_CHARS))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void generate();
              }
            }}
            rows={4}
            placeholder="描述你想生成的画面…"
            className="min-h-24 w-full resize-none bg-transparent text-base leading-7 outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-3 flex items-center gap-2.5">
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
              className="grid size-12 place-items-center rounded-2xl border border-border bg-background/45 text-muted-foreground disabled:opacity-60"
            >
              <Plus className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="打开生成设置"
              className="grid size-12 place-items-center rounded-2xl border border-border bg-background/45 text-muted-foreground"
            >
              <Settings2 className="size-5" />
            </button>
            <Sheet>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label={`选择模型，当前为 ${model.name}`}
                  className="grid size-12 shrink-0 place-items-center rounded-2xl border border-primary/35 bg-primary/5 text-primary"
                >
                  <Sparkles className="size-5" />
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
                <div className="min-h-0 space-y-1 overflow-y-auto overscroll-contain pt-2">
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
            <span className="ml-auto shrink-0 text-sm font-black text-muted-foreground">
              {quote.data ? `✦ ${quote.data.credits}` : quote.isPending ? '报价中' : '✦ --'}
            </span>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={
                !prompt.trim() ||
                submit.isPending ||
                quote.isPending ||
                Boolean(localPreview && referenceStatus !== 'ready')
              }
              aria-label="发送生成"
              className="grid size-14 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.22)] disabled:opacity-40"
            >
              {submit.isPending ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <ArrowUp className="size-6" />
              )}
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
  onArtifactVisible?: () => void;
}) {
  const attempt = props.attempt;
  if (attempt.status === 'pending' || attempt.status === 'generating')
    return (
      <div className="flex min-h-44 items-center justify-center rounded-[1.5rem] bg-card text-sm text-muted-foreground ring-1 ring-border">
        <LoaderCircle className="mr-2 size-5 animate-spin" />
        正在生成…
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
          onClick={() => props.onRefresh(props.prompt)}
          className="mt-3 rounded-full bg-primary px-4 py-2 text-xs font-black text-primary-foreground"
        >
          重新生成
        </button>
      </div>
    );
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {attempt.artifacts.map((artifact, index) => (
        <StudioArtifactCard
          key={artifact.id}
          artifact={artifact}
          prompt={props.prompt}
          rewardBadge={props.rewardBadge}
          sharing={props.sharingArtifactId === artifact.id}
          onRefresh={props.onRefresh}
          onShare={props.onShare}
          onNotice={props.onNotice}
          onLoad={index === 0 ? props.onArtifactVisible : undefined}
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
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background text-sm font-bold text-muted-foreground">
      {children}
    </main>
  );
}
