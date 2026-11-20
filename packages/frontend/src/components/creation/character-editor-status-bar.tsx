'use client';

/**
 * 建卡页"状态栏"栏目（必填）：写下想要什么样的状态栏（选填）让 AI 生成，不写就按角色资料生成 /
 * 从示例开始 / 从空白开始；生成后在预览卡上点着改，可"换一套"、说说想怎么改让 AI 改、AI 补全说明，
 * 任何一次替换都能"恢复上一版"。
 * 预览就是玩家在聊天页右侧状态面板里看到的样子；每 5 轮自动更新。
 */
import { useState, type ReactNode } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  STATUS_BAR_DIRECTION_MAX_CHARS,
  STATUS_BAR_EXAMPLES,
  STATUS_BAR_LIMITS,
  checkStatusBarTemplate,
  countStatusBarItems,
  type CharacterDraft,
  type StatusBarItem,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { ApiClientError } from '@/lib/api/client';
import { useCreatorStatusBarAi } from '@/lib/api/status-bar';
import { StatusBarEditor } from '@/components/status-bar/status-bar-editor';
import { emptyStatusTemplate, newStatusId } from '@/components/status-bar/status-template';
import { cn } from '@/lib/utils';
import type { EditorModel } from './use-character-editor';

const EXAMPLES = STATUS_BAR_EXAMPLES.filter((example) => example.id !== 'ex-ex');

/** 示例换上新 id，避免和别的卡、别的分区撞 id。 */
function fromExample(template: StatusBarTemplate): StatusBarTemplate {
  return {
    ...template,
    sections: template.sections.map((section) => ({
      ...section,
      id: newStatusId('s'),
      items: section.items.map((item) => ({ ...item, id: newStatusId('i') })),
    })),
  };
}

function aiError(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'RATE_LIMITED')
    return '上一次还在处理中，稍等一下';
  if (error instanceof ApiClientError && error.code === 'STATUS_AI_INVALID')
    return `AI 这次没写好：${error.message}，再试一次`;
  return 'AI 暂时不可用，请稍后再试。已有的状态栏没有改动';
}

function Chooser({
  draft,
  busy,
  onPick,
  onGenerate,
  onBack,
}: {
  draft: CharacterDraft;
  busy: boolean;
  onPick: (template: StatusBarTemplate, label: string) => void;
  onGenerate: (direction: string) => void;
  onBack?: () => void;
}) {
  const [direction, setDirection] = useState('');
  const wanted = direction.trim();
  const ready =
    Boolean(wanted) ||
    Boolean(draft.description.trim() || draft.background.trim() || draft.backgroundFiles.length);
  return (
    <div className="mt-2.5 grid gap-2.5">
      {onBack ? (
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          换一套：换了之后随时可以“恢复上一版”
          <button type="button" className="min-h-9 text-primary" onClick={onBack}>
            ← 不换了
          </button>
        </div>
      ) : null}
      <label className="grid gap-1.5">
        <span className="text-[12px] text-muted-foreground">
          想要什么样的状态栏？（选填，不写就按角色资料来）
        </span>
        <textarea
          className="min-h-[76px] resize-y rounded-xl border border-input bg-card px-3 py-2 text-[13px] leading-6 outline-none placeholder:text-[12.5px] placeholder:text-muted-foreground focus:border-primary/60"
          value={direction}
          maxLength={STATUS_BAR_DIRECTION_MAX_CHARS}
          disabled={busy}
          placeholder="比如：记她对我的好感和欲望，到 100 会主动；再加一栏她今天穿了什么、一份我们之间的秘密清单"
          onChange={(event) => setDirection(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !ready}
        onClick={() => onGenerate(wanted)}
        className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 text-[14px] font-medium text-primary disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        {busy
          ? '正在生成状态栏…'
          : wanted
            ? 'AI 按我说的生成'
            : onBack
              ? '让 AI 重新生成一套'
              : 'AI 根据角色资料生成'}
      </button>
      {!ready ? (
        <p className="text-[11.5px] text-muted-foreground">
          先写好描述或背景，或者在上面说说想要什么，AI 才知道这张卡该记录什么
        </p>
      ) : null}
      <p className="text-[12px] text-muted-foreground">或者从示例开始</p>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example.id}
            type="button"
            disabled={busy}
            onClick={() =>
              onPick(fromExample(example.template), `已套用"${example.label}"示例，改改就能用`)
            }
            className="min-h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            {example.label}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => onPick(emptyStatusTemplate(), '已换成空白，点"加一项"开始')}
          className="min-h-9 text-[12px] text-primary underline underline-offset-4"
        >
          从空白开始
        </button>
      </div>
    </div>
  );
}

