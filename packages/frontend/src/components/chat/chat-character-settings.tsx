'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import {
  CHARACTER_NOTES_MAX_LENGTH,
  PERSONA_MAX_COUNT,
  type CharacterPersonaChoice,
  type GetCharacterMySettingsData,
  type UserPersona,
} from '@miniapp/shared';

import {
  useCharacterMySettingsQuery,
  usePutCharacterMySettingsMutation,
} from '@/lib/api/character-persona';
import { cn } from '@/lib/utils';
import { ROW_BASE, ROW_OFF, ROW_ON, Tag } from './chat-persona-parts';

export { ChatPersonaEditor } from './chat-persona-editor';

const EMPTY_HINT = '补充这张卡的人物，选择你的人设';

/** 工具箱里「角色设定」一行的副标题：不点进去就能看到设过什么。 */
export function characterSettingsHint(data: GetCharacterMySettingsData | undefined): string {
  if (!data) return EMPTY_HINT;
  const parts: string[] = [];
  if (data.notes.trim()) parts.push('已补充设定');
  const persona = effectivePersona(data);
  if (persona) parts.push(`人设：${persona.name}`);
  return parts.length > 0 ? parts.join(' · ') : EMPTY_HINT;
}

function effectivePersona(data: GetCharacterMySettingsData): UserPersona | null {
  if (data.persona.mode === 'none') return null;
  if (data.persona.mode === 'persona') {
    return data.personas.find((persona) => persona.id === data.persona.persona_id) ?? null;
  }
  return data.personas.find((persona) => persona.is_default) ?? null;
}

const CHOICE_DEFAULT: CharacterPersonaChoice = { mode: 'default', persona_id: null };
const CHOICE_NONE: CharacterPersonaChoice = { mode: 'none', persona_id: null };

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]',
        on ? 'border-primary' : 'border-muted-foreground/60'
      )}
    >
      {on ? <span className="size-2 rounded-full bg-primary" /> : null}
    </span>
  );
}

function SectionHeading({ title, tag, help }: { title: string; tag: string; help: string }) {
  return (
    <>
      <div className="mb-0.5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
        <Tag>{tag}</Tag>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">{help}</p>
    </>
  );
}

function ChoiceRow({
  on,
  disabled,
  onClick,
  title,
  detail,
  className,
}: {
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  title: ReactNode;
  detail: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(ROW_BASE, on ? ROW_ON : ROW_OFF, className)}
    >
      <Radio on={on} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {title}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-[18px] text-muted-foreground">
          {detail}
        </span>
      </span>
    </button>
  );
}

function PersonaChoiceList({
  data,
  busy,
  onChoose,
  onEditPersona,
}: {
  data: GetCharacterMySettingsData;
  busy: boolean;
  onChoose: (choice: CharacterPersonaChoice) => void;
  onEditPersona: (persona: UserPersona | null) => void;
}) {
  const defaultPersona = data.personas.find((persona) => persona.is_default) ?? null;
  const mode = data.persona.mode;
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label="选择人设">
      <ChoiceRow
        on={mode === 'default'}
        disabled={busy}
        onClick={() => onChoose(CHOICE_DEFAULT)}
        title="跟随默认"
        detail={
          defaultPersona
            ? `${defaultPersona.name}：${defaultPersona.description}`
            : '还没有默认人设'
        }
      />
      <ChoiceRow
        on={mode === 'none'}
        disabled={busy}
        onClick={() => onChoose(CHOICE_NONE)}
        title="不使用"
        detail="这张卡不带任何人设"
      />
      {data.personas.map((persona) => (
        <div key={persona.id} className="relative">
          <ChoiceRow
            on={mode === 'persona' && data.persona.persona_id === persona.id}
            disabled={busy}
            onClick={() => onChoose({ mode: 'persona', persona_id: persona.id })}
            title={
              <>
                <span className="truncate">{persona.name}</span>
                {persona.is_default ? <Tag>默认</Tag> : null}
              </>
            }
            detail={persona.description}
            className="pr-12"
          />
          <button
            type="button"
            aria-label={`编辑${persona.name}`}
            onClick={() => onEditPersona(persona)}
            className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="size-[15px]" aria-hidden />
          </button>
        </div>
      ))}
      {data.personas.length < PERSONA_MAX_COUNT ? (
        <button
          type="button"
          onClick={() => onEditPersona(null)}
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-primary/50 px-3 py-2.5 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/5"
        >
          <Plus className="size-4" aria-hidden />
          新建人设
        </button>
      ) : (
        <p className="px-1 text-[11px] text-muted-foreground">
          最多 {PERSONA_MAX_COUNT} 个人设，删除一个才能新建
        </p>
      )}
    </div>
  );
}

