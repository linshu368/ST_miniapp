'use client';

import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  History,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCcw,
  Send,
  Settings2,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ImagePlazaArtifact,
  ImagePlazaAspectRatio,
  ImagePlazaMode,
  ImagePlazaModel,
} from '@miniapp/shared';
import {
  fileToImagePlazaPayload,
  useCreateImagePlazaConversationMutation,
  useImagePlazaConfigQuery,
  useImagePlazaConversationQuery,
  useImagePlazaConversationsQuery,
  useImagePlazaQuoteMutation,
  useShareImagePlazaMutation,
  useSubmitImagePlazaAttemptMutation,
  useUploadImagePlazaReferenceMutation,
} from '@/lib/api/image-plaza';

export default function ImagePlazaStudioPage() {
  const params = useParams<{ conversationId: string }>();
  const router = useRouter();
  const config = useImagePlazaConfigQuery();
  const conversation = useImagePlazaConversationQuery(params.conversationId);
  const conversations = useImagePlazaConversationsQuery();
  const createConversation = useCreateImagePlazaConversationMutation();
  const quote = useImagePlazaQuoteMutation();
  const submit = useSubmitImagePlazaAttemptMutation(params.conversationId);
  const upload = useUploadImagePlazaReferenceMutation();
  const share = useShareImagePlazaMutation();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('seedream-v5-pro');
  const [aspectRatio, setAspectRatio] = useState<ImagePlazaAspectRatio>('2:3');
  const [resolution, setResolution] = useState<'1K' | '2K' | 'fixed'>('1K');
  const [mode, setMode] = useState<ImagePlazaMode>('t2i');
  const [reference, setReference] = useState<ImagePlazaArtifact | null>(null);
  const [referenceArtifactId, setReferenceArtifactId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [notice, setNotice] = useState('');
  const [shareArtifact, setShareArtifact] = useState<ImagePlazaArtifact | null>(null);
  const [shareTipOpen, setShareTipOpen] = useState(false);
  const [rewardBadgeVisible, setRewardBadgeVisible] = useState(true);

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
    setModelId(next.id);
    setAspectRatio(
      next.aspect_ratios.includes(aspectRatio) ? aspectRatio : (next.aspect_ratios[0] ?? '1:1')
    );
    setResolution(
      next.resolutions.some((item) => item.id === resolution)
        ? resolution
        : (next.resolutions[0]?.id ?? 'fixed')
    );
    if (referenceArtifactId && !next.supports_i2i) {
      setReference(null);
      setReferenceArtifactId(null);
      setMode('t2i');
      showNotice('该模型不支持参考图，已改为文生图');
    }
  };

  const generate = async (nextPrompt = prompt) => {
    if (!model || !nextPrompt.trim() || submit.isPending) return;
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
        reasoning: false,
        auto_optimize: true,
        reference_artifact_id: referenceArtifactId,
        mode: actualMode,
        quote_id: freshQuote.quote_id,
        idempotency_key: crypto.randomUUID(),
      });
      setPrompt('');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '提交失败，请重试');
    }
  };

  const chooseReference = async (file?: File) => {
    if (!file || !model) return;
    if (!model.supports_i2i) {
      showNotice('当前模型不支持添加参考图');
      return;
    }
    try {
      const payload = await fileToImagePlazaPayload(file);
      const uploaded = await upload.mutateAsync(payload);
      setReference(uploaded.artifact);
      setReferenceArtifactId(uploaded.artifact.id);
      setMode('i2i');
    } catch (error) {
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
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col bg-background text-foreground">
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

      <section className="flex-1 space-y-5 px-3 py-5">
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
                <p className="max-w-[82%] rounded-[1.35rem] rounded-br-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground">
                  {message.content}
                </p>
              ) : message.attempt ? (
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
                  rewardBadge={
                    rewardBadgeVisible && !config.data.has_completed_first_share ? rate : null
                  }
                />
              ) : null}
            </div>
          ))
        )}
      </section>

      <div className="sticky bottom-0 z-20 border-t border-border/60 bg-background/95 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur-xl">
        {reference || referenceArtifactId ? (
          <div className="mb-2 flex items-center gap-2 rounded-2xl bg-card p-2 ring-1 ring-border">
            {reference ? (
              <img
                src={reference.image_url}
                alt="参考图"
                className="size-12 rounded-xl object-cover"
              />
            ) : (
              <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-xs font-bold text-primary">
                同款
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold">已添加参考图</p>
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
              onClick={() => {
                setReference(null);
                setReferenceArtifactId(null);
                setMode('t2i');
              }}
              aria-label="移除参考图"
              className="grid size-9 place-items-center rounded-full bg-background"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ) : null}

        <div className="rounded-[1.5rem] border border-border bg-card p-2 shadow-[0_-12px_50px_rgba(0,0,0,0.18)]">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value.slice(0, 600))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void generate();
              }
            }}
            rows={3}
            placeholder="描述你想生成的画面…"
            className="w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1.5">
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
              disabled={upload.isPending}
              aria-label="添加参考图"
              className="grid size-10 place-items-center rounded-xl bg-background text-muted-foreground ring-1 ring-border"
            >
              <ImagePlus className="size-4" />
            </button>
            <details className="relative">
              <summary className="flex h-10 cursor-pointer list-none items-center gap-1 rounded-xl bg-background px-3 text-xs font-bold ring-1 ring-border">
                <Settings2 className="size-3.5" />
                设置
              </summary>
              <div className="absolute bottom-12 left-0 z-40 w-72 rounded-2xl border border-border bg-card p-3 shadow-2xl">
                <SettingSelect
                  label="画幅"
                  value={aspectRatio}
                  values={model.aspect_ratios}
                  onChange={setAspectRatio}
                />
                <SettingSelect
                  label="分辨率"
                  value={resolution}
                  values={model.resolutions.map((item) => item.id)}
                  onChange={(value) => setResolution(value as typeof resolution)}
                />
              </div>
            </details>
            <details className="relative min-w-0">
              <summary className="flex h-10 max-w-32 cursor-pointer list-none items-center gap-1 truncate rounded-xl bg-background px-3 text-xs font-bold ring-1 ring-border">
                {model.name}
                <ChevronDown className="size-3" />
              </summary>
              <div className="absolute bottom-12 left-0 z-40 max-h-80 w-72 overflow-auto rounded-2xl border border-border bg-card p-2 shadow-2xl">
                {models.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectModel(item)}
                    className={`w-full rounded-xl p-3 text-left ${item.id === model.id ? 'bg-primary/10 text-primary' : 'hover:bg-background'}`}
                  >
                    <span className="flex items-center justify-between text-xs font-black">
                      {item.name}
                      {item.id === model.id ? <Check className="size-4" /> : null}
                    </span>
                    <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                      {item.description}
                    </span>
                  </button>
                ))}
              </div>
            </details>
            <span className="ml-auto shrink-0 text-[11px] font-bold text-primary">
              {quote.data ? `${quote.data.credits} 星尘` : quote.isPending ? '报价中' : '--'}
            </span>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={!prompt.trim() || submit.isPending || quote.isPending}
              aria-label="发送生成"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40"
            >
              {submit.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </button>
          </div>
          <div className="mt-1 px-2 text-right text-[10px] text-muted-foreground">
            {prompt.length}/600
          </div>
        </div>
      </div>

      {shareTipOpen && shareArtifact ? (
        <div
          className="fixed inset-0 z-50 grid place-items-end bg-black/65 p-3 sm:place-items-center"
          onClick={() => setShareTipOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="分享作品"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-[1.75rem] bg-card shadow-2xl"
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
            <div className="p-5 text-center">
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
  rewardBadge: string | null;
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
    <div className="grid gap-3 sm:grid-cols-2">
      {attempt.artifacts.map((artifact) => (
        <div
          key={artifact.id}
          className="overflow-hidden rounded-[1.5rem] bg-card ring-1 ring-border"
        >
          <img src={artifact.image_url} alt="生成结果" className="h-auto w-full object-cover" />
          <div className="grid grid-cols-4 p-2">
            <IconButton label="刷新" onClick={() => props.onRefresh(props.prompt)}>
              <RefreshCcw />
            </IconButton>
            <IconButton
              label="复制提示词"
              onClick={() => {
                void navigator.clipboard.writeText(props.prompt);
                props.onNotice('已复制');
              }}
            >
              <Copy />
            </IconButton>
            <IconButton
              label="下载"
              onClick={() => window.open(artifact.image_url, '_blank', 'noopener,noreferrer')}
            >
              <Download />
            </IconButton>
            <div className="relative">
              <IconButton label="分享" onClick={() => props.onShare(artifact)}>
                <Share2 />
              </IconButton>
              {props.rewardBadge ? (
                <span className="absolute -right-1 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-black text-primary-foreground">
                  返{props.rewardBadge}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function IconButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
      className="mx-auto grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground [&_svg]:size-4"
    >
      {props.children}
    </button>
  );
}
function SettingSelect<T extends string>(props: {
  label: string;
  value: T;
  values: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-2 text-[11px] font-bold text-muted-foreground">{props.label}</p>
      <div className="flex flex-wrap gap-2">
        {props.values.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => props.onChange(value)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold ${props.value === value ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  );
}
function StudioMessage({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background text-sm font-bold text-muted-foreground">
      {children}
    </main>
  );
}
