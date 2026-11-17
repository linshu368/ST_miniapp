import { Suspense } from 'react';
import { CharacterWishesPage } from '@/components/creation/character-wishes';

export default function WishesPage() {
  return (
    <Suspense
      fallback={<p className="px-6 py-10 text-sm text-muted-foreground">正在打开心愿墙…</p>}
    >
      <CharacterWishesPage />
    </Suspense>
  );
}
