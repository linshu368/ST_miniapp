'use client';

import type { CharacterSummary } from '@miniapp/shared';

interface CharacterCardProps {
  character: CharacterSummary;
  onClick: (id: string) => void;
}

export function CharacterCard({ character, onClick }: CharacterCardProps) {
  return (
    <button
      onClick={() => onClick(character.id)}
      className="w-full bg-gray-800 rounded-xl p-4 text-left active:bg-gray-700 transition-colors"
    >
      <div className="flex items-start gap-3">
        {/* 头像占位 */}
        <div className="w-12 h-12 rounded-full bg-gray-600 flex-shrink-0 flex items-center justify-center text-lg">
          {character.name.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate">{character.name}</h3>
          <p className="text-sm text-gray-400 mt-1 line-clamp-2">{character.description}</p>
          {character.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {character.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}