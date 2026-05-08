// 移植自 SillyTavern public/scripts/util/showdown-patch.js
// 修复 showdown 在多层嵌套 HTML span 时的 unhash 行为(ST 原 patch:不限层数)
import type showdown from 'showdown';

interface PatchableShowdown {
  subParser: (
    name: string,
    fn: (text: string, options: unknown, globals: PatchGlobals) => string
  ) => void;
}

interface PatchGlobals {
  gHtmlSpans: string[];
  converter: {
    _dispatch: (name: string, text: string, options: unknown, globals: PatchGlobals) => string;
  };
}

export function addShowdownPatch(showdownLib: typeof showdown): void {
  const patchable = showdownLib as unknown as PatchableShowdown;
  patchable.subParser('unhashHTMLSpans', function (text, options, globals) {
    text = globals.converter._dispatch('unhashHTMLSpans.before', text, options, globals);
    for (let i = 0; i < globals.gHtmlSpans.length; ++i) {
      let repText = globals.gHtmlSpans[i];
      if (repText === undefined) continue;
      let limit = 0;
      while (/¨C(\d+)C/.test(repText)) {
        const matched: RegExpMatchArray | null = repText.match(/¨C(\d+)C/);
        if (!matched) break;
        const numStr: string | undefined = matched[1];
        if (numStr === undefined) break;
        const replacement: string | undefined = globals.gHtmlSpans[Number(numStr)];
        if (replacement === undefined) break;
        repText = repText.replace('¨C' + numStr + 'C', replacement);
        if (limit === 10000) {
          console.error('maximum nesting of 10000 spans reached!!!');
          break;
        }
        ++limit;
      }
      text = text.replace('¨C' + i + 'C', repText);
    }
    text = globals.converter._dispatch('unhashHTMLSpans.after', text, options, globals);
    return text;
  });
}
