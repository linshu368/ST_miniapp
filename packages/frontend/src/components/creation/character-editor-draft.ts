import {
  CreatorPresetIdSchema,
  emptyCharacterDraft,
  type CharacterDraft,
  type CreatorCharacter,
  type CreatorVisibility,
} from '@miniapp/shared';
import {
  parseCharacterPolishCandidates,
  type CharacterPolishCandidates,
} from './character-editor-polish';

export interface CharacterEditorDraft {
  draft: CharacterDraft;
  visibility: CreatorVisibility;
  coverAssetId: string | null;
  coverUrl: string | null;
  serverRevision: number | null;
  undo: Partial<Record<'opening' | 'background', string>>;
  polishCandidates: CharacterPolishCandidates;
  baselineFingerprint?: string;
  coverStudioId?: string | null;
  recoveryFor?: string | null;
}
export interface StoredCharacterDraft extends CharacterEditorDraft {
  version: 1;
  key: string;
  ownerId: string;
  draftId: string;
  characterId: string | null;
  updatedAt: number;
}
export interface CharacterDraftScope {
  ownerId: string;
  draftId: string;
  characterId?: string;
}

const DATABASE = 'st-character-creator';
const STORE = 'drafts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let database: IDBDatabase | undefined;
let opening: Promise<IDBDatabase> | undefined;

export function characterDraftKey(scope: CharacterDraftScope): string {
  return `${scope.ownerId}:${scope.characterId ? 'edit' : 'new'}:${scope.characterId ?? scope.draftId}`;
}

export function initialCharacterEditorDraft(character?: CreatorCharacter): CharacterEditorDraft {
  const value: CharacterEditorDraft = {
    draft: { ...emptyCharacterDraft(), ...character?.draft },
    visibility: character?.visibility ?? 'private',
    coverAssetId: character?.cover_asset_id ?? null,
    coverUrl: character?.cover_url ?? null,
    serverRevision: character?.revision ?? null,
    undo: {},
    polishCandidates: {},
    coverStudioId: null,
    recoveryFor: null,
  };
  value.baselineFingerprint = fingerprintCharacterDraft(value);
  return value;
}

