import { CharacterGallery } from '@/components/characters/character-gallery';

export default function CharactersPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100dvh-var(--app-nav-space))] w-full max-w-screen-xl flex-col">
      <CharacterGallery />
    </main>
  );
}
