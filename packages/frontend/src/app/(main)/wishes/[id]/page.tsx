import { Suspense } from 'react';
import { CharacterWishDetailPage } from '@/components/creation/character-wishes';

export default function WishPage({ params }: { params: { id: string } }) {
  return (
    <Suspense fallback={<p className="px-6 py-10 text-sm text-muted-foreground">正在打开心愿…</p>}>
      <CharacterWishDetailPage id={params.id} />
    </Suspense>
  );
}
