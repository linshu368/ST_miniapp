'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, Expand, ImagePlus, LoaderCircle, Sparkles, Upload } from 'lucide-react';
import {
  CharacterDraftSchema,
  CreatorPolishRequestSchema,
  creatorPublishMissingFields,
  type CharacterDraft,
  type CreatorCharacter,
} from '@miniapp/shared';
import { cn } from '@/lib/utils';
import { useTelegramBackButton } from '@/lib/telegram/hooks';
import { chatEntryPath } from '@/lib/chat-entry';
import { useCreateConversationMutation } from '@/lib/api/conversations';
import {
  fileToImagePlazaPayload,
  useCreateImagePlazaConversationMutation,
} from '@/lib/api/image-plaza';
import {
  useCreatorCharactersQuery,
  useCreatorCharacterQuery,
  useCreatorCoverQuery,
  useCreateCreatorCoverMutation,
  useCreatorPolishMutation,
  useSaveCreatorCharacterMutation,
  usePublishCreatorCharacterMutation,
  useSetCreatorVisibilityMutation,
} from '@/lib/api/creator-characters';
import { ApiClientError } from '@/lib/api/client';
import {
  initialCharacterEditorDraft,
  saveCharacterDraft,
  getCharacterDraftChangeState,
} from './character-editor-draft';
import { useCharacterEditorDraft } from './use-character-editor-draft';
import { CreatorDocumentImport, CreatorDocumentAttachments } from './character-editor-documents';
import { CharacterPresetChoices } from './character-editor-presets';
import {
  CharacterEditorModal,
  CharacterFullscreenEditor,
  CharacterPolishDialog,
  type CharacterPolishSession,
  type CharacterPolishTarget,
} from './character-editor-dialogs';

