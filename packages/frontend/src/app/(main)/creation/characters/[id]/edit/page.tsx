import { Suspense } from 'react';
import { CharacterEditorPage } from '@/components/creation/character-editor';

export default function EditCharacterPage({ params }: { params: { id: string } }) {
  return (
    <Suspense
      fallback={<p className="px-6 py-10 text-sm text-muted-foreground">正在准备角色资料…</p>}
    >
      <CharacterEditorPage characterId={params.id} />
    </Suspense>
  );
}
