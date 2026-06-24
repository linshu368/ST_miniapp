'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { platformAction, useSTMirror } from '@/lib/bridge';

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const generationPhase = useSTMirror((s) => s.generationPhase);

  useEffect(() => {
    async function switchCharacter() {
      const avatar = await resolveAvatarByPlatformId(characterId);
      if (avatar) {
        await platformAction('selectCharacter', { avatar });
      }
    }
    switchCharacter();
  }, [characterId]);

  return (
    <div className="relative w-full h-full">
      {/* iframe visibility is controlled by BridgeProvider's isVisible */}
      <div className="absolute top-0 left-0 right-0 z-20">
        {/* Toolbar placeholder — will be implemented in a later phase */}
      </div>
    </div>
  );
}

// 不确定：具体 API 路径和返回结构取决于 backend /api/characters/:id 的实现
async function resolveAvatarByPlatformId(id: string): Promise<string | null> {
  // TODO: Call backend API or read from React Query cache to resolve
  // the platform character DB id → ST avatar filename mapping.
  return null;
}
