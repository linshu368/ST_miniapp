import { CharacterGallery } from '@/components/characters/character-gallery';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col">
      <CharacterGallery />
    </main>
  );
}
