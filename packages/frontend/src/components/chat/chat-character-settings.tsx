'use client';

import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ChevronDown, FileText, Loader2, Pencil, UserRound } from 'lucide-react';
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

export { ChatPersonaEditor } from './chat-persona-editor';

function effectivePersona(data: GetCharacterMySettingsData): UserPersona | null {
  if (data.persona.mode === 'none') return null;
  if (data.persona.mode === 'persona') {
    return data.personas.find((persona) => persona.id === data.persona.persona_id) ?? null;
  }
  return data.personas.find((persona) => persona.is_default) ?? null;
}

/**
 * 两个模块各用一种颜色区分：我的人设 = 主色金，补充设定 = 藕粉。
 * Tailwind 需要完整类名才能生成，所以按色调写成映射，不拼接。
 */
const TONES = {
  primary: {
    card: 'border-primary/20',
    open: 'border-primary/45',
    head: 'bg-gradient-to-r from-primary/[0.12] to-primary/[0.03]',
    icon: 'bg-primary/15 text-primary',
    tag: 'bg-primary/15 text-primary',
    accent: 'text-primary',
    chevron: 'text-primary/80',
    divider: 'border-primary/20',
  },
  mauve: {
    card: 'border-mauve/20',
    open: 'border-mauve/45',
    head: 'bg-gradient-to-r from-mauve/[0.12] to-mauve/[0.03]',
    icon: 'bg-mauve/15 text-mauve',
    tag: 'bg-mauve/15 text-mauve',
    accent: 'text-mauve',
    chevron: 'text-mauve/80',
    divider: 'border-mauve/20',
  },
  // 状态栏：鼠尾草绿，呼应状态卡底色，和人设金、补充设定藕粉一眼区分。
  sage: {
    card: 'border-success/20',
    open: 'border-success/45',
    head: 'bg-gradient-to-r from-success/[0.12] to-success/[0.03]',
    icon: 'bg-success/15 text-success',
    tag: 'bg-success/15 text-success',
    accent: 'text-success',
    chevron: 'text-success/80',
    divider: 'border-success/20',
  },
} as const;
type Tone = keyof typeof TONES;

/** 折叠状态只是本机偏好：存储不可用时按默认值渲染，不影响功能。 */
export function useFoldState(key: string, defaultOpen: boolean) {
  const storageKey = `st_miniapp_tools_fold_${key}`;
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved !== null) setOpen(saved === '1');
    } catch {
      // 隐私模式等读不到存储时沿用默认值。
    }
  }, [storageKey]);
  const toggle = () =>
    setOpen((value) => {
      try {
        window.localStorage.setItem(storageKey, value ? '0' : '1');
      } catch {
        // 写不进去只影响下次打开时的展开状态。
      }
      return !value;
    });
  return [open, toggle] as const;
}

export function ModuleCard({
  tone,
  icon: Icon,
  title,
  tag,
  summary,
  open,
  onToggle,
  children,
}: {
  tone: Tone;
  icon: ComponentType<{ className?: string }>;
  title: string;
  tag: string;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <section
      aria-label={title}
      className={cn('overflow-hidden rounded-2xl border bg-card', open ? t.open : t.card)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn('flex w-full items-center gap-3 px-4 py-3.5 text-left', t.head)}
      >
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', t.icon)}
        >
          <Icon className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
            {title}
            <span className={cn('rounded-full px-2 py-px text-[10px] font-medium', t.tag)}>
              {tag}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted-foreground">
            {summary}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            t.chevron,
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className={cn('border-t bg-muted/45 px-4 pb-4 pt-3', t.divider)}>{children}</div>
      ) : null}
    </section>
  );
}

function personaSummary(data: GetCharacterMySettingsData): ReactNode {
  if (data.persona.mode === 'none') {
    return (
      <>
        这张卡：<span className={TONES.primary.accent}>不使用人设</span>
      </>
    );
  }
  const persona = effectivePersona(data);
  if (!persona) return '还没有人设，点开新建一个';
  return (
    <>
      这张卡用：<span className={TONES.primary.accent}>{persona.name}</span>
      {data.persona.mode === 'default' ? '（默认）' : null}
    </>
  );
}

