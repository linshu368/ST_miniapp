'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_NAME_MAX_LENGTH,
  type UserPersona,
} from '@miniapp/shared';

import { HelpButton } from '@/components/ui/help-button';
import { Input } from '@/components/ui/input';
import { ApiClientError } from '@/lib/api/client';
import {
  useDeletePersonaMutation,
  usePutCharacterMySettingsMutation,
  useSavePersonaMutation,
} from '@/lib/api/character-persona';
import { cn } from '@/lib/utils';
import { ROW_BASE, ROW_OFF, ROW_ON } from './chat-persona-parts';

function PersonaFields({
  name,
  description,
  onName,
  onDescription,
}: {
  name: string;
  description: string;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <>
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1">
          <span className="text-[13px] font-semibold text-foreground">名字</span>
          <HelpButton
            label="名字"
            open={helpOpen}
            onToggle={() => setHelpOpen((value) => !value)}
          />
        </span>
        <Input
          value={name}
          onChange={(event) => onName(event.target.value)}
          maxLength={PERSONA_NAME_MAX_LENGTH}
          placeholder="例如：夜班调酒师"
          className="h-11 rounded-xl border-transparent bg-secondary/60 px-3 text-[14px]"
        />
        {helpOpen ? (
          <span className="mt-1 block text-[11px] text-muted-foreground">
            给自己区分用，TA 还是按你的昵称叫你
          </span>
        ) : null}
        <span className="mt-1 block text-right text-[10px] text-muted-foreground">
          {name.length} / {PERSONA_NAME_MAX_LENGTH}
        </span>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[13px] font-semibold text-foreground">人设描述</span>
        <textarea
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          maxLength={PERSONA_DESCRIPTION_MAX_LENGTH}
          rows={5}
          placeholder="年龄、身份、性格、说话方式……例如：二十六岁，夜班调酒师，嘴甜手快最会撩，喝多了就爱贴着人说话。"
          className="block min-h-[112px] w-full resize-none rounded-xl border border-transparent bg-secondary/60 px-3 py-2 text-[13px] leading-5 text-foreground placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:outline-none"
        />
        <span className="mt-1 block text-right text-[10px] text-muted-foreground">
          {description.length} / {PERSONA_DESCRIPTION_MAX_LENGTH}
        </span>
      </label>
    </>
  );
}

function DefaultSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={cn(ROW_BASE, on ? ROW_ON : ROW_OFF, 'min-h-14')}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">设为默认人设</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none',
          on ? 'bg-primary' : 'bg-muted-foreground/30'
        )}
      >
        <span
          className={cn(
            'size-4 rounded-full bg-white shadow-sm dark:bg-foreground transition-transform motion-reduce:transition-none',
            on && 'translate-x-4'
          )}
        />
      </span>
    </button>
  );
}

function DeletePersona({ busy, onDelete }: { busy: boolean; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="mx-auto block text-[12px] text-destructive"
      >
        删除这个人设
      </button>
    );
  }
  return (
    <div className="rounded-xl bg-destructive/10 px-3 py-2.5 text-[12px] text-destructive">
      删除后，选用它的角色会改用默认人设。
      <div className="mt-1.5 flex gap-4 font-semibold">
        <button type="button" disabled={busy} onClick={onDelete}>
          确认删除
        </button>
        <button
          type="button"
          className="text-muted-foreground"
          onClick={() => setConfirming(false)}
        >
          取消
        </button>
      </div>
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
      <PersonaFields
        name={name}
        description={description}
        onName={setName}
        onDescription={setDescription}
      />
      <DefaultSwitch on={isDefault} onToggle={() => setIsDefault((value) => !value)} />
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
      {persona ? <DeletePersona busy={busy} onDelete={() => void doDelete()} /> : null}
    </div>
  );
}
