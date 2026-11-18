'use client';

import { useEffect, useState } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import {
  CHARACTER_NOTES_MAX_LENGTH,
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_MAX_COUNT,
  PERSONA_NAME_MAX_LENGTH,
  type CharacterPersonaChoice,
  type GetCharacterMySettingsData,
  type UserPersona,
} from '@miniapp/shared';

import { Input } from '@/components/ui/input';
import { ApiClientError } from '@/lib/api/client';
import {
  useCharacterMySettingsQuery,
  useDeletePersonaMutation,
  usePutCharacterMySettingsMutation,
  useSavePersonaMutation,
} from '@/lib/api/character-persona';
import { cn } from '@/lib/utils';

/** 工具箱里「角色设定」一行的副标题：不点进去就能看到设过什么。 */
export function characterSettingsHint(data: GetCharacterMySettingsData | undefined): string {
  if (!data) return '补充这张卡的人物，选择你的人设';
  const parts: string[] = [];
  if (data.notes.trim()) parts.push('已补充设定');
  const persona = effectivePersona(data);
  if (persona) parts.push(`人设：${persona.name}`);
  return parts.length > 0 ? parts.join(' · ') : '补充这张卡的人物，选择你的人设';
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

const ROW_BASE =
  'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60';
const ROW_ON = 'border-primary/35 bg-primary/10';
const ROW_OFF = 'border-border bg-secondary/35 hover:bg-secondary/60';

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

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-primary">
      {children}
    </span>
  );
}

interface ChatCharacterSettingsProps {
  characterId: string;
  /** persona 为 null 表示新建。 */
  onEditPersona: (persona: UserPersona | null) => void;
}

/**
 * 工具箱二级页「角色设定」。人设选择在上（点一下就好），补充设定在下（要打字）。
 * 选择立即保存；补充设定离开输入框后自动保存，与回复偏好里的"我的偏好"一致。
 * 设定从下一轮对话起生效，由后端每轮重新注入，不会被历史截断或记忆压缩冲掉。
 */
export function ChatCharacterSettings({ characterId, onEditPersona }: ChatCharacterSettingsProps) {
  const query = useCharacterMySettingsQuery(characterId);
  const put = usePutCharacterMySettingsMutation(characterId);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [failed, setFailed] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  const data = query.data;

  useEffect(() => {
    if (notesDirty || !data) return;
    setNotes(data.notes);
  }, [data, notesDirty]);

  const save = async (request: Parameters<typeof put.mutateAsync>[0]) => {
    setFailed(false);
    try {
      await put.mutateAsync(request);
      setSavedAt(true);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };

  const saveNotes = async () => {
    if (!data) return;
    setNotesDirty(false);
    if (notes === data.notes) return;
    await save({ notes });
  };

  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-dashed border-border px-4 py-6 text-[12px]">
        <span className="text-muted-foreground" role="alert">
          角色设定加载失败
        </span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="rounded-lg px-2 py-1 text-primary hover:bg-primary/10"
        >
          重试
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-1.5 py-6 text-[12px] text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        加载中
      </p>
    );
  }

  const defaultPersona = data.personas.find((persona) => persona.is_default) ?? null;
  const mode = data.persona.mode;
  const choose = (choice: CharacterPersonaChoice) => {
    setSavedAt(false);
    void save({ persona: choice });
  };

  return (
    <div className="space-y-5">
      <section aria-label="我的人设">
        <div className="mb-0.5 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">我的人设</h3>
          <Tag>选择只记在这张卡</Tag>
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          告诉角色“你”是谁。新建的人设所有角色都能选。
        </p>
        <div className="space-y-1.5" role="radiogroup" aria-label="选择人设">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'default'}
            disabled={put.isPending}
            onClick={() => choose(CHOICE_DEFAULT)}
            className={cn(ROW_BASE, mode === 'default' ? ROW_ON : ROW_OFF)}
          >
            <Radio on={mode === 'default'} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">跟随默认</span>
              <span className="mt-0.5 line-clamp-2 block text-[11px] leading-[18px] text-muted-foreground">
                {defaultPersona
                  ? `${defaultPersona.name}：${defaultPersona.description}`
                  : '还没有默认人设'}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'none'}
            disabled={put.isPending}
            onClick={() => choose(CHOICE_NONE)}
            className={cn(ROW_BASE, mode === 'none' ? ROW_ON : ROW_OFF)}
          >
            <Radio on={mode === 'none'} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">不使用</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                这张卡不带任何人设
              </span>
            </span>
          </button>
          {data.personas.map((persona) => {
            const on = mode === 'persona' && data.persona.persona_id === persona.id;
            return (
              <div key={persona.id} className="relative">
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={put.isPending}
                  onClick={() => choose({ mode: 'persona', persona_id: persona.id })}
                  className={cn(ROW_BASE, 'pr-12', on ? ROW_ON : ROW_OFF)}
                >
                  <Radio on={on} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <span className="truncate">{persona.name}</span>
                      {persona.is_default ? <Tag>默认</Tag> : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] leading-[18px] text-muted-foreground">
                      {persona.description}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`编辑${persona.name}`}
                  onClick={() => onEditPersona(persona)}
                  className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <Pencil className="size-[15px]" aria-hidden />
                </button>
              </div>
            );
          })}
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
      </section>

      <section aria-label="补充设定">
        <div className="mb-0.5 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">补充设定</h3>
          <Tag>只对这张卡生效</Tag>
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          在角色卡原有设定之外，补充这张卡里的人物或规则，可以写多个人。
        </p>
        <textarea
          value={notes}
          onChange={(event) => {
            setNotesDirty(true);
            setSavedAt(false);
            setNotes(event.target.value);
          }}
          onBlur={() => void saveNotes()}
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
            : `${notes.length} / ${CHARACTER_NOTES_MAX_LENGTH} · ${
                put.isPending
                  ? '保存中…'
                  : notesDirty
                    ? '离开输入框后自动保存'
                    : savedAt
                      ? '已保存，下一轮对话生效'
                      : '自动保存'
              }`}
        </p>
      </section>

      <p className="rounded-2xl border border-dashed border-border px-3 py-2.5 text-center text-[12px] text-muted-foreground">
        文风、长度等偏好请在输入框上方的
        <span className="text-primary">回复偏好</span>
        里调整，那里对所有角色生效
      </p>
    </div>
  );
}

