'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Send, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  completeWishOnExit,
  useCreateWishMutation,
  useCompleteWishMutation,
  useWishStatusQuery,
} from '@/lib/api/wishes';
import { cn } from '@/lib/utils';
import { useHaptic, useTelegramBackButton } from '@/lib/telegram';

type Message = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
};

type Step = 'wish' | 'extra' | 'done';

const MIN_WISH_LENGTH = 8;

const INITIAL_MESSAGES: Message[] = [
  {
    id: 'intro',
    role: 'assistant',
    text: `💫 说说你想要什么样的角色？
一句话就行，比如：
- "霸道总裁但其实是社恐"
- "温柔姐姐，会哄人睡觉"
- "赛博朋克世界的酒吧老板娘"
🔒 你的许愿完全私密，放心大胆说 👇每天只能许愿一次哦~`,
  },
];

const TOO_SHORT_MESSAGE = '再多说几个字呀，不然我猜不到你想要什么样的～';
const LIMIT_REACHED_MESSAGE = '你今天的许愿次数已经用完啦，明天再来～';
const FINISH_MESSAGE = '✅ 记下了！我们会认真看每一条许愿～';

export default function WishPage() {
  const router = useRouter();
  const wishStatus = useWishStatusQuery();
  const { isPending: isCreatingWish, mutateAsync: createWishAsync } = useCreateWishMutation();
  const {
    isPending: isCompletingWish,
    mutate: completeWish,
    mutateAsync: completeWishAsync,
  } = useCompleteWishMutation();
  const { impact, notification } = useHaptic();

  const [step, setStep] = useState<Step>('wish');
  const [input, setInput] = useState('');
  const [wishId, setWishId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const autoClosedWishIdsRef = useRef<Set<string>>(new Set());
  const stepRef = useRef<Step>(step);
  const wishIdRef = useRef<string | null>(wishId);

  const isPending = wishStatus.isLoading || isCreatingWish || isCompletingWish;
  const closePendingWish = useCallback(() => {
    if (!wishId || step !== 'extra' || isCompletingWish) return;
    completeWish({ id: wishId, body: {} });
  }, [completeWish, isCompletingWish, step, wishId]);
  const goBack = useCallback(() => {
    closePendingWish();
    router.push('/create');
  }, [closePendingWish, router]);
  useTelegramBackButton(goBack);

  const placeholder = useMemo(() => {
    if (wishStatus.isLoading) return '正在读取许愿状态...';
    if (step === 'wish') return '一句话许愿...';
    if (step === 'extra') return '补充关系、性格、故事背景等细节...';
    return '许愿已完成';
  }, [step, wishStatus.isLoading]);

  useEffect(() => {
    stepRef.current = step;
    wishIdRef.current = wishId;
  }, [step, wishId]);

  useEffect(() => {
    const completeCurrentWish = () => {
      if (stepRef.current !== 'extra' || !wishIdRef.current) return;
      completeWishOnExit(wishIdRef.current);
    };

    window.addEventListener('pagehide', completeCurrentWish);
    return () => {
      completeCurrentWish();
      window.removeEventListener('pagehide', completeCurrentWish);
    };
  }, []);

  useEffect(() => {
    const latestWish = wishStatus.data?.latest_wish;
    if (!latestWish) return;

    // Only hydrate an existing daily-limit state before this page starts a new local flow.
    // Status refetches after create/complete should not overwrite the user's in-progress input.
    if (step !== 'wish' || wishId) {
      return;
    }

    setWishId(latestWish.id);
    setInput('');
    setStep('done');
    setMessages([
      ...INITIAL_MESSAGES,
      { id: 'existing-wish', role: 'user', text: latestWish.wish_text },
      {
        id: 'limit-reached',
        role: 'assistant',
        text: LIMIT_REACHED_MESSAGE,
      },
    ]);

    if (
      latestWish.status === 'awaiting_extra' &&
      !autoClosedWishIdsRef.current.has(latestWish.id)
    ) {
      autoClosedWishIdsRef.current.add(latestWish.id);
      completeWish({ id: latestWish.id, body: {} });
    }
  }, [completeWish, step, wishId, wishStatus.data?.latest_wish]);

  const appendMessage = useCallback((message: Omit<Message, 'id'>) => {
    setMessages((current) => [
      ...current,
      {
        ...message,
        id: `${Date.now()}-${current.length}`,
      },
    ]);
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isPending || step === 'done') return;

    impact('light');

    try {
      if (step === 'wish') {
        if (Array.from(text).length <= MIN_WISH_LENGTH) {
          appendMessage({
            role: 'assistant',
            text: TOO_SHORT_MESSAGE,
          });
          return;
        }

        appendMessage({ role: 'user', text });
        setInput('');
        const result = await createWishAsync({ wish_text: text });
        setWishId(result.wish.id);
        setStep('extra');
        appendMessage({
          role: 'assistant',
          text: `✅ 收到！奖励你 ${result.wish.reward_credits} 星尘 ✨如果你还有更具体的想法，比如你和 ta 的关系、性格细节、故事背景，可以继续说～
没有的话点下面就好 👇`,
        });
        return;
      }

      if (step === 'extra' && wishId) {
        appendMessage({ role: 'user', text });
        setInput('');
        await completeWishAsync({ id: wishId, body: { extra_text: text } });
        setStep('done');
        appendMessage({ role: 'assistant', text: FINISH_MESSAGE });
      }
    } catch (error) {
      notification('error');
      const message = error instanceof Error ? error.message : '许愿暂时保存失败';
      appendMessage({ role: 'assistant', text: message });
    }
  }, [
    appendMessage,
    createWishAsync,
    completeWishAsync,
    impact,
    input,
    isPending,
    notification,
    step,
    wishId,
  ]);

  const handleFinish = useCallback(async () => {
    if (!wishId || step !== 'extra' || isPending) return;
    impact('light');
    try {
      await completeWishAsync({ id: wishId, body: {} });
      setStep('done');
      appendMessage({ role: 'assistant', text: FINISH_MESSAGE });
    } catch (error) {
      notification('error');
      const message = error instanceof Error ? error.message : '许愿暂时保存失败';
      appendMessage({ role: 'assistant', text: message });
    }
  }, [appendMessage, completeWishAsync, impact, isPending, notification, step, wishId]);

  return (
    <main
      data-app-shell="wish"
      className="mx-auto flex h-[100dvh] max-w-md flex-col bg-[#0A0A0A] text-white"
    >
      <div className="h-1 w-full shrink-0 bg-gradient-to-r from-fuchsia-500 via-purple-500 to-amber-300" />

      <header className="flex shrink-0 items-center gap-3 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <Button
          variant="ghost"
          size="icon"
          onClick={goBack}
          className="-ml-2 rounded-full text-slate-400 hover:text-white"
          aria-label="返回创作页"
        >
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-purple-300/70">
            Wish Pool
          </p>
          <h1 className="text-lg font-black tracking-wide">许愿池</h1>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 p-2 text-amber-200">
          <Sparkles className="h-4 w-4" aria-hidden />
        </div>
      </header>

      <section className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[82%] whitespace-pre-line rounded-3xl px-4 py-3 text-sm leading-6 shadow-lg',
                message.role === 'user'
                  ? 'rounded-br-lg bg-white text-slate-950'
                  : 'rounded-bl-lg border border-white/10 bg-white/[0.06] text-slate-100'
              )}
            >
              {message.text}
            </div>
          </div>
        ))}
      </section>

      <footer className="shrink-0 border-t border-white/10 bg-[#0A0A0A]/95 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 backdrop-blur">
        {step === 'extra' && (
          <Button
            type="button"
            variant="ghost"
            onClick={handleFinish}
            disabled={isPending}
            className="mb-2 h-8 rounded-full px-3 text-xs text-slate-300 hover:text-white"
          >
            💖 就这样吧
          </Button>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={placeholder}
            disabled={step === 'done' || isPending}
            className="max-h-32 min-h-[48px] flex-1 resize-none rounded-2xl border-white/10 bg-white/[0.06] text-sm text-white placeholder:text-slate-500"
          />
          <Button
            type="button"
            size="icon"
            onClick={handleSubmit}
            disabled={!input.trim() || step === 'done' || isPending}
            className="h-12 w-12 rounded-2xl bg-white text-slate-950 hover:bg-purple-100"
            aria-label="发送许愿"
          >
            <Send className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </footer>
    </main>
  );
}
