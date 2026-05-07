// Showdown extension: 单 `_word_` 转 <em>(对中日韩等无空格语言友好)
// 移植自 SillyTavern public/scripts/showdown-underscore.js
import type { ShowdownExtension } from 'showdown';

function canUseNegativeLookbehind(): boolean {
  try {
    new RegExp('(?<!_)');
    return true;
  } catch {
    return false;
  }
}

export function markdownUnderscoreExt(): ShowdownExtension[] {
  if (!canUseNegativeLookbehind()) return [];
  return [
    {
      type: 'output',
      regex: new RegExp(
        '(<code(?:\\s+[^>]*)?>[\\s\\S]*?<\\/code>|<style(?:\\s+[^>]*)?>[\\s\\S]*?<\\/style>)|\\b(?<!_)_(?!_)(.*?)(?<!_)_(?!_)\\b',
        'gi'
      ),
      replace: (
        match: string,
        tagContent: string | undefined,
        italicContent: string | undefined
      ) => {
        if (tagContent) return match;
        if (italicContent) return '<em>' + italicContent + '</em>';
        return match;
      },
    },
  ];
}