function notesSummary(notes: string): ReactNode {
  const lines = notes
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '还没写，点开补充这张卡里的人物';
  // 多数人按「名字：描述」写，取冒号前的短名字当预览；取不到就只显示段数。
  const names = lines
    .map((line) => line.split(/[：:]/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0 && name.length <= 8)
    .slice(0, 3);
  return (
    <>
      已写 {lines.length} 段
      {names.length > 0 ? (
        <>
          ：<span className={TONES.mauve.accent}>{names.join('、')}</span>
        </>
      ) : null}
    </>
  );
}

const CHIP_BASE =
  'rounded-full border px-3 py-1.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60';
const CHIP_ON = 'border-primary/40 bg-primary/[0.12] font-semibold text-primary';
const CHIP_OFF = 'border-border bg-secondary/35 text-muted-foreground hover:bg-secondary/60';

function PersonaDetail({
  data,
  onEditPersona,
}: {
  data: GetCharacterMySettingsData;
  onEditPersona: (persona: UserPersona | null) => void;
}) {
  const mode = data.persona.mode;
  const active = effectivePersona(data);
  return (
    <div className="mt-2.5 flex items-start gap-2 rounded-xl bg-secondary/45 px-3 py-2.5">
      <p className="min-w-0 flex-1 text-[12px] leading-[19px] text-muted-foreground">
        {mode === 'none' ? (
          '这张卡不带任何人设，角色只按角色卡来。'
        ) : active ? (
          <>
            <span className="font-semibold text-foreground">{active.name}</span>
            {mode === 'default' ? '（默认）' : null}　{active.description}
          </>
        ) : (
          '还没有默认人设，先新建一个。'
        )}
      </p>
      {mode !== 'none' && active ? (
        <button
          type="button"
          aria-label={`编辑${active.name}`}
          onClick={() => onEditPersona(active)}
          className="-my-1 -mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Pencil className="size-[15px]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function PersonaPicker({
  data,
  busy,
  failed,
  onChoose,
  onEditPersona,
}: {
  data: GetCharacterMySettingsData;
  busy: boolean;
  failed: boolean;
  onChoose: (choice: CharacterPersonaChoice) => void;
  onEditPersona: (persona: UserPersona | null) => void;
}) {
  const mode = data.persona.mode;
  const chip = (key: string, on: boolean, label: string, choice: CharacterPersonaChoice) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChoose(choice)}
      className={cn(CHIP_BASE, on ? CHIP_ON : CHIP_OFF)}
    >
      {label}
    </button>
  );
  return (
    <>
      <p className="mb-2.5 text-[11px] text-muted-foreground">
        告诉角色“你”是谁。人设所有角色通用，选哪个只记在这张卡。
      </p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="选择人设">
        {chip('default', mode === 'default', '跟随默认', { mode: 'default', persona_id: null })}
        {chip('none', mode === 'none', '不使用', { mode: 'none', persona_id: null })}
        {data.personas.map((persona) =>
          chip(
            persona.id,
            mode === 'persona' && data.persona.persona_id === persona.id,
            persona.name,
            { mode: 'persona', persona_id: persona.id }
          )
        )}
        {data.personas.length < PERSONA_MAX_COUNT ? (
          <button
            type="button"
            onClick={() => onEditPersona(null)}
            className={cn(
              CHIP_BASE,
              'border-dashed border-primary/50 text-primary hover:bg-primary/5'
            )}
          >
            ＋ 新建
          </button>
        ) : null}
      </div>
      <PersonaDetail data={data} onEditPersona={onEditPersona} />
      {data.personas.length >= PERSONA_MAX_COUNT ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          最多 {PERSONA_MAX_COUNT} 个人设，删除一个才能新建
        </p>
      ) : null}
      {failed ? (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          没保存上，请再选一次
        </p>
      ) : null}
    </>
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
      <p className="mb-2 text-[11px] text-muted-foreground">
        在角色卡原有设定之外，补充这张卡里的人物或规则，可以写多个人。
      </p>
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
        className="block min-h-[112px] w-full resize-none rounded-xl border border-transparent bg-secondary/60 px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus-visible:border-mauve/60 focus-visible:outline-none"
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
      <p
        className="flex items-center gap-1.5 px-1 py-4 text-[12px] text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        正在读取角色设定
      </p>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-2xl border border-dashed border-border px-4 py-4 text-[12px]">
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

interface ChatCharacterModulesProps {
  characterId: string;
  /** persona 为 null 表示新建。 */
  onEditPersona: (persona: UserPersona | null) => void;
}

/**
 * 工具箱「对话设置」里直接展开的两个模块：我的人设（金）与补充设定（藕粉），各自可折叠。
 * 选人设立即保存；补充设定离开输入框后自动保存。设定从下一轮对话起生效，
 * 由后端每轮重新注入，不会被历史截断或记忆压缩冲掉。
 */
export function ChatCharacterModules({ characterId, onEditPersona }: ChatCharacterModulesProps) {
  const query = useCharacterMySettingsQuery(characterId);
  const put = usePutCharacterMySettingsMutation(characterId);
  // 人设最常用，默认展开；补充设定要打字，默认收起。
  const [personaOpen, togglePersona] = useFoldState('persona', true);
  const [notesOpen, toggleNotes] = useFoldState('notes', false);
  const [failed, setFailed] = useState<'persona' | 'notes' | null>(null);
  const [saved, setSaved] = useState(false);
  const data = query.data;

  const save = async (
    request: Parameters<typeof put.mutateAsync>[0],
    target: 'persona' | 'notes'
  ) => {
    setFailed(null);
    try {
      await put.mutateAsync(request);
      setSaved(true);
    } catch {
      setFailed(target);
    }
  };

  if (!data) return <LoadState failed={query.isError} onRetry={() => void query.refetch()} />;

  return (
    <>
      <ModuleCard
        tone="primary"
        icon={UserRound}
        title="我的人设"
        tag="按卡选择"
        summary={personaSummary(data)}
        open={personaOpen}
        onToggle={togglePersona}
      >
        <PersonaPicker
          data={data}
          busy={put.isPending}
          failed={failed === 'persona'}
          onChoose={(choice) => {
            setSaved(false);
            void save({ persona: choice }, 'persona');
          }}
          onEditPersona={onEditPersona}
        />
      </ModuleCard>
      <ModuleCard
        tone="mauve"
        icon={FileText}
        title="补充设定"
        tag="只对这张卡"
        summary={notesSummary(data.notes)}
        open={notesOpen}
        onToggle={toggleNotes}
      >
        <NotesField
          serverNotes={data.notes}
          saving={put.isPending}
          failed={failed === 'notes'}
          saved={saved}
          onEdit={() => setSaved(false)}
          onSave={(notes) => void save({ notes }, 'notes')}
        />
      </ModuleCard>
    </>
  );
}