/** 说说想怎么改，让 AI 改整栏；改成功才清空输入。 */
function AiEditForm({
  busy,
  pending,
  onSubmit,
}: {
  busy: boolean;
  pending: boolean;
  onSubmit: (instruction: string) => Promise<boolean>;
}) {
  const [instruction, setInstruction] = useState('');
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const text = instruction.trim();
        if (text) void onSubmit(text).then((done) => done && setInstruction(''));
      }}
    >
      <input
        className="min-h-11 min-w-0 rounded-xl border border-input bg-card px-3 text-[13px] outline-none placeholder:text-[12.5px] placeholder:text-muted-foreground focus:border-primary/60"
        value={instruction}
        maxLength={STATUS_BAR_DIRECTION_MAX_CHARS}
        disabled={busy}
        placeholder="说说想怎么改：加个情欲值 / 好感度换成星级"
        onChange={(event) => setInstruction(event.target.value)}
      />
      <button
        type="submit"
        disabled={busy || !instruction.trim()}
        className="flex min-h-11 items-center gap-1 rounded-xl border border-primary/40 bg-primary/10 px-3.5 text-[13px] text-primary disabled:opacity-50"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-3.5" aria-hidden />
        )}
        改
      </button>
    </form>
  );
}

/** 结果提示 + AI 补全说明 + 恢复上一版。 */
function SectionStatusRow({
  feedback,
  complete,
  busy,
  onRestore,
}: {
  feedback: string;
  complete: { count: number; pending: boolean; run: () => void } | null;
  busy: boolean;
  onRestore: (() => void) | null;
}) {
  return (
    <div
      className="flex min-h-8 flex-wrap items-center gap-x-3 text-[11.5px] text-muted-foreground"
      role="status"
    >
      {feedback}
      {complete ? (
        <button
          type="button"
          className="min-h-9 text-primary underline underline-offset-4"
          disabled={busy}
          onClick={complete.run}
        >
          {complete.pending ? 'AI 补全中…' : `AI 补全 ${complete.count} 项说明`}
        </button>
      ) : null}
      {onRestore && !busy ? (
        <button
          type="button"
          className="min-h-9 text-primary underline underline-offset-4"
          onClick={onRestore}
        >
          恢复上一版
        </button>
      ) : null}
    </div>
  );
}

