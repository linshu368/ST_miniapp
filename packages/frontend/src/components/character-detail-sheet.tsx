'use client';

import { useCharacterDetail } from '@/hooks/use-character-detail';

interface CharacterDetailSheetProps {
  characterId: string;
  onClose: () => void;
  onStartChat: (characterId: string) => void;
}

export function CharacterDetailSheet({
  characterId,
  onClose,
  onStartChat,
}: CharacterDetailSheetProps) {
  const { character, loading } = useCharacterDetail(characterId);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-end z-50">
        <div className="w-full bg-gray-900 rounded-t-2xl p-6 text-center">
          <p className="text-gray-400">加载中...</p>
        </div>
      </div>
    );
  }

  if (!character) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end z-50" onClick={onClose}>
      <div
        className="w-full bg-gray-900 rounded-t-2xl p-6 max-h-screen overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部拖拽指示条 */}
        <div className="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-6" />

        {/* 头像 + 名称 */}
        <div className="flex items-center gap-4 mb-4">
          <div className="w-16 h-16 rounded-full bg-gray-600 flex-shrink-0 flex items-center justify-center text-2xl">
            {character.name.charAt(0)}
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{character.name}</h2>
            <div className="flex flex-wrap gap-1 mt-1">
              {character.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* 描述 */}
        <p className="text-gray-300 text-sm mb-4">{character.description}</p>

        {/* 开场白预览 */}
        <div className="bg-gray-800 rounded-xl p-4 mb-6">
          <p className="text-xs text-gray-500 mb-2">开场白</p>
          <p className="text-gray-200 text-sm italic">"{character.greeting}"</p>
        </div>

        {/* 开始聊天按钮 */}
        <button
          onClick={() => onStartChat(character.id)}
          className="w-full bg-indigo-600 text-white font-semibold py-3 rounded-xl active:bg-indigo-700 transition-colors"
        >
          开始聊天
        </button>
      </div>
    </div>
  );
}