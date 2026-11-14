'use client';

import { useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  DRAMA_SURVEY_COMMENT_QUESTION,
  DRAMA_SURVEY_MAX_REASONS,
  DRAMA_SURVEY_OPEN_QUESTION,
  DRAMA_SURVEY_OPEN_REASONS,
  DRAMA_SURVEY_OTHER_REASON,
  DRAMA_SURVEY_WATCH_QUESTION,
  DRAMA_SURVEY_WATCH_REASONS,
  type DramaSurveyEngagement,
} from '@miniapp/shared';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSubmitDramaSurveyMutation } from '@/lib/api/drama-survey';
import { shuffled } from '@/lib/drama-survey-trigger';
import { cn } from '@/lib/utils';

interface Option {
  id: string;
  label: string;
}
interface ChoiceAnswer {
  reasons: string[];
  otherText: string;
}
const TOTAL_STEPS = 3;
const emptyChoice: ChoiceAnswer = { reasons: [], otherText: '' };
const PRIMARY_BUTTON =
  'flex min-h-12 w-full items-center justify-center rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:bg-white/[0.07] disabled:text-zinc-500';

export function DramaSurveySheet({
  open,
  rewardCredits,
  platform,
  engagement,
  onSubmitted,
  onClose,
}: {
  open: boolean;
  rewardCredits: number;
  platform: string;
  engagement: DramaSurveyEngagement;
  onSubmitted: () => void;
  onClose: (submitted: boolean) => void;
}) {
  const commentId = useId();
  // 每次弹出只排一次序，作答过程中选项不跳动；「其他」固定在最后。
  const [options] = useState(() => ({
    open: [...shuffled(DRAMA_SURVEY_OPEN_REASONS), DRAMA_SURVEY_OTHER_REASON] as Option[],
    watch: [...shuffled(DRAMA_SURVEY_WATCH_REASONS), DRAMA_SURVEY_OTHER_REASON] as Option[],
  }));
  // 严格按 Q2a → Q2b → Q3 顺序作答，每道选择题至少选一项才能进入下一题。
  const [step, setStep] = useState(0);
  const [openAnswer, setOpenAnswer] = useState<ChoiceAnswer>(emptyChoice);
  const [watchAnswer, setWatchAnswer] = useState<ChoiceAnswer>(emptyChoice);
  const [comment, setComment] = useState('');
  const submit = useSubmitDramaSurveyMutation();
  const pending = submit.isPending;
  const result = submit.data ?? null;
  const current = step === 0 ? openAnswer : watchAnswer;
  const setCurrent = step === 0 ? setOpenAnswer : setWatchAnswer;
  const canAdvance = isAnswered(current);

  const send = () =>
    submit.mutate(
      {
        open_reasons: openAnswer.reasons,
        open_other_text: otherTextOf(openAnswer),
        watch_reasons: watchAnswer.reasons,
        watch_other_text: otherTextOf(watchAnswer),
        comment,
        platform,
        engagement,
      },
      { onSuccess: onSubmitted }
    );

  return (
    <Sheet open={open} onOpenChange={(next) => !next && !pending && onClose(result !== null)}>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] border-white/10 bg-[#202022] px-5 pt-3 text-zinc-100 motion-reduce:animate-none motion-reduce:transition-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SurveyHeader
          title={result ? '感谢参与' : '聊聊你对短剧的看法'}
          description={describe(result, rewardCredits, step)}
          pending={pending}
        />
        {result ? (
          <div className="shrink-0 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
            <SheetClose className={PRIMARY_BUTTON}>继续聊天</SheetClose>
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (step < TOTAL_STEPS - 1) {
                if (canAdvance) setStep(step + 1);
              } else if (!pending) send();
            }}
          >
            <div className="min-h-0 overflow-y-auto overscroll-contain pb-2">
              {step < TOTAL_STEPS - 1 ? (
                <ChoiceQuestion
                  key={step}
                  legend={step === 0 ? DRAMA_SURVEY_OPEN_QUESTION : DRAMA_SURVEY_WATCH_QUESTION}
                  options={step === 0 ? options.open : options.watch}
                  answer={current}
                  onChange={setCurrent}
                />
              ) : (
                <CommentQuestion
                  id={commentId}
                  value={comment}
                  onChange={setComment}
                  disabled={pending}
                />
              )}
            </div>
            <div className="shrink-0 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
              {submit.error ? (
                <p role="alert" className="mb-2 text-xs leading-5 text-destructive">
                  {submit.error.message || '提交失败，请重试'}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={step < TOTAL_STEPS - 1 ? !canAdvance : pending}
                aria-busy={pending}
                className={PRIMARY_BUTTON}
              >
                {step < TOTAL_STEPS - 1
                  ? '下一题'
                  : pending
                    ? '提交中…'
                    : `提交并领取 ${rewardCredits} 星尘`}
              </button>
            </div>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}

const otherTextOf = (answer: ChoiceAnswer) =>
  answer.reasons.includes(DRAMA_SURVEY_OTHER_REASON.id) ? answer.otherText : '';

/** 至少选一项；选了「其他」必须写明原因，否则这一项没有分析价值。 */
const isAnswered = (answer: ChoiceAnswer) =>
  answer.reasons.length > 0 &&
  (!answer.reasons.includes(DRAMA_SURVEY_OTHER_REASON.id) || answer.otherText.trim() !== '');

function describe(
  result: { status: string; credits: number } | null,
  rewardCredits: number,
  step: number
) {
  if (result)
    return result.status === 'rewarded'
      ? `${result.credits} 星尘已到账，可在钱包查看。`
      : '你已经领过这份问卷的奖励啦。';
  return `第 ${step + 1}/${TOTAL_STEPS} 题 · 大约 30 秒，提交即得 ${rewardCredits} 星尘。`;
}

function SurveyHeader({
  title,
  description,
  pending,
}: {
  title: string;
  description: string;
  pending: boolean;
}) {
  return (
    <>
      <div aria-hidden className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-white/15" />
      <div className="flex shrink-0 items-center justify-between gap-2">
        <SheetTitle className="text-lg font-semibold tracking-wide text-zinc-100">
          {title}
        </SheetTitle>
        <SheetClose
          aria-label="关闭问卷"
          disabled={pending}
          className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-[18px]" aria-hidden />
        </SheetClose>
      </div>
      <SheetDescription className="mb-3 shrink-0 text-[13px] leading-5 text-zinc-400">
        {description}
      </SheetDescription>
    </>
  );
}

function ChoiceQuestion({
  legend,
  options,
  answer,
  onChange,
}: {
  legend: string;
  options: readonly Option[];
  answer: ChoiceAnswer;
  onChange: (next: ChoiceAnswer) => void;
}) {
  const toggle = (id: string) => {
    const has = answer.reasons.includes(id);
    if (!has && answer.reasons.length >= DRAMA_SURVEY_MAX_REASONS) return;
    onChange({
      ...answer,
      reasons: has ? answer.reasons.filter((item) => item !== id) : [...answer.reasons, id],
    });
  };
  return (
    <fieldset role="group">
      <legend className="mb-2 text-[14px] font-medium text-zinc-200">
        {legend}
        <span className="ml-1 text-xs font-normal text-zinc-500">
          （至少选 1 项，最多 {DRAMA_SURVEY_MAX_REASONS} 项）
        </span>
      </legend>
      <div className="grid gap-2">
        {options.map((option) => {
          const selected = answer.reasons.includes(option.id);
          return (
            <button
              type="button"
              key={option.id}
              aria-pressed={selected}
              onClick={() => toggle(option.id)}
              className={cn(
                'flex min-h-11 items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-white/[0.08] bg-white/[0.025] text-zinc-300 hover:bg-white/5'
              )}
            >
              {option.label}
              <Check aria-hidden className={cn('size-3.5 shrink-0', !selected && 'invisible')} />
            </button>
          );
        })}
      </div>
      {answer.reasons.includes(DRAMA_SURVEY_OTHER_REASON.id) ? (
        <input
          aria-label="其他原因说明（必填）"
          aria-required
          data-sentry-mask
          maxLength={200}
          value={answer.otherText}
          onChange={(event) => onChange({ ...answer, otherText: event.target.value })}
          placeholder="请写下具体原因，填写后才能继续"
          className="mt-2 w-full rounded-xl border border-white/10 bg-black/10 px-3 py-2.5 text-base text-zinc-200 outline-none placeholder:text-sm placeholder:text-zinc-600 focus:border-primary/50"
        />
      ) : null}
    </fieldset>
  );
}

function CommentQuestion({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-[14px] font-medium text-zinc-200">
          {DRAMA_SURVEY_COMMENT_QUESTION}
          <span className="ml-1 text-xs font-normal text-zinc-500">（选填）</span>
        </label>
        <span className="text-[11px] tabular-nums text-zinc-500">{value.length}/500</span>
      </div>
      <textarea
        id={id}
        data-sentry-mask
        maxLength={500}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-24 w-full resize-none rounded-xl border border-white/10 bg-black/10 p-3 text-base leading-6 text-zinc-200 outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
      />
    </div>
  );
}
