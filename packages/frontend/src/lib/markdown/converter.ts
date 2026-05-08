import showdown from 'showdown';

import { markdownExclusionExt } from './showdown-exclusion';
import { addShowdownPatch } from './showdown-patch';
import { markdownUnderscoreExt } from './showdown-underscore';

let cachedConverter: showdown.Converter | null = null;
let patched = false;

export function getConverter(): showdown.Converter {
  if (cachedConverter) return cachedConverter;
  if (!patched) {
    addShowdownPatch(showdown);
    patched = true;
  }
  cachedConverter = new showdown.Converter({
    emoji: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    tables: true,
    underline: true,
    simpleLineBreaks: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
    extensions: [markdownUnderscoreExt()],
  });
  cachedConverter.addExtension(markdownExclusionExt(), 'exclusion');
  return cachedConverter;
}