interface ChatPersonaEditorProps {
  characterId: string;
  /** null 表示新建。 */
  persona: UserPersona | null;
  /** 保存、删除或取消后回到角色设定页。 */
  onDone: () => void;
  firstPersona: boolean;
}

/** 新建 / 编辑人设。新建后顺手选用到当前这张卡。 */
export function ChatPersonaEditor({
  characterId,
  persona,
  onDone,
  firstPersona,
}: ChatPersonaEditorProps) {
  const [name, setName] = useState(persona?.name ?? '');
  const [description, setDescription] = useState(persona?.description ?? '');
  const [isDefault, setIsDefault] = useState(persona?.is_default ?? firstPersona);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useSavePersonaMutation();
  const remove = useDeletePersonaMutation();
  const putSettings = usePutCharacterMySettingsMutation(characterId);
  const busy = save.isPending || remove.isPending || putSettings.isPending;
  const invalid =
    name.trim().length === 0 ||
    description.trim().length === 0 ||
    name.length > PERSONA_NAME_MAX_LENGTH ||
    description.length > PERSONA_DESCRIPTION_MAX_LENGTH;

  const submit = async () => {
    setError(null);
    try {
      const { persona: saved } = await save.mutateAsync({
        personaId: persona?.id,
        body: { name, description, is_default: isDefault },
      });
      if (!persona)
        await putSettings.mutateAsync({ persona: { mode: 'persona', persona_id: saved.id } });
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 409 ? err.message : '保存失败，请重试'
      );
    }
  };

  const doDelete = async () => {
    if (!persona) return;
    setError(null);
    try {
      await remove.mutateAsync(persona.id);
      onDone();
    } catch {
      setError('删除失败，请重试');
    }
  };

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">名字</span>
          <Tag>只用于你自己区分</Tag>
        </span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={PERSONA_NAME_MAX_LENGTH}
          placeholder="例如：夜班调酒师"
          className="h-11 rounded-xl border-transparent bg-secondary/60 px-3 text-[14px]"
        />
        <span className="mt-1 block text-right text-[10px] text-muted-foreground">
          {name.length} / {PERSONA_NAME_MAX_LENGTH}
        </span>
      </label>

      <label className="block">
        <span className="mb-0.5 block text-[13px] font-semibold text-foreground">人设描述</span>
        <span className="mb-1.5 block text-[11px] text-muted-foreground">
          会写进发给模型的设定里。称呼仍使用你的昵称。
        </span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={PERSONA_DESCRIPTION_MAX_LENGTH}
          rows={5}
          placeholder="年龄、身份、性格、说话方式……例如：二十六岁，夜班调酒师，嘴甜手快最会撩，喝多了就爱贴着人说话。"
          className="block min-h-[112px] w-full resize-none rounded-xl border border-transparent bg-secondary/60 px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none"
        />
        <span className="mt-1 block text-right text-[10px] text-muted-foreground">
          {description.length} / {PERSONA_DESCRIPTION_MAX_LENGTH}
        </span>
      </label>

      <button
        type="button"
        role="switch"
        aria-checked={isDefault}
        onClick={() => setIsDefault((value) => !value)}
        className={cn(ROW_BASE, isDefault ? ROW_ON : ROW_OFF, 'min-h-14')}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-foreground">新对话默认使用</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            没单独选过人设的角色，都用它
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            'flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none',
            isDefault ? 'bg-primary' : 'bg-muted-foreground/30'
          )}
        >
          <span
            className={cn(
              'size-4 rounded-full bg-foreground shadow-sm transition-transform motion-reduce:transition-none',
              isDefault && 'translate-x-4'
            )}
          />
        </span>
      </button>

      {error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={invalid || busy}
        onClick={() => void submit()}
        className="flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-45"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        保存
      </button>

      {persona ? (
        confirmDelete ? (
          <div className="rounded-xl bg-destructive/10 px-3 py-2.5 text-[12px] text-destructive">
            删除后，选用它的角色会改用默认人设。
            <div className="mt-1.5 flex gap-4 font-semibold">
              <button type="button" disabled={busy} onClick={() => void doDelete()}>
                确认删除
              </button>
              <button
                type="button"
                className="text-muted-foreground"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="mx-auto block text-[12px] text-destructive"
          >
            删除这个人设
          </button>
        )
      ) : null}
    </div>
  );
}