/** Local change indication only; server revisions and actual payloads still govern writes. */
export function fingerprintCharacterDraft(
  value: Pick<CharacterEditorDraft, 'draft' | 'coverAssetId' | 'visibility'>
): string {
  const { draft } = value;
  const files = (items: CharacterDraft['backgroundFiles']) =>
    items.map(({ id, name, content }) => ({ id, name, content }));
  const intent = JSON.stringify({
    name: draft.name,
    description: draft.description,
    opening: draft.opening,
    background: draft.background,
    preset: draft.preset,
    tags: draft.tags,
    selectedPresetIds: [...(draft.selectedPresetIds ?? [])].sort(),
    backgroundFiles: files(draft.backgroundFiles),
    presetFiles: files(draft.presetFiles),
    coverAssetId: value.coverAssetId,
    visibility: value.visibility,
  });
  // Two independent fast accumulators avoid duplicating lengthy source files in every baseline.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < intent.length; index += 1) {
    const code = intent.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca77);
  }
  return `v1:${intent.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

export function getCharacterDraftChangeState(
  value: CharacterEditorDraft
): 'changed' | 'unchanged' | 'unknown' {
  if (!value.baselineFingerprint?.startsWith('v1:')) return 'unknown';
  return fingerprintCharacterDraft(value) === value.baselineFingerprint ? 'unchanged' : 'changed';
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return Promise.resolve(database);
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result
          .createObjectStore(STORE, { keyPath: 'key' })
          .createIndex('ownerId', 'ownerId');
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('本地草稿存储暂不可用。'));
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => {
        database?.close();
        database = undefined;
        opening = undefined;
      };
      resolve(database);
    };
  }).catch((error) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/** Local recovery keeps over-limit text so users can shorten it; publication validates server limits. */
export function parseLocalCharacterDraft(value: unknown): CharacterDraft {
  if (!value || typeof value !== 'object') throw new Error('本地草稿格式不正确。');
  const source = value as Record<string, unknown>;
  const draft = emptyCharacterDraft();
  for (const key of ['name', 'description', 'opening', 'background', 'preset'] as const) {
    const text = source[key];
    if (typeof text !== 'string') throw new Error('本地草稿文字不完整。');
    draft[key] = text;
  }
  if (!Array.isArray(source.tags)) throw new Error('本地草稿标签不完整。');
  draft.tags = source.tags.map((tag: unknown) => {
    if (typeof tag !== 'string') throw new Error('本地草稿标签不正确。');
    return tag;
  });
  const selected = CreatorPresetIdSchema.array().safeParse(source.selectedPresetIds ?? []);
  if (!selected.success) throw new Error('本地草稿预设选项不正确。');
  draft.selectedPresetIds = [...new Set(selected.data)];
  for (const key of ['backgroundFiles', 'presetFiles'] as const) {
    const files = source[key];
    if (!Array.isArray(files)) throw new Error('本地草稿文件不完整。');
    draft[key] = files.map((file: unknown) => {
      if (!file || typeof file !== 'object') throw new Error('本地草稿文件不正确。');
      const record = file as Record<string, unknown>;
      if (
        typeof record.id !== 'string' ||
        typeof record.name !== 'string' ||
        typeof record.content !== 'string'
      )
        throw new Error('本地草稿文件不正确。');
      return { id: record.id, name: record.name, content: record.content };
    });
  }
  return draft;
}

export function parseStoredCharacterDraft(
  value: unknown,
  scope: CharacterDraftScope
): StoredCharacterDraft | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new Error('无法读取本地草稿。');
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    source.ownerId !== scope.ownerId ||
    source.key !== characterDraftKey(scope)
  )
    throw new Error('本地草稿身份不匹配。');
  const draft = parseLocalCharacterDraft(source.draft);
  if (source.visibility !== 'private' && source.visibility !== 'public')
    throw new Error('本地草稿格式不正确。');
  const undo: CharacterEditorDraft['undo'] = {};
  if (source.undo && typeof source.undo === 'object') {
    for (const field of ['opening', 'background'] as const) {
      const text = (source.undo as Record<string, unknown>)[field];
      if (typeof text === 'string') undo[field] = text;
    }
  }
  return {
    version: 1,
    key: characterDraftKey(scope),
    ownerId: scope.ownerId,
    draftId: scope.draftId,
    characterId: scope.characterId ?? null,
    draft,
    visibility: source.visibility,
    coverAssetId: typeof source.coverAssetId === 'string' ? source.coverAssetId : null,
    coverUrl: typeof source.coverUrl === 'string' ? source.coverUrl : null,
    serverRevision: typeof source.serverRevision === 'number' ? source.serverRevision : null,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : 0,
    undo,
    polishCandidates: parseCharacterPolishCandidates(source.polishCandidates),
    baselineFingerprint:
      typeof source.baselineFingerprint === 'string' && source.baselineFingerprint.startsWith('v1:')
        ? source.baselineFingerprint
        : undefined,
    coverStudioId:
      typeof source.coverStudioId === 'string' && UUID.test(source.coverStudioId)
        ? source.coverStudioId
        : null,
    recoveryFor:
      typeof source.recoveryFor === 'string' && UUID.test(source.recoveryFor)
        ? source.recoveryFor
        : null,
  };
}

export async function loadCharacterDraft(
  scope: CharacterDraftScope
): Promise<StoredCharacterDraft | null> {
  const db = await openDatabase();
  const value: unknown = await new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .get(characterDraftKey(scope));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return parseStoredCharacterDraft(value, scope);
}

function persist(
  db: IDBDatabase,
  scope: CharacterDraftScope,
  value: CharacterEditorDraft
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const record: StoredCharacterDraft = {
      ...value,
      version: 1,
      key: characterDraftKey(scope),
      ownerId: scope.ownerId,
      draftId: scope.draftId,
      characterId: scope.characterId ?? null,
      updatedAt: Date.now(),
    };
    transaction.objectStore(STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('本地草稿保存中断。'));
  });
}

export function saveCharacterDraft(
  scope: CharacterDraftScope,
  value: CharacterEditorDraft
): Promise<void> {
  return database
    ? persist(database, scope, value)
    : openDatabase().then((db) => persist(db, scope, value));
}

export async function deleteCharacterDraft(scope: CharacterDraftScope): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(characterDraftKey(scope));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function listCharacterDrafts(ownerId: string): Promise<StoredCharacterDraft[]> {
  const db = await openDatabase();
  const values: unknown[] = await new Promise((resolve, reject) => {
    const request = db
      .transaction(STORE, 'readonly')
      .objectStore(STORE)
      .index('ownerId')
      .getAll(ownerId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return values
    .flatMap((value) => {
      try {
        if (!value || typeof value !== 'object') return [];
        const record = value as Record<string, unknown>;
        if (typeof record.draftId !== 'string') return [];
        const parsed = parseStoredCharacterDraft(value, {
          ownerId,
          draftId: record.draftId,
          characterId: typeof record.characterId === 'string' ? record.characterId : undefined,
        });
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
