'use client';

import { Heart, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { CharacterCard } from '@/components/characters/character-card';
import { useFavoritesQuery } from '@/lib/api/favorites';

export default function FavoritesPage() {
  const router = useRouter();
  const favorites = useFavoritesQuery();

  return (
    <main className="min-h-dvh bg-background px-4 pb-28 pt-6 text-foreground">
      <header className="mx-auto mb-5 max-w-4xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Collection</p>
        <h1 className="mt-1 text-2xl font-bold">收藏角色</h1>
        <p className="mt-1 text-sm text-muted-foreground">你收藏的角色会在首页和聊天页保持同步。</p>
      </header>

      <section className="mx-auto max-w-4xl">
        {favorites.isLoading ? (
          <div className="rounded-3xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            正在加载收藏…
          </div>
        ) : null}

        {favorites.error ? (
          <div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-5">
            <p className="text-sm text-destructive">{favorites.error.message}</p>
            <button
              type="button"
              onClick={() => void favorites.refetch()}
              className="mt-3 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              <RefreshCw className="h-4 w-4" />
              重试
            </button>
          </div>
        ) : null}

        {!favorites.isLoading && !favorites.error && favorites.data?.characters.length === 0 ? (
          <div className="rounded-3xl border border-border bg-card p-8 text-center">
            <Heart className="mx-auto h-9 w-9 text-primary" />
            <h2 className="mt-3 font-semibold">还没有收藏角色</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              在大厅或聊天页点击收藏按钮即可加入这里。
            </p>
            <button
              type="button"
              onClick={() => router.push('/')}
              className="mt-4 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              去大厅看看
            </button>
          </div>
        ) : null}

        {favorites.data?.characters.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {favorites.data.characters.map((character) => (
              <CharacterCard
                key={character.id}
                character={character}
                onSelect={(id) => router.push(`/tavern/${id}`)}
              />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
