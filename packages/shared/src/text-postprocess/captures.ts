import { TEXT_POSTPROCESS_CAPTURE_NAME, type CaptureRef } from '../api/text-postprocess';

export interface CapturePiece {
  kind: 'text' | 'capture';
  text?: string;
  ref?: CaptureRef;
}

export type CaptureScan =
  | { ok: true; pieces: CapturePiece[] }
  | { ok: false; code: 'UNKNOWN_CAPTURE' | 'INVALID_REPLACEMENT'; offset: number };

const NAMED_LEXEME = /\$<([A-Za-z_$][A-Za-z0-9_$]*)>/g;

/**
 * HTML parser 会把 `$<name>` 的 `<` 当成标签起点。
 * 只编码合法命名捕获 lexeme，并保留变换后偏移到原文偏移的映射。
 */
export function encodeNamedCaptureLexemes(source: string): {
  html: string;
  toOriginal: (offset: number) => number;
} {
  const starts: number[] = [];
  let html = '';
  let cursor = 0;
  for (const match of source.matchAll(NAMED_LEXEME)) {
    const index = match.index ?? 0;
    html = appendPlain(source.slice(cursor, index), cursor, html, starts);
    html = appendEncoded(html, starts, index, match[0], match[1] ?? '');
    cursor = index + match[0].length;
  }
  html = appendPlain(source.slice(cursor), cursor, html, starts);
  starts.push(source.length);
  return {
    html,
    toOriginal(offset: number) {
      if (offset <= 0) return 0;
      if (offset >= starts.length) return source.length;
      return starts[offset] ?? source.length;
    },
  };
}

function appendPlain(text: string, origin: number, html: string, starts: number[]): string {
  for (let index = 0; index < text.length; index += 1) {
    starts.push(origin + index);
  }
  return html + text;
}

function appendEncoded(
  html: string,
  starts: number[],
  origin: number,
  lexeme: string,
  name: string
): string {
  const encoded = `$&lt;${name}>`;
  for (let index = 0; index < encoded.length; index += 1) {
    const ratio = encoded.length <= 1 ? 0 : index / encoded.length;
    starts.push(Math.min(origin + lexeme.length - 1, origin + Math.floor(ratio * lexeme.length)));
  }
  return html + encoded;
}

export function scanCaptureText(
  text: string,
  groups: { count: number; names: string[] }
): CaptureScan {
  const pieces: CapturePiece[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain.length > 0) {
      pieces.push({ kind: 'text', text: plain });
      plain = '';
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '$') {
      plain += text[index];
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      plain += '$';
      continue;
    }
    if (next === '$') {
      plain += '$';
      index += 1;
      continue;
    }
    if (next === '&') {
      flush();
      pieces.push({ kind: 'capture', ref: { kind: 'match' } });
      index += 1;
      continue;
    }
    if (next === '<') {
      const close = text.indexOf('>', index + 2);
      const name = close > index + 2 ? text.slice(index + 2, close) : '';
      if (!TEXT_POSTPROCESS_CAPTURE_NAME.test(name)) {
        return { ok: false, code: 'INVALID_REPLACEMENT', offset: index };
      }
      if (!groups.names.includes(name)) {
        return { ok: false, code: 'UNKNOWN_CAPTURE', offset: index };
      }
      flush();
      pieces.push({ kind: 'capture', ref: { kind: 'name', name } });
      index = close;
      continue;
    }
    if (next >= '0' && next <= '9') {
      const first = Number(next);
      const secondChar = text[index + 2];
      const hasSecond = secondChar !== undefined && secondChar >= '0' && secondChar <= '9';
      const two = hasSecond ? first * 10 + Number(secondChar) : 0;
      let group = 0;
      let consumed = 1;
      if (hasSecond && two >= 1 && two <= 99 && two <= groups.count) {
        group = two;
        consumed = 2;
      } else if (first >= 1 && first <= groups.count) {
        group = first;
        consumed = 1;
      } else {
        return { ok: false, code: 'UNKNOWN_CAPTURE', offset: index };
      }
      flush();
      pieces.push({ kind: 'capture', ref: { kind: 'number', index: group } });
      index += consumed;
      continue;
    }
    plain += '$';
  }
  flush();
  return { ok: true, pieces };
}

/** 属性、标签和 CSS 里任何替换 token 都非法，包括用来输出字面 `$` 的 `$$`。 */
export function findReplacementToken(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '$') continue;
    const next = text[index + 1];
    if (
      next === '$' ||
      next === '&' ||
      next === '<' ||
      (next !== undefined && next >= '0' && next <= '9')
    ) {
      return index;
    }
  }
  return null;
}
