'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Send, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useCreateWishMutation, useCompleteWishMutation } from '@/lib/api/wishes';
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
    text: '欢迎来到许愿池。告诉我们你想要什么样的角色，一句话也可以，比如“温柔姐姐，会哄人睡觉”。你的许愿只会给运营看，不会公开展示。',
  },
];

export default function WishPage() {
  const router = useRouter();
  const createWish = useCreateWishMutation();
  const completeWish = useCompleteWishMutation();
  const { impact, notification } = useHaptic();

  const [step, setStep] = useState<Step>('wish');
  const [input, setInput] = useState('');
  const [wishId, setWishId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);

  const goBack = useCallback(() => router.push('/create'), [router]);
  useTelegramBackButton(goBack);

  const isPending = createWish.isPending || completeWish.isPending;
  const placeholder = useMemo(() => {
    if (step === 'wish') return '写下你想要的角色...';
    if (step === 'extra') return '补充关系、性格、故事背景等细节...';
    return '许愿已完成';
  }, [step]);

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
    appendMessage({ role: 'user', text });
    setInput('');

    try {
      if (step === 'wish') {
        if (Array.from(text).length <= MIN_WISH_LENGTH) {
          appendMessage({
            role: 'assistant',
            text: '再多说几个字呀，不然我猜不到你想要什么样的。',
          });
          return;
        }

        const result = await createWish.mutateAsync({ wish_text: text });
        setWishId(result.wish.id);
        setStep('extra');
        appendMessage({
          role: 'assistant',
          text:
            `收到，奖励你 ${result.wish.reward_credits} 星尘。` +
            '如果你还有更具体的想法，可以继续补充；没有的话点“就这样吧”。',
        });
        return;
      }

      if (step === 'extra' && wishId) {
        await completeWish.mutateAsync({ id: wishId, body: { extra_text: text } });
        setStep('done');
        appendMessage({ role: 'assistant', text: '记下了，我们会认真看每一条许愿。' });
      }
    } catch (error) {
      notification('error');
      const message = error instanceof Error ? error.message : '许愿暂时保存失败';
      appendMessage({ role: 'assistant', text: message });
    }
  }, [
    appendMessage,
    completeWish,
    createWish,
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
      await completeWish.mutateAsync({ id: wishId, body: {} });
      setStep('done');
      appendMessage({ role: 'assistant', text: '记下了，我们会认真看每一条许愿。' });
    } catch (error) {
      notification('error');
      const message = error instanceof Error ? error.message : '许愿暂时保存失败';
      appendMessage({ role: 'assistant', text: message });
    }
  }, [appendMessage, completeWish, impact, isPending, notification, step, wishId]);

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
                'max-w-[82%] rounded-3xl px-4 py-3 text-sm leading-6 shadow-lg',
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
            就这样吧
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
