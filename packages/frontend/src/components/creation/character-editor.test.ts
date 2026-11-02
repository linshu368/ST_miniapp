import { describe, expect, it } from 'vitest';
import { emptyCharacterDraft } from '@miniapp/shared';
import {
  characterDraftKey,
  fingerprintCharacterDraft,
  getCharacterDraftChangeState,
  initialCharacterEditorDraft,
  parseLocalCharacterDraft,
  parseStoredCharacterDraft,
} from './character-editor-draft';
import { documentLength, parseCreatorDocument } from './character-editor-import';
import { parseCharacterPolishCandidates } from './character-editor-polish';

describe('creator document import and local draft boundaries', () => {
  it('puts 200 meaningful characters inline and retains a longer file as an attachment', () => {
    expect(parseCreatorDocument('短.txt', `\uFEFF${'字'.repeat(200)}\n `).inline).toBe(true);
    expect(parseCreatorDocument('长.txt', '字'.repeat(201)).inline).toBe(false);
    expect(documentLength('海\n 风　✨')).toBe(3);
  });

  it('preserves complete JSON documents and rejects malformed or empty imports', () => {
    const source = { biography: '海'.repeat(201), details: ['风', '灯塔'] };
    const result = parseCreatorDocument('角色.json', JSON.stringify(source));
    expect(result.content).toBe(JSON.stringify(source, null, 2));
    expect(result.inline).toBe(false);
    expect(() => parseCreatorDocument('错误.json', '{')).toThrow('JSON 格式不正确');
    expect(() => parseCreatorDocument('空.txt', '  \n')).toThrow('空文件');
    expect(() => parseCreatorDocument('错误.png', 'text')).toThrow('TXT 或 JSON');
  });

  it('isolates separate users and drafts while keeping a stable key for editing one character', () => {
    const base = { ownerId: 'user-a', draftId: 'draft-a' };
    const key = characterDraftKey(base);
    expect(characterDraftKey({ ...base, ownerId: 'user-b' })).not.toBe(key);
    expect(characterDraftKey({ ...base, draftId: 'draft-b' })).not.toBe(key);
    expect(characterDraftKey({ ...base, characterId: 'draft-a' })).not.toBe(key);
    expect(characterDraftKey({ ...base, characterId: 'character-a' })).toBe(
      characterDraftKey({ ...base, draftId: 'another-url-draft', characterId: 'character-a' })
    );
  });

  it('restores unfinished over-limit text so correcting a validation error never loses the original', () => {
    const draft = { ...emptyCharacterDraft(), opening: '字'.repeat(20_001) };
    expect(parseLocalCharacterDraft(draft).opening).toBe(draft.opening);
    expect(() => parseLocalCharacterDraft({ ...draft, opening: null })).toThrow('文字不完整');
  });

  it('restores preset selections alongside custom text and accepts older drafts without selections', () => {
    const draft = {
      ...emptyCharacterDraft(),
      preset: '保留我自己写的内容',
      selectedPresetIds: ['world-causality', 'player-boundaries'],
    };
    expect(parseLocalCharacterDraft(draft)).toMatchObject(draft);
    const { selectedPresetIds: _selected, ...olderDraft } = draft;
    expect(parseLocalCharacterDraft(olderDraft)).toMatchObject({
      preset: draft.preset,
      selectedPresetIds: [],
    });
  });
});

describe('creator polish candidates and local editing baseline', () => {
  it('restores separate opening and background candidates including manual edits', () => {
    const opening = {
      target: 'opening',
      original: '开场原稿',
      result: '润色后由用户加了一句',
      state: 'ready',
      error: '',
    };
    const background = {
      target: 'background',
      original: '背景原稿',
      result: '不完整但有用的背景',
      state: 'error',
      error: '网络中断',
    };
    expect(parseCharacterPolishCandidates({ opening, background })).toEqual({
      opening,
      background,
    });
  });

  it('keeps interrupted text for adoption without restoring a forever-loading state', () => {
    const restored = parseCharacterPolishCandidates({
      opening: { target: 'opening', original: '原稿', result: '收到的一半内容', state: 'loading' },
      background: { target: 'background', original: '原稿', result: '', state: 'loading' },
    });
    expect(restored.opening).toMatchObject({
      state: 'error',
      result: '收到的一半内容',
      original: '原稿',
    });
    expect(restored.opening?.error).toContain('可以采用');
    expect(restored.background).toBeUndefined();
  });

  it('loads old drafts without new metadata and rejects invalid route identifiers safely', () => {
    const scope = { ownerId: 'owner-a', draftId: 'draft-a' };
    const record = {
      version: 1,
      key: characterDraftKey(scope),
      ...scope,
      characterId: null,
      updatedAt: 1,
      draft: { ...emptyCharacterDraft(), background: '保留已有背景' },
      visibility: 'private',
      coverAssetId: null,
      coverUrl: null,
      serverRevision: 3,
      undo: { opening: '采用前的开场' },
    };
    const restored = parseStoredCharacterDraft(record, scope);
    expect(restored).toMatchObject({
      draft: { background: '保留已有背景' },
      polishCandidates: {},
      coverStudioId: null,
      recoveryFor: null,
      undo: record.undo,
    });
    expect(restored?.baselineFingerprint).toBeUndefined();
    expect(getCharacterDraftChangeState(restored!)).toBe('unknown');
    const studioId = '11111111-1111-4111-8111-111111111111';
    expect(
      parseStoredCharacterDraft(
        { ...record, coverStudioId: studioId, recoveryFor: '/wrong' },
        scope
      )
    ).toMatchObject({ coverStudioId: studioId, recoveryFor: null });
  });

  it('tracks authored intent while ignoring previews, candidates, undo and revision changes', () => {
    const value = initialCharacterEditorDraft();
    expect(getCharacterDraftChangeState(value)).toBe('unchanged');
    expect(
      getCharacterDraftChangeState({ ...value, draft: { ...value.draft, opening: '新开场' } })
    ).toBe('changed');
    expect(getCharacterDraftChangeState({ ...value, coverAssetId: 'new-cover' })).toBe('changed');
    expect(getCharacterDraftChangeState({ ...value, visibility: 'public' })).toBe('changed');
    expect(
      fingerprintCharacterDraft({
        ...value,
        draft: { ...value.draft, selectedPresetIds: ['world-causality', 'player-boundaries'] },
      })
    ).toBe(
      fingerprintCharacterDraft({
        ...value,
        draft: { ...value.draft, selectedPresetIds: ['player-boundaries', 'world-causality'] },
      })
    );
    expect(
      getCharacterDraftChangeState({
        ...value,
        coverUrl: 'https://example.test/new-signed-preview',
        serverRevision: 8,
        coverStudioId: '11111111-1111-4111-8111-111111111111',
        undo: { opening: '旧内容' },
        polishCandidates: {
          opening: {
            target: 'opening',
            original: '',
            result: '尚未采用的文本',
            state: 'ready',
            error: '',
          },
        },
      })
    ).toBe('unchanged');
  });
});
