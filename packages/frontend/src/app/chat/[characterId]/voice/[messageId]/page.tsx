'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { MAX_CUSTOM_VOICE_CHARS } from '@miniapp/shared';

import { Button } from '@/components/ui/button';
import {
  toVoiceMap,
  useGenerateVoiceMutation,
  useSessionVoiceQuery,
  useVoiceConfigQuery,
} from '@/lib/api/voice';
import { chatEntryPath } from '@/lib/chat-entry';
import { useTelegramBackButton } from '@/lib/telegram';

/**
 * 自定义本次语音。
 *
 * 独立路由而不是聊天页里的抽屉二级页：这是一屏输入 + 一个提交动作，
 * 抽屉里塞输入框在移动端会和键盘抢空间。返回沿用 returnTo，回去还是原来那段会话。
 *
 * 只改「这一条语音说什么」。角色原回复、聊天记录、其他语音都不动——
 * 页面上把这句话写出来，否则用户不敢点。
 */
export default function CustomVoicePage() {
  const router = useRouter();
  const params = useParams<{ characterId: string; messageId: string }>();
  const searchParams = useSearchParams();

  const characterId = params.characterId;
  const messageId = params.messageId;
  const sessionId = searchParams.get('session');
  // returnTo 缺失或不是站内相对路径时回落到会话入口，不拿它当跳转目标
  const returnTo = searchParams.get('returnTo');
  const backTo =
    returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')
      ? returnTo
      : chatEntryPath(characterId, { sessionId: sessionId ?? undefined });

  const goBack = useCallback(() => router.replace(backTo), [router, backTo]);
  useTelegramBackButton(goBack);

  const sessionVoice = useSessionVoiceQuery(sessionId ?? undefined);
  const generateVoice = useGenerateVoiceMutation(sessionId ?? undefined);
  const voiceConfig = useVoiceConfigQuery();
  const priceLabel = voiceConfig.data?.billing?.enabled
    ? voiceConfig.data?.billing?.price_label
    : '';
  const maxChars = Math.min(
    voiceConfig.data?.limits?.max_spoken_chars ?? MAX_CUSTOM_VOICE_CHARS,
    MAX_CUSTOM_VOICE_CHARS
  );
  const returnToForRecharge = backTo;

  const currentText = useMemo(
    () => toVoiceMap(sessionVoice.data).get(messageId)?.spoken_text ?? '',
    [sessionVoice.data, messageId]
  );

  // null = 还没编辑过，用服务端带来的当前台词。不用 useEffect 灌初值：
  // 那样在台词到手的那一刻会覆盖用户已经敲进去的字
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? currentText;
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const acceptedTextRef = useRef('');
  const compositionRef = useRef<{
    text: string;
    selectionStart: number;
    selectionEnd: number;
  } | null>(null);
  const rejectedCompositionRef = useRef<typeof compositionRef.current>(null);
  const rejectedCompositionTimerRef = useRef<number | null>(null);

  const showOverLimitError = () => {
    setError(`自定义语音文字不能超过${maxChars}字`);
  };

  const submit = () => {
    const custom = (textareaRef.current?.value ?? text).trim();
    if (!custom) {
      setError('请先填写要生成语音的文字');
      return;
    }
    setError(null);
    generateVoice.mutate(
      { messageId, customText: custom },
      {
        // 受理成功就回聊天页：接下来是几十秒的后台生成，留在这里只能干等
        onSuccess: goBack,
        onError: (mutationError) => {
          const code = (mutationError as { code?: string }).code;
          if (code === 'insufficient_balance') {
            // 402 跳充值页，复用对话链路。金额由 apiClient 从 402 裸形状带出。
            const balance = (mutationError as { balance?: { creditsRequired: number } }).balance;
            const search = new URLSearchParams({
              reason: 'insufficient_credits',
              returnTo: returnToForRecharge,
            });
            if (balance) search.set('required', String(balance.creditsRequired));
            router.push(`/profile/recharge?${search.toString()}`);
            return;
          }
          setError(
            code === 'CONFLICT'
              ? '这条回复正在生成语音，请稍后再试'
              : code === 'VOICE_UNAVAILABLE'
                ? '语音功能暂不可用'
                : (mutationError as Error).message || '语音生成没能开始，请重试'
          );
        },
      }
    );
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/80 px-3 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] backdrop-blur-xl">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <h1 className="text-base font-bold tracking-wide">自定义本次语音</h1>
      </header>

      <section className="flex-1 space-y-4 px-4 py-5">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          只重新生成这一条语音，按你填写的文字来念。角色原回复、聊天记录和其他语音都不会改变。
        </p>

        {sessionVoice.isLoading ? (
          <div className="flex items-center justify-center py-16 text-[13px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            加载中
          </div>
        ) : (
          <div>
            <textarea
              ref={(node) => {
                textareaRef.current = node;
                if (node && draft === null) acceptedTextRef.current = node.value;
              }}
              defaultValue={currentText}
              onCompositionStart={(event) => {
                compositionRef.current = {
                  text: event.currentTarget.value,
                  selectionStart: event.currentTarget.selectionStart,
                  selectionEnd: event.currentTarget.selectionEnd,
                };
              }}
              onCompositionEnd={(event) => {
                const snapshot = compositionRef.current;
                compositionRef.current = null;
                if (!snapshot) return;

                const nextText = event.currentTarget.value;
                const hadNoSelection = snapshot.selectionStart === snapshot.selectionEnd;
                const replacesTailAtLimit =
                  snapshot.text.length >= maxChars && hadNoSelection && nextText !== snapshot.text;
                if (nextText.length > maxChars || replacesTailAtLimit) {
                  // 某些 WebView 会让中文候选词等长替换末尾字符，所以除了长度外，
                  // 还要根据合成开始前的快照判断“满额且无选区”的输入是否合法。
                  event.currentTarget.value = snapshot.text;
                  event.currentTarget.setSelectionRange(
                    snapshot.selectionStart,
                    snapshot.selectionEnd
                  );
                  acceptedTextRef.current = snapshot.text;
                  // Chrome/WebView 可能在 compositionend 后再派发最终 input。
                  // 仅在当前事件循环保留一次性快照，拦完该 input 立即释放，避免影响后续删除。
                  rejectedCompositionRef.current = snapshot;
                  if (rejectedCompositionTimerRef.current !== null) {
                    window.clearTimeout(rejectedCompositionTimerRef.current);
                  }
                  rejectedCompositionTimerRef.current = window.setTimeout(() => {
                    rejectedCompositionRef.current = null;
                    rejectedCompositionTimerRef.current = null;
                  }, 0);
                  setDraft(snapshot.text);
                  showOverLimitError();
                  return;
                }

                acceptedTextRef.current = nextText;
                setDraft(nextText);
                setError(null);
              }}
              onChange={(event) => {
                const nextText = event.currentTarget.value;
                // 预编辑文字只用于跟随输入法展示，不做长度判断、不提前报错。
                // 这里不能 setState：受控组件在中文合成期间重渲染会中断 IME，
                // 某些 WebView 随后不再派发 compositionend，表现为输入和删除都被锁住。
                if ((event.nativeEvent as InputEvent).isComposing || compositionRef.current) return;

                const rejectedComposition = rejectedCompositionRef.current;
                if (rejectedComposition) {
                  event.currentTarget.value = rejectedComposition.text;
                  event.currentTarget.setSelectionRange(
                    rejectedComposition.selectionStart,
                    rejectedComposition.selectionEnd
                  );
                  rejectedCompositionRef.current = null;
                  if (rejectedCompositionTimerRef.current !== null) {
                    window.clearTimeout(rejectedCompositionTimerRef.current);
                    rejectedCompositionTimerRef.current = null;
                  }
                  showOverLimitError();
                  return;
                }

                if (nextText.length > maxChars) {
                  event.currentTarget.value = acceptedTextRef.current;
                  showOverLimitError();
                  return;
                }
                acceptedTextRef.current = nextText;
                setDraft(nextText);
                setError(null);
              }}
              rows={8}
              autoFocus
              placeholder="想让这条语音说什么就写什么"
              aria-label="自定义语音文字"
              aria-invalid={Boolean(error)}
              className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2.5 text-[14px] leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="mt-1.5 flex items-start justify-between gap-3">
              <span className="text-[11px] leading-snug text-destructive">{error}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {text.length} / {maxChars}
              </span>
            </div>
          </div>
        )}
      </section>

      <div className="sticky bottom-0 border-t border-border bg-background/90 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur-xl">
        {priceLabel ? (
          <p className="mb-2 text-center text-[11px] text-muted-foreground">
            成功将消耗 {priceLabel}
          </p>
        ) : null}
        <Button
          type="button"
          onClick={submit}
          disabled={generateVoice.isPending || !sessionId}
          className="h-11 w-full rounded-full text-[14px] font-semibold"
        >
          {generateVoice.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              提交中
            </>
          ) : (
            '生成本条语音'
          )}
        </Button>
      </div>
    </main>
  );
}
