export const MAX_CREATOR_DOCUMENTS = 10;
export const INLINE_DOCUMENT_CHARACTERS = 200;

export function documentLength(text: string): number {
  return Array.from(text.replace(/\s/g, '')).length;
}

export function parseCreatorDocument(name: string, source: string) {
  if (!/\.(txt|json)$/i.test(name)) throw new Error('请选择 TXT 或 JSON 文件。');
  let content = source.replace(/^\uFEFF/, '').trim();
  if (/\.json$/i.test(name)) {
    try {
      const value: unknown = JSON.parse(content);
      content = typeof value === 'string' ? value.trim() : JSON.stringify(value, null, 2);
    } catch {
      throw new Error(`${name} 的 JSON 格式不正确。`);
    }
  }
  if (!content.trim()) throw new Error(`${name} 是空文件。`);
  return { content, inline: documentLength(content) <= INLINE_DOCUMENT_CHARACTERS };
}

export async function readCreatorDocument(file: File) {
  if (file.size > 2_000_000) throw new Error(`${file.name} 超过 2MB，请拆分后导入。`);
  const buffer = await file.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('gb18030').decode(buffer);
  }
  return parseCreatorDocument(file.name, text);
}