function SectionHeader({ current }: { current: StatusBarTemplate | undefined }) {
  return (
    <>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h2 id="creator-status-bar-label" className="text-sm font-medium text-foreground">
          状态栏
          <span className="ml-1 text-destructive" aria-hidden>
            *
          </span>
        </h2>
        {current ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            已用 {countStatusBarItems(current)} / {STATUS_BAR_LIMITS.items} 项
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-[22px] text-muted-foreground">
        玩家在聊天页右侧点开就能看到的状态面板，每 5 轮自动更新。每一项的说明决定 AI
        写什么、怎么变，写得越清楚越准。
      </p>
    </>
  );
}

/** 已有状态栏：预览卡上点着改 + 换一套 + 说说想怎么改让 AI 改。 */
function EditingPanel({
  template,
  busy,
  editPending,
  describe,
  onSwap,
  onChange,
  onAiEdit,
}: {
  template: StatusBarTemplate;
  busy: boolean;
  editPending: boolean;
  describe: (item: StatusBarItem) => Promise<string>;
  onSwap: () => void;
  onChange: (next: StatusBarTemplate) => void;
  onAiEdit: (instruction: string) => Promise<boolean>;
}) {
  return (
    <div className="mt-2.5 grid gap-2.5">
      <div className="flex items-center justify-between text-[12px] text-muted-foreground">
        玩家看到的样子 · 点任意一项修改
        <button type="button" className="min-h-9 text-primary" disabled={busy} onClick={onSwap}>
          换一套
        </button>
      </div>
      <StatusBarEditor
        template={template}
        onChange={onChange}
        mode="creator"
        describe={describe}
        disabled={busy}
      />
      <AiEditForm busy={busy} pending={editPending} onSubmit={onAiEdit} />
    </div>
  );
}

export function CharacterStatusBarSection({
  draft,
  disabled,
  invalid,
  onChange,
  hint,
}: {
  draft: CharacterDraft;
  disabled: boolean;
  invalid: boolean;
  onChange: (statusBar: StatusBarTemplate | undefined) => void;
  hint: ReactNode;
}) {
  const ai = useCreatorStatusBarAi();
  const [choosing, setChoosing] = useState(false);
  const [history, setHistory] = useState<StatusBarTemplate[]>([]);
  const [feedback, setFeedback] = useState('');
  const current = draft.statusBar;
  const busy = disabled || ai.generate.isPending || ai.edit.isPending || ai.complete.isPending;
  const replace = (next: StatusBarTemplate, message: string) => {
    if (current) setHistory((list) => [...list.slice(-9), current]);
    onChange(next);
    setChoosing(false);
    setFeedback(message);
  };
  /** 成功返回 true；失败只提示，已有的状态栏不动。 */
  const run = (
    promise: Promise<{ template: StatusBarTemplate; remark?: string }>,
    message: string
  ) =>
    promise
      .then(({ template, remark }) => {
        replace(template, remark ? `${message}。${remark}` : message);
        return true;
      })
      .catch((error: unknown) => {
        setFeedback(aiError(error));
        return false;
      });
  const missingDesc = current
    ? checkStatusBarTemplate(current).filter((issue) => issue.code.startsWith('DESC_')).length
    : 0;
  const describe = async (item: StatusBarItem) =>
    (await ai.describe.mutateAsync({ draft, item })).desc;

  return (
    <section
      className="mt-6 border-t border-border/70 pt-5"
      aria-labelledby="creator-status-bar-label"
    >
      <SectionHeader current={current} />
      <div
        id="creator-status-bar"
        className={cn(
          'scroll-mt-5',
          invalid &&
            !current &&
            'mt-2 rounded-xl outline outline-1 outline-offset-4 outline-destructive/40'
        )}
      >
        {!current || choosing ? (
          <Chooser
            draft={draft}
            busy={busy}
            onGenerate={(direction) =>
              void run(
                ai.generate.mutateAsync(direction ? { draft, direction } : { draft }),
                direction
                  ? '已按你说的生成，连同开局值。不满意可以点开改，或说说想怎么改'
                  : '已按角色资料生成，连同开局值。不满意可以点开改，或说说想怎么改'
              )
            }
            onPick={replace}
            onBack={current ? () => setChoosing(false) : undefined}
          />
        ) : (
          <EditingPanel
            template={current}
            busy={busy}
            editPending={ai.edit.isPending}
            describe={describe}
            onSwap={() => setChoosing(true)}
            onChange={(next) => {
              onChange(next);
              setFeedback('');
            }}
            onAiEdit={(instruction) =>
              run(
                ai.edit.mutateAsync({ draft, template: current, instruction }),
                '已按你的要求改好'
              )
            }
          />
        )}
      </div>
      <SectionStatusRow
        feedback={feedback}
        complete={
          current && missingDesc && !choosing
            ? {
                count: missingDesc,
                pending: ai.complete.isPending,
                run: () =>
                  void run(
                    ai.complete.mutateAsync({ draft, template: current }),
                    '已补全说明，可以点开再改'
                  ),
              }
            : null
        }
        busy={busy}
        onRestore={
          history.length
            ? () => {
                onChange(history[history.length - 1]);
                setHistory((list) => list.slice(0, -1));
                setFeedback('已恢复上一版');
              }
            : null
        }
      />
      {hint}
    </section>
  );
}

/** 建卡页里的接线：放在"预设"之后、"标签"之前，必填。 */
export function CharacterEditorStatusBar({ model }: { model: EditorModel }) {
  return (
    <CharacterStatusBarSection
      draft={model.draft}
      disabled={model.busy}
      invalid={model.showRequired && model.missingFields.includes('状态栏')}
      hint={model.correctionHint('状态栏')}
      onChange={(statusBar) =>
        model.local.update((current) => ({ ...current, draft: { ...current.draft, statusBar } }))
      }
    />
  );
}
