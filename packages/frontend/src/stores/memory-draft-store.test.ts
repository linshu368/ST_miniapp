import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activeMemoryDraft, MEMORY_DRAFT_TTL_MS, useMemoryDraftStore } from './memory-draft-store';

beforeEach(() => {
  vi.useRealTimers();
  useMemoryDraftStore.setState({ entries: {}, revision: 0 });
});

describe('temporary composer drafts', () => {
  it('isolates users, conversations and modules, including deliberately empty drafts', () => {
    const store = useMemoryDraftStore.getState();
    store.write('u1:chat:a', '故事A');
    store.write('u1:chat:b', '故事B');
    store.write('u2:chat:a', '另一个用户');
    store.write('u1:image-plaza:a', '');
    const entries = useMemoryDraftStore.getState().entries;
    expect(entries['u1:chat:a']?.text).toBe('故事A');
    expect(entries['u1:chat:b']?.text).toBe('故事B');
    expect(entries['u2:chat:a']?.text).toBe('另一个用户');
    expect(activeMemoryDraft(entries['u1:image-plaza:a'])?.text).toBe('');
  });

  it('keeps newer edits when an older submission succeeds, even when text returns to A', () => {
    const store = useMemoryDraftStore.getState();
    store.write('u1:chat:a', 'A');
    const submittedRevision = useMemoryDraftStore.getState().entries['u1:chat:a']!.revision;
    store.write('u1:chat:a', 'B');
    store.write('u1:chat:a', 'A');
    store.clearIfUnchanged('u1:chat:a', 'A', submittedRevision, '');
    expect(useMemoryDraftStore.getState().entries['u1:chat:a']?.text).toBe('A');
  });

  it('clears only the unchanged submitted draft and keeps an empty override for its snapshot', () => {
    const store = useMemoryDraftStore.getState();
    store.write('u1:image:a', '本次内容');
    store.write('u1:image:b', '别的内容');
    const revision = useMemoryDraftStore.getState().entries['u1:image:a']!.revision;
    store.clearIfUnchanged('u1:image:a', '本次内容', revision, '旧的快照');
    expect(useMemoryDraftStore.getState().entries['u1:image:a']?.text).toBe('');
    expect(useMemoryDraftStore.getState().entries['u1:image:b']?.text).toBe('别的内容');
  });

  it('expires old content and bounds memory when many characters are tried', () => {
    vi.useFakeTimers();
    const store = useMemoryDraftStore.getState();
    store.write('old', '旧内容');
    vi.advanceTimersByTime(MEMORY_DRAFT_TTL_MS + 1);
    expect(activeMemoryDraft(useMemoryDraftStore.getState().entries.old)).toBeUndefined();
    for (let index = 0; index < 80; index += 1) store.write(`chat:${index}`, String(index));
    const entries = useMemoryDraftStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(64);
    expect(entries.old).toBeUndefined();
  });
});
