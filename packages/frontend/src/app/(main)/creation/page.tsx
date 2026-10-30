import { Suspense } from 'react';
import { CreationHub } from '@/components/creation/creation-hub';

export default function CreationPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-lg px-4 pt-6" aria-busy="true">
          <h1 className="text-2xl font-semibold">创作</h1>
        </main>
      }
    >
      <CreationHub />
    </Suspense>
  );
}