const TAGS = [
  '纯爱',
  '女性向',
  'NTR',
  '古风历史',
  '调教',
  '乱伦',
  '仙侠古风',
  '大世界',
  '后宫',
  '足控',
  '同人',
  '百合',
  '男娘',
  '油腻',
  '扶她',
  '一般向',
  '男同',
  '女性视角',
  '游戏',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT =
  'block w-full min-w-0 rounded-xl border border-input bg-card px-3.5 py-3 text-base leading-7 text-foreground outline-none placeholder:text-[13px] placeholder:text-muted-foreground focus:border-primary/60 disabled:opacity-60';
const FIELDS = [
  {
    key: 'description',
    label: '描述',
    placeholder: '描述你的角色或故事，会展示在卡片和聊天页顶部',
    rows: 4,
    required: true,
    divider: false,
  },
  {
    key: 'opening',
    label: '开场白',
    placeholder: '用户进入聊天后看到的第一段内容。可以描写开场场景，也可以让角色先说一句话。',
    rows: 5,
    required: true,
    divider: true,
  },
  {
    key: 'background',
    label: '背景',
    placeholder:
      '定义角色的外观、个性和背景。你也可以添加自定义提示、故事、规则或者上传剧本小说。这些细节将指导角色的行为和回应',
    rows: 7,
    required: true,
    divider: true,
  },
  {
    key: 'preset',
    label: '预设',
    placeholder: '破甲话术。对有些模型来说必不可少。',
    rows: 5,
    required: false,
    divider: true,
  },
] as const;
type TextField = (typeof FIELDS)[number]['key'];

export function CharacterEditorPage({ characterId }: { characterId?: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const requestedDraft = search.get('draft');
  const draftId =
    characterId ?? (requestedDraft && UUID.test(requestedDraft) ? requestedDraft : null);
  const list = useCreatorCharactersQuery();
  const detail = useCreatorCharacterQuery(characterId);
  useEffect(() => {
    if (!characterId && !draftId)
      router.replace(`/creation/characters/new?draft=${crypto.randomUUID()}`, { scroll: false });
  }, [characterId, draftId, router]);
  const retry = () => {
    void list.refetch();
    if (characterId) void detail.refetch();
  };
  if (list.isError || (characterId && detail.isError))
    return (
      <main className="mx-auto max-w-lg px-6 py-10">
        <Link
          href="/creation?tab=created"
          className="flex min-h-11 items-center gap-2 text-sm text-primary"
        >
          <ArrowLeft className="size-4" />
          返回我的创作
        </Link>
        <p className="mt-8 text-sm leading-7 text-foreground/80">
          {(list.error ?? detail.error)?.message || '角色资料暂时没有加载成功。'}
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 min-h-11 rounded-xl border border-border px-5 text-sm"
        >
          重新加载
        </button>
      </main>
    );
  if (!draftId || !list.data || (characterId && !detail.data))
    return (
      <main className="mx-auto max-w-lg px-6 py-10 text-sm text-muted-foreground" aria-busy>
        正在准备角色资料…
      </main>
    );
  return (
    <CharacterEditor
      key={`${list.data.owner_user_id}:${draftId}`}
      ownerId={list.data.owner_user_id}
      draftId={draftId}
      character={detail.data?.character}
      reloadCharacter={async () => {
        const result = await detail.refetch();
        if (result.error || !result.data) throw result.error ?? new Error('暂时无法读取最新角色。');
        return result.data.character;
      }}
    />
  );
}

function CharacterEditor({
  ownerId,
  draftId,
  character,
  reloadCharacter,
}: {
  ownerId: string;
  draftId: string;
  character?: CreatorCharacter;
  reloadCharacter: () => Promise<CreatorCharacter>;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const initial = useMemo(() => initialCharacterEditorDraft(character), [character]);
  const local = useCharacterEditorDraft({ ownerId, draftId, characterId: character?.id }, initial);
  const { ready: localReady, update: updateLocal, flush: flushLocal } = local;
  const { draft, visibility, coverAssetId } = local.value;
  const editorPath = character
    ? `/creation/characters/${character.id}/edit`
    : `/creation/characters/new?draft=${draftId}`;
  const returningId = search.get('cover_asset_id');
  const requestedCover = returningId && UUID.test(returningId) ? returningId : coverAssetId;
  const cover = useCreatorCoverQuery(requestedCover);
  const coverUrl =
    cover.data?.asset.id === coverAssetId ? cover.data.asset.image_url : local.value.coverUrl;
  const upload = useCreateCreatorCoverMutation();
  const createStudio = useCreateImagePlazaConversationMutation();
  const save = useSaveCreatorCharacterMutation();
  const publish = usePublishCreatorCharacterMutation();
  const setVisibility = useSetCreatorVisibilityMutation();
  const polishMutation = useCreatorPolishMutation();
  const createChat = useCreateConversationMutation();
  const [editing, setEditing] = useState<TextField | null>(null);
  const [fullCover, setFullCover] = useState(false);
  const [showRequired, setShowRequired] = useState(false);
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryDraftId, setRecoveryDraftId] = useState<string | null>(null);
  const backupId = useRef<string | null>(null);
  const [published, setPublished] = useState<CreatorCharacter | null>(null);
  const [importNotice, setImportNotice] = useState({ background: '', preset: '' });
  const [session, setSession] = useState<CharacterPolishSession | null>(null);
  const sessionRef = useRef<CharacterPolishSession | null>(null);
  const [polishOpen, setPolishOpen] = useState(false);
  const [polishFeedback, setPolishFeedback] = useState<
    Partial<Record<CharacterPolishTarget, string>>
  >({});
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | null>(null);
  const polishSnapshot = useRef(draft);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const adoptedCover = useRef<string | null>(null);
  const missingFields = creatorPublishMissingFields(draft, coverAssetId);
  const busy = working || upload.isPending || createStudio.isPending;
  const sameContent = Boolean(
    character &&
    JSON.stringify(character.draft) === JSON.stringify(draft) &&
    character.cover_asset_id === coverAssetId
  );
  const unchanged = Boolean(
    character?.state === 'ready' &&
    sameContent &&
    character.visibility === visibility &&
    getCharacterDraftChangeState(local.value) !== 'changed'
  );
  const submitLabel =
    visibility === 'private'
      ? '保存到我的空间'
      : character?.approved_revision
        ? '提交更新审核'
        : '提交审核';
  const requiredMark = (
    <span className="ml-1 text-destructive" aria-hidden>
      *
    </span>
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);
  useEffect(() => {
    const asset = cover.data?.asset;
    if (
      !localReady ||
      !returningId ||
      !asset ||
      asset.id !== returningId ||
      adoptedCover.current === asset.id
    )
      return;
    adoptedCover.current = asset.id;
    updateLocal((current) => ({ ...current, coverAssetId: asset.id, coverUrl: asset.image_url }));
    router.replace(editorPath, { scroll: false });
  }, [cover.data, returningId, localReady, updateLocal, router, editorPath]);

  const goBack = useCallback(async () => {
    if (busyRef.current) return;
    if (!(await flushLocal())) {
      setNotice('本地草稿还没保存成功，请稍后再返回。当前内容仍在这里。');
      return;
    }
    router.push('/creation?tab=created');
  }, [flushLocal, router]);
  useTelegramBackButton(goBack);
  const change = (
    key: keyof Pick<CharacterDraft, 'name' | 'description' | 'opening' | 'background' | 'preset'>,
    value: string
  ) => local.update((current) => ({ ...current, draft: { ...current.draft, [key]: value } }));

  async function uploadCover(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    setNotice('');
    try {
      const payload = await fileToImagePlazaPayload(file);
      const { asset } = await upload.mutateAsync({
        id: crypto.randomUUID(),
        source: 'upload',
        ...payload,
      });
      if (!mounted.current) return;
      local.update((current) => ({
        ...current,
        coverAssetId: asset.id,
        coverUrl: asset.image_url,
      }));
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : '封面上传失败，请重试。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function generateCover() {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    setNotice('');
    try {
      if (!(await local.flush())) throw new Error('本地草稿暂未保存，请稍后再进入图片创作。');
      let studioId = local.value.coverStudioId;
      if (!studioId) {
        const data = await createStudio.mutateAsync({});
        if (!mounted.current) return;
        studioId = data.conversation.id;
        local.update((current) => ({ ...current, coverStudioId: studioId }));
        if (!(await local.flush())) throw new Error('生成记录暂未保存，请稍后再试。');
      }
      if (!mounted.current) return;
      router.push(`/create/studio/${studioId}?creator_return=${encodeURIComponent(editorPath)}`);
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : '暂时无法进入图片创作，请重试。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  function keepPolish(next: CharacterPolishSession) {
    sessionRef.current = next;
    setSession(next);
    local.update((current) => ({
      ...current,
      polishCandidates: { ...current.polishCandidates, [next.target]: next },
    }));
  }
  const closePolish = () => {
    setPolishOpen(false);
    void local.flush();
  };
  function discardPolish() {
    const current = sessionRef.current;
    if (!current) return;
    active.current?.abort();
    active.current = null;
    local.update((value) => {
      const candidates = { ...value.polishCandidates };
      delete candidates[current.target];
      return { ...value, polishCandidates: candidates };
    });
    sessionRef.current = null;
    setSession(null);
    setPolishOpen(false);
    void local.flush();
  }
  async function polish(target: CharacterPolishTarget, retry = false) {
    if (!retry) {
      const candidate =
        active.current && sessionRef.current?.target === target
          ? sessionRef.current
          : local.value.polishCandidates[target];
      if (candidate) {
        sessionRef.current = candidate;
        setSession(candidate);
        setPolishOpen(true);
        polishSnapshot.current = draft;
        return;
      }
    }
    if (active.current && sessionRef.current?.target !== target) return;
    const context = retry ? polishSnapshot.current : draft;
    const parsed = CreatorPolishRequestSchema.safeParse({ target, draft: context });
    if (!parsed.success) {
      setPolishFeedback((current) => ({
        ...current,
        [target]: parsed.error.issues[0]?.message || '先写几句想法，再让 AI 帮你完善。',
      }));
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    polishSnapshot.current = context;
    keepPolish({ target, original: context[target], result: '', state: 'loading', error: '' });
    setPolishOpen(true);
    try {
      await polishMutation.mutateAsync({
        body: parsed.data,
        signal: controller.signal,
        onText: (text) => {
          if (mounted.current && active.current === controller && sessionRef.current)
            keepPolish({ ...sessionRef.current, result: text });
        },
      });
      if (mounted.current && active.current === controller && sessionRef.current)
        keepPolish({ ...sessionRef.current, state: 'ready' });
    } catch (error) {
      if (
        mounted.current &&
        active.current === controller &&
        !controller.signal.aborted &&
        sessionRef.current
      )
        keepPolish({
          ...sessionRef.current,
          state: 'error',
          error: error instanceof Error ? error.message : '润色暂时未完成。原稿已保留。',
        });
    } finally {
      if (active.current === controller) active.current = null;
      void local.flush();
    }
  }

  function focusMissing(label: string) {
    const ids: Record<string, string> = {
      角色形象: 'creator-cover',
      名称: 'creator-name',
      描述: 'creator-description',
      开场白: 'creator-opening',
      背景: 'creator-background',
      标签: 'creator-tags',
    };
    const element = document.getElementById(ids[label] ?? '');
    if (!element) return;
    element.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
    const focusTarget =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element
        : element.parentElement?.querySelector<HTMLElement>('button, input');
    focusTarget?.focus({ preventScroll: true });
  }

  async function loadLatestKeepingBackup() {
    if (!character || busyRef.current) return;
    busyRef.current = true;
    setWorking(true);
    setNotice('');
    try {
      active.current?.abort();
      active.current = null;
      const id = backupId.current ?? (backupId.current = crypto.randomUUID());
      await saveCharacterDraft(
        { ownerId, draftId: id },
        {
          ...local.value,
          serverRevision: null,
          baselineFingerprint: undefined,
          recoveryFor: character.id,
        }
      );
      setRecoveryDraftId(id);
      const fresh = await reloadCharacter();
      if (!mounted.current) return;
      if (!(await local.replace(initialCharacterEditorDraft(fresh))))
        throw new Error('最新版暂未载入，当前修改和备份都已保留，请重试。');
      setRecoveryOpen(false);
      setSession(null);
      sessionRef.current = null;
      setPolishOpen(false);
      backupId.current = null;
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '未能保留修改，当前内容没有替换，请重试。'
      );
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function submit() {
    if (busyRef.current || unchanged) return;
    setShowRequired(true);
    setNotice('');
    if (missingFields.length) {
      focusMissing(missingFields[0]!);
      return;
    }
    const parsed = CharacterDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setNotice('内容超出可保存范围，请检查名称、正文和导入文件的长度。');
      return;
    }
    if (local.conflict) {
      setNotice('这张角色卡已有更新，请先载入最新版本。你的本地内容仍然保留。');
      return;
    }
    busyRef.current = true;
    setWorking(true);
    try {
      let result: CreatorCharacter;
      if (sameContent && character?.state === 'ready' && character.visibility !== visibility) {
        result = (
          await setVisibility.mutateAsync({
            id: character.id,
            body: {
              expected_revision: local.value.serverRevision ?? character.revision,
              visibility,
            },
          })
        ).character;
      } else {
        const saved =
          local.value.serverRevision !== null
            ? await save.mutateAsync({
                id: character?.id ?? draftId,
                body: {
                  expected_revision: local.value.serverRevision,
                  draft: parsed.data,
                  cover_asset_id: coverAssetId,
                },
              })
            : await save.mutateAsync({
                body: { id: draftId, draft: parsed.data, cover_asset_id: coverAssetId },
              });
        // A retried create can return its original record; bring it up to the current local content before publishing.
        const current =
          JSON.stringify(saved.character.draft) === JSON.stringify(parsed.data) &&
          saved.character.cover_asset_id === coverAssetId
            ? saved.character
            : (
                await save.mutateAsync({
                  id: saved.character.id,
                  body: {
                    expected_revision: saved.character.revision,
                    draft: parsed.data,
                    cover_asset_id: coverAssetId,
                  },
                })
              ).character;
        local.update((value) => ({ ...value, serverRevision: current.revision }));
        await local.flush();
        result = (
          await publish.mutateAsync({
            id: current.id,
            body: { expected_revision: current.revision, visibility },
          })
        ).character;
      }
      await local.clear();
      setPublished(result);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        local.setConflict(true);
        setNotice('这张角色卡已有更新，请载入最新版本后继续。当前内容已保留在本地。');
      } else
        setNotice(error instanceof Error ? error.message : '保存未完成，请重试。你的内容已保留。');
    } finally {
      busyRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function startChat() {
    if (!published || createChat.isPending) return;
    setNotice('');
    try {
      const data = await createChat.mutateAsync(published.id);
      router.push(chatEntryPath(published.id, { sessionId: data.session.id, source: 'created' }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '聊天暂时未打开，请重试。');
    }
  }

  if (!local.ready)
    return (
      <main className="mx-auto max-w-lg px-6 py-10 text-sm text-muted-foreground" role="status">
        正在恢复草稿…
      </main>
    );
  if (published)
    return (
      <main className="mx-auto flex min-h-[75svh] w-full max-w-lg flex-col items-center justify-center px-6 py-10 text-center">
        {published.cover_url && (
          <Image
            className="mb-6 aspect-[3/4] w-40 rounded-2xl object-cover"
            src={published.cover_url}
            alt={published.name}
            width={160}
            height={214}
            unoptimized
          />
        )}
        <span className="mb-4 grid size-11 place-items-center rounded-full bg-success/15 text-success">
          <Check className="size-5" />
        </span>
        <h1 className="text-xl font-medium text-foreground">{published.name}</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          {published.visibility === 'public'
            ? published.approved_revision
              ? '新版已提交审核，大厅仍展示原版。你可以先和新版角色聊聊。'
              : '已提交审核，通过后会出现在大厅。现在就可以和 TA 聊聊。'
            : '已放入自己的空间，现在就可以和 TA 聊聊。'}
        </p>
        <button
          type="button"
          disabled={createChat.isPending}
          onClick={() => void startChat()}
          className="mt-8 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {createChat.isPending && <LoaderCircle className="size-4 animate-spin" />}开始聊天
        </button>
        <Link
          className="mt-3 flex min-h-12 items-center justify-center text-sm text-foreground/80"
          href="/creation?tab=created"
        >
          返回我的创作
        </Link>
        {notice && (
          <p role="alert" className="mt-3 text-xs leading-7 text-destructive">
            {notice}
          </p>
        )}
      </main>
    );

  return (
    <main
      className="mx-auto w-full max-w-lg px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))]"
      onBlur={() => {
        void local.flush();
      }}
    >
      <header className="flex min-h-11 items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => void goBack()}
          disabled={busy}
          className="flex min-h-11 shrink-0 items-center gap-2 text-sm text-foreground disabled:opacity-50"
        >
          <ArrowLeft className="size-4" />
          {character ? '编辑角色' : '创建角色'}
        </button>
        <span
          role="status"
          className={cn(
            'text-right text-[10px] leading-5 text-muted-foreground',
            local.status === 'error' && 'text-destructive'
          )}
        >
          {local.status === 'saving'
            ? '保存中…'
            : local.status === 'saved'
              ? '草稿已保存到本地'
              : local.status === 'error'
                ? '本地保存暂不可用'
                : '草稿自动保存在本地'}
        </span>
      </header>
      {local.conflict && (
        <div
          className="mt-4 rounded-xl border border-warn/30 p-3 text-xs leading-6 text-warn"
          role="alert"
        >
          角色卡已有更新，本地草稿没有覆盖线上内容。
          <button
            className="ml-2 min-h-11 underline underline-offset-4"
            type="button"
            disabled={busy}
            onClick={() => setRecoveryOpen(true)}
          >
            载入最新版本
          </button>
        </div>
      )}
      {recoveryDraftId && (
        <p
          className="mt-3 rounded-xl border border-border px-3 py-2 text-xs leading-6 text-foreground/80"
          role="status"
        >
          刚才的修改已单独保留在我的创作。
          <Link
            href={`/creation/characters/new?draft=${recoveryDraftId}`}
            className="ml-2 inline-flex min-h-11 items-center underline underline-offset-4"
          >
            查看修改备份
          </Link>
        </p>
      )}
      <section className="mt-6" aria-labelledby="creator-cover">
        <h2 id="creator-cover" className="mb-4 scroll-mt-5 text-sm font-medium text-foreground">
          角色形象{requiredMark}
        </h2>
        <div className="flex flex-col items-center">
          <div
            className={cn(
              'relative aspect-[3/4] w-[min(61vw,224px)] rounded-[20px] border border-border bg-card p-1.5 shadow-lg shadow-black/10',
              showRequired && !coverAssetId && 'border-destructive/60'
            )}
          >
            {coverUrl ? (
              <button
                type="button"
                className="relative block size-full overflow-hidden rounded-[14px]"
                aria-label="全屏查看角色形象"
                onClick={() => setFullCover(true)}
              >
                <Image
                  src={coverUrl}
                  alt={draft.name ? `${draft.name}的角色形象` : '角色形象'}
                  className="size-full object-cover object-top"
                  fill
                  sizes="224px"
                  unoptimized
                />
                <Expand className="absolute bottom-2 right-2 size-8 rounded-lg bg-black/50 p-2 text-white" />
              </button>
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border bg-card text-xs text-muted-foreground">
                <ImagePlus className="size-9 text-primary" strokeWidth={1.2} />
                建立角色形象
              </div>
            )}
          </div>
          <div className="mt-3 grid w-[min(61vw,224px)] grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-secondary/50 text-[13px] text-primary disabled:opacity-40"
            >
              {upload.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              上传
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void generateCover()}
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-secondary/50 text-[13px] text-primary disabled:opacity-40"
            >
              {createStudio.isPending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {createStudio.isPending ? '进入中…' : '生成'}
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="上传角色封面"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void uploadCover(file);
            }}
          />
          {cover.isError && (
            <button
              type="button"
              className="mt-2 min-h-11 text-xs text-destructive"
              onClick={() => void cover.refetch()}
            >
              封面暂未加载，点击重试
            </button>
          )}
        </div>
      </section>
      <div className="mt-7">
        <label htmlFor="creator-name" className="text-sm font-medium text-foreground">
          名称{requiredMark}
        </label>
        <input
          id="creator-name"
          className={cn(
            INPUT,
            'mt-2.5',
            showRequired && !draft.name.trim() && 'border-destructive/60'
          )}
          required
          maxLength={120}
          autoComplete="off"
          value={draft.name}
          disabled={busy}
          aria-invalid={showRequired && !draft.name.trim()}
          placeholder="给角色或故事起个名字"
          onChange={(event) => change('name', event.target.value)}
        />
      </div>
      {FIELDS.map((field) => {
        const filesKey =
          field.key === 'background'
            ? 'backgroundFiles'
            : field.key === 'preset'
              ? 'presetFiles'
              : null;
        const files = filesKey ? draft[filesKey] : [];
        const canPolish = field.key === 'opening' || field.key === 'background';
        const invalid =
          showRequired && field.required && !draft[field.key].trim() && files.length === 0;
        const isPreset = field.key === 'preset';
        const importControl = filesKey && (
          <CreatorDocumentImport
            label={field.label}
            files={files}
            disabled={busy}
            onImport={(text, added) => {
              local.update((current) => ({
                ...current,
                draft: {
                  ...current.draft,
                  [field.key]: text
                    ? [current.draft[field.key], text].filter(Boolean).join('\n\n')
                    : current.draft[field.key],
                  [filesKey]: [...current.draft[filesKey], ...added],
                },
              }));
            }}
            onMessage={(message) =>
              setImportNotice((current) => ({ ...current, [field.key]: message }))
            }
          />
        );
        return (
          <section
            key={field.key}
            id={`creator-section-${field.key}`}
            className={cn('mt-6', field.divider && 'border-t border-border/70 pt-5')}
          >
            <div className="flex min-h-8 items-center justify-between gap-2">
              <label
                htmlFor={`creator-${field.key}`}
                className="scroll-mt-5 text-sm font-medium text-foreground"
              >
                {field.label}
                {field.required ? (
                  requiredMark
                ) : (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    {isPreset ? '破甲词' : '选填'}
                  </span>
                )}
              </label>
              {importControl}
            </div>
            {isPreset && (
              <p className="mt-1 text-xs leading-[22px] text-muted-foreground">
                用来引导模型的扮演和互动方式。不想自己写，可以直接复用下方的优质模板，也可以自行补充。
              </p>
            )}
            <div id={isPreset ? 'creator-preset-custom' : undefined}>
              <div className="relative mt-2.5">
                <textarea
                  id={`creator-${field.key}`}
                  className={cn(INPUT, 'resize-y pb-11', invalid && 'border-destructive/60')}
                  rows={field.rows}
                  value={draft[field.key]}
                  required={field.required && !files.length}
                  aria-invalid={invalid}
                  placeholder={field.placeholder}
                  disabled={busy}
                  onChange={(event) => change(field.key, event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing(field.key)}
                  aria-label={`全屏编辑${field.label}`}
                  className="absolute bottom-1 right-1 grid size-11 place-items-center rounded-lg bg-card text-muted-foreground"
                >
                  <Expand className="size-4" />
                </button>
              </div>
              {filesKey && (
                <CreatorDocumentAttachments
                  files={files}
                  disabled={busy}
                  onRemove={(id) =>
                    local.update((current) => ({
                      ...current,
                      draft: {
                        ...current.draft,
                        [filesKey]: current.draft[filesKey].filter((file) => file.id !== id),
                      },
                    }))
                  }
                />
              )}
            </div>
            {(field.key === 'background' || field.key === 'preset') && importNotice[field.key] && (
              <p className="mt-2 text-[11px] leading-6 text-muted-foreground" role="status">
                {importNotice[field.key]}
              </p>
            )}
            {isPreset && (
              <div className="mt-5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-normal text-muted-foreground">也可以用模板补充</h3>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {draft.selectedPresetIds?.length
                      ? `已选 ${draft.selectedPresetIds.length} · 可多选`
                      : '可多选'}
                  </span>
                </div>
                <CharacterPresetChoices
                  selected={draft.selectedPresetIds ?? []}
                  disabled={busy}
                  onChange={(selectedPresetIds) =>
                    local.update((current) => ({
                      ...current,
                      draft: { ...current.draft, selectedPresetIds },
                    }))
                  }
                />
              </div>
            )}
            {canPolish && (
              <div className="flex items-center justify-between gap-2">
                <span
                  className="flex flex-wrap items-center gap-x-2 text-[11px] leading-6 text-muted-foreground"
                  role="status"
                >
                  {polishFeedback[field.key as CharacterPolishTarget]}
                  {local.value.undo[field.key as CharacterPolishTarget] !== undefined && (
                    <button
                      type="button"
                      className="min-h-11 text-primary underline underline-offset-4"
                      disabled={busy}
                      onClick={() => {
                        const target = field.key as CharacterPolishTarget;
                        local.update((current) => {
                          const undo = { ...current.undo };
                          const original = undo[target];
                          delete undo[target];
                          return {
                            ...current,
                            undo,
                            draft: {
                              ...current.draft,
                              [target]: original ?? current.draft[target],
                            },
                          };
                        });
                        setPolishFeedback((current) => ({ ...current, [target]: '已恢复上一版' }));
                      }}
                    >
                      恢复上一版
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  className="flex min-h-11 shrink-0 items-center gap-1.5 pl-3 text-xs text-primary disabled:opacity-40"
                  disabled={busy || (session?.state === 'loading' && session.target !== field.key)}
                  onClick={() => void polish(field.key as CharacterPolishTarget)}
                  aria-label={`AI 润色${field.label}`}
                >
                  <Sparkles className="size-4" />
                  {session?.target === field.key && session.state === 'loading'
                    ? '润色中…'
                    : local.value.polishCandidates[field.key as CharacterPolishTarget]
                      ? '查看润色结果'
                      : 'AI 润色'}
                </button>
              </div>
            )}
          </section>
        );
      })}
      <section className="mt-6 border-t border-border/70 pt-6">
        <fieldset>
          <legend id="creator-tags" className="mb-3 scroll-mt-5 text-sm font-medium text-foreground">
            标签{requiredMark}
            <span className="ml-2 text-[11px] font-normal tabular-nums text-muted-foreground">
              {draft.tags.length} / 10
            </span>
          </legend>
          <div
            className={cn(
              'flex flex-wrap gap-x-2 gap-y-1',
              showRequired &&
                !draft.tags.length &&
                'rounded-xl outline outline-1 outline-offset-4 outline-destructive/40'
            )}
          >
            {[...TAGS, ...draft.tags.filter((tag) => !TAGS.includes(tag))].map((tag) => (
              <label
                className="relative inline-flex min-h-11 cursor-pointer items-center"
                key={tag}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={draft.tags.includes(tag)}
                  disabled={busy || (draft.tags.length >= 10 && !draft.tags.includes(tag))}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    local.update((current) => ({
                      ...current,
                      draft: {
                        ...current.draft,
                        tags: checked
                          ? current.draft.tags.length < 10
                            ? [...current.draft.tags, tag]
                            : current.draft.tags
                          : current.draft.tags.filter((value) => value !== tag),
                      },
                    }));
                  }}
                />
                <span className="inline-flex min-h-9 min-w-14 items-center justify-center rounded-full border border-input bg-card px-3 text-xs text-muted-foreground peer-checked:border-primary/50 peer-checked:bg-primary/10 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-40">
                  {tag}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-7">
          <legend className="mb-3 text-sm font-medium text-foreground">可见性{requiredMark}</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {(['public', 'private'] as const).map((value) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name="creator-visibility"
                  className="peer sr-only"
                  checked={visibility === value}
                  disabled={busy}
                  onChange={() => local.update((current) => ({ ...current, visibility: value }))}
                />
                <span className="flex min-h-12 items-center justify-between rounded-xl border border-input bg-card px-3.5 text-[13px] text-foreground peer-checked:border-primary/60 peer-checked:bg-primary/10 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                  {value === 'public' ? '公开' : '私密'}
                  <span
                    className={cn(
                      'size-3.5 rounded-full border border-muted-foreground/60',
                      visibility === value && 'border-4 border-primary'
                    )}
                  />
                </span>
                <span className="mt-2 block px-1 text-[11px] leading-6 text-muted-foreground">
                  {value === 'public' ? '审核后进入大厅' : '进入自己的空间，只有自己能看到'}
                </span>
              </label>
            ))}
          </div>
          {character?.published_revision && visibility === 'private' ? (
            <p className="mt-3 text-[11px] leading-6 text-muted-foreground">
              已收藏或使用过这张卡的用户仍可继续聊天。
            </p>
          ) : null}
        </fieldset>
      </section>
      <section className="mt-8 border-t border-border/70 pt-5">
        {showRequired && missingFields.length > 0 && (
          <div id="creator-missing" role="alert" className="mb-3 text-xs leading-7 text-destructive">
            <span>请补全必填项：</span>
            <div className="flex flex-wrap gap-x-3">
              {missingFields.map((field) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => focusMissing(field)}
                  className="min-h-11 underline underline-offset-4"
                >
                  {field}
                </button>
              ))}
            </div>
          </div>
        )}
        {notice && (
          <p role="alert" className="mb-3 text-xs leading-7 text-destructive">
            {notice}
          </p>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || unchanged || session?.state === 'loading'}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-primary/30 bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {busy ? '正在保存…' : unchanged ? '没有新修改' : submitLabel}
        </button>
      </section>
      {recoveryOpen && (
        <CharacterEditorModal
          compact
          title="载入最新版本"
          onClose={() => {
            if (!busy) setRecoveryOpen(false);
          }}
        >
          <div className="px-5 py-6 text-sm leading-7 text-foreground/80">
            <p>
              会先将当前修改保留为一份本地备份，再载入最新角色资料。之后仍可在「我的创作」里找到这份备份。
            </p>
            {notice && (
              <p role="alert" className="mt-3 text-destructive">
                {notice}
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadLatestKeepingBackup()}
              className="mt-6 min-h-12 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? '正在保留修改…' : '保留修改并载入'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRecoveryOpen(false)}
              className="mt-2 min-h-12 w-full text-sm"
            >
              继续编辑当前稿
            </button>
          </div>
        </CharacterEditorModal>
      )}
      {editing && (
        <CharacterFullscreenEditor
          title={FIELDS.find((field) => field.key === editing)!.label}
          value={draft[editing]}
          placeholder={FIELDS.find((field) => field.key === editing)!.placeholder}
          onChange={(text) => change(editing, text)}
          onClose={() => {
            setEditing(null);
            void local.flush();
          }}
        />
      )}
      {fullCover && coverUrl && (
        <CharacterEditorModal title="角色形象" onClose={() => setFullCover(false)}>
          <div className="relative min-h-0 w-full flex-1 pb-[env(safe-area-inset-bottom)]">
            <Image
              src={coverUrl}
              alt={draft.name || '角色形象'}
              fill
              sizes="100vw"
              unoptimized
              className="object-contain"
            />
          </div>
        </CharacterEditorModal>
      )}
      {session && polishOpen && (
        <CharacterPolishDialog
          session={session}
          onClose={closePolish}
          onDiscard={discardPolish}
          onRetry={() => void polish(session.target, true)}
          onEdit={(result) => {
            if (sessionRef.current) keepPolish({ ...sessionRef.current, result });
          }}
          onApply={() => {
            if (session.state === 'loading' || !session.result.trim()) return;
            const { target, result } = session;
            local.update((current) => {
              const candidates = { ...current.polishCandidates };
              delete candidates[target];
              return {
                ...current,
                draft: { ...current.draft, [target]: result },
                undo: { ...current.undo, [target]: current.draft[target] },
                polishCandidates: candidates,
              };
            });
            setPolishFeedback((current) => ({ ...current, [target]: '已采用润色内容' }));
            sessionRef.current = null;
            setSession(null);
            closePolish();
          }}
        />
      )}
    </main>
  );
}
