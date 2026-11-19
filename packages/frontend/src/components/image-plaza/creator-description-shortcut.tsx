'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { IMAGE_PLAZA_PROMPT_MAX_CHARS } from '@miniapp/shared';
import { useCreatorCharactersQuery } from '@/lib/api/creator-characters';

// Only mounted for a validated return route from the character editor.
export function CreatorDescriptionShortcut({
  returnPath,
  prompt,
  onInsert,
}: {
  returnPath: string;
  prompt: string;
  onInsert: (text: string, clipped: boolean) => void;
}) {
  const ownerId = useCreatorCharactersQuery().data?.owner_user_id;
  const { data: description } = useQuery({
    queryKey: ['creator-cover-description', ownerId, returnPath],
    enabled: Boolean(ownerId),
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (!ownerId) return '';
      const url = new URL(returnPath, window.location.origin);
      const characterId = url.pathname.endsWith('/edit') ? url.pathname.split('/')[3] : undefined;
      const draftId = characterId ?? url.searchParams.get('draft');
      if (!draftId) return '';
      const { loadCharacterDraft } = await import('@/components/creation/character-editor-draft');
      const local = await loadCharacterDraft({ ownerId, draftId, characterId });
      return local?.draft.description.trim() ?? '';
    },
  });
  if (!description || prompt.includes(description)) return null;
  const prefix = prompt.trim() ? prompt + '\n\n' : '';
  const remaining = IMAGE_PLAZA_PROMPT_MAX_CHARS - prefix.length;
  const excerpt = description.slice(0, Math.max(0, remaining)).replace(/[\uD800-\uDBFF]$/u, '');
  if (!excerpt) return null;
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-primary"
      onClick={() => onInsert(prefix + excerpt, excerpt.length < description.length)}
    >
      <Plus size={14} aria-hidden />
      {prompt.trim() ? '追加角色描述' : '带入角色描述'}
    </button>
  );
}