function NotesField({
  serverNotes,
  saving,
  failed,
  saved,
  onEdit,
  onSave,
}: {
  serverNotes: string;
  saving: boolean;
  failed: boolean;
  saved: boolean;
  onEdit: () => void;
  onSave: (notes: string) => void;
}) {
  const [notes, setNotes] = useState(serverNotes);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setNotes(serverNotes);
  }, [serverNotes, dirty]);

  const status = saving
    ? '保存中…'
    : dirty
      ? '离开输入框后自动保存'
      : saved
        ? '已保存，下一轮对话生效'
        : '自动保存';

  return (
    <>
      <textarea
        value={notes}
        onChange={(event) => {
          setDirty(true);
          onEdit();
          setNotes(event.target.value);
        }}
        onBlur={() => {
          setDirty(false);
          if (notes !== serverNotes) onSave(notes);
        }}
        maxLength={CHARACTER_NOTES_MAX_LENGTH}
        placeholder="例如：林晚：TA 的前任，分手了还留着你送的睡衣，一喝醉就给你打电话。苏棠：住对门，总穿着吊带裙来借东西，借完也不急着走。"
        rows={5}
        aria-label="补充设定"
        className="block min-h-[112px] w-full resize-none rounded-xl border border-transparent bg-secondary/60 px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none"
      />
      <p
        className={cn(
          'mt-1.5 text-right text-[10px]',
          failed ? 'text-destructive' : 'text-muted-foreground'
        )}
        role={failed ? 'alert' : 'status'}
      >
        {failed
          ? '保存失败，请重试'
          : `${notes.length} / ${CHARACTER_NOTES_MAX_LENGTH} · ${status}`}
      </p>
    </>
  );
}

function LoadState({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (!failed) {
    return (
      <p className="flex items-center gap-1.5 py-6 text-[12px] text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        加载中
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-2xl border border-dashed border-border px-4 py-6 text-[12px]">
      <span className="text-muted-foreground" role="alert">
        角色设定加载失败
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg px-2 py-1 text-primary hover:bg-primary/10"
      >
        重试
      </button>
    </div>
  );
}

interface ChatCharacterSettingsProps {
  characterId: string;
  /** persona 为 null 表示新建。 */
  onEditPersona: (persona: UserPersona | null) => void;
}

/**
 * 工具箱二级页「角色设定」。人设选择在上（点一下就好），补充设定在下（要打字）。
 * 选择立即保存；补充设定离开输入框后自动保存，与回复偏好里的文风偏好一致。
 * 设定从下一轮对话起生效，由后端每轮重新注入，不会被历史截断或记忆压缩冲掉。
 */
export function ChatCharacterSettings({ characterId, onEditPersona }: ChatCharacterSettingsProps) {
  const query = useCharacterMySettingsQuery(characterId);
  const put = usePutCharacterMySettingsMutation(characterId);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const data = query.data;

  const save = async (request: Parameters<typeof put.mutateAsync>[0]) => {
    setFailed(false);
    try {
      await put.mutateAsync(request);
      setSaved(true);
    } catch {
      setFailed(true);
    }
  };

  if (!data) return <LoadState failed={query.isError} onRetry={() => void query.refetch()} />;

  return (
    <div className="space-y-5">
      <section aria-label="我的人设">
        <SectionHeading
          title="我的人设"
          tag="选择只记在这张卡"
          help="告诉角色“你”是谁。新建的人设所有角色都能选。"
        />
        <PersonaChoiceList
          data={data}
          busy={put.isPending}
          onChoose={(choice) => {
            setSaved(false);
            void save({ persona: choice });
          }}
          onEditPersona={onEditPersona}
        />
      </section>

      <section aria-label="补充设定">
        <SectionHeading
          title="补充设定"
          tag="只对这张卡生效"
          help="在角色卡原有设定之外，补充这张卡里的人物或规则，可以写多个人。"
        />
        <NotesField
          serverNotes={data.notes}
          saving={put.isPending}
          failed={failed}
          saved={saved}
          onEdit={() => setSaved(false)}
          onSave={(notes) => void save({ notes })}
        />
      </section>

      <p className="rounded-2xl border border-dashed border-border px-3 py-2.5 text-center text-[12px] text-muted-foreground">
        文风、长度等偏好请在输入框上方的
        <span className="text-primary">回复偏好</span>
        里调整，那里对所有角色生效
      </p>
    </div>
  );
}
