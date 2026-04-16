'use client';

import { useState } from 'react';
import { useCharacters } from '@/hooks/use-characters';
import { CharacterCard } from '@/components/character-card';
import { CharacterDetailSheet } from '@/components/character-detail-sheet';

export default function HomePage() {
  const { characters, loading } = useCharacters();
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);

  return (
    <main className="min-h-screen bg-black">
      {/* 顶部标题栏 */}
      <header className="sticky top-0 bg-black/80 backdrop-blur-sm border-b border-gray-800 px-4 py-3 z-40">
        <h1 className="text-lg font-bold text-white">选择角色</h1>
      </header>

      {/* 角色列表 */}
      <div className="px-4 py-4 space-y-3">
        {loading ? (
          <div className="text-center text-gray-400 py-20">加载中...</div>
        ) : characters.length === 0 ? (
          <div className="text-center text-gray-400 py-20">暂无角色</div>
        ) : (
          characters.map((character) => (
            <CharacterCard
              key={character.id}
              character={character}
              onClick={setSelectedCharacterId}
            />
          ))
        )}
      </div>

      {/* 角色详情底部弹出层 */}
      {selectedCharacterId && (
        <CharacterDetailSheet
          characterId={selectedCharacterId}
          onClose={() => setSelectedCharacterId(null)}
          onStartChat={(id) => {
            // 后续接入对话页路由
            console.log('Start chat with:', id);
            setSelectedCharacterId(null);
          }}
        />
      )}
    </main>
  );
}