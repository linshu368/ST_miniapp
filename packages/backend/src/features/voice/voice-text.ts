/**
 * 语音台词清洗。逐条对齐语音管道 0820 版的 pipeline.py（clean_output / strip_tags /
 * fallback_extract_quotes）。
 *
 * 这一层的存在理由是 LLM 不完全可控：system 明令只许用 19 个白名单标签，
 * 但它仍会时不时自创 (voice breaking) 或写中文舞台指示（声音颤抖）。
 * 这些括号内容一旦漏到 TTS，会被原样念出来，整段语音就毁了。
 * 所以清洗不是锦上添花，是兜底。
 */

/** 模板允许的全部标签，多一个都不行 */
export const VOICE_TAG_WHITELIST: ReadonlySet<string> = new Set([
  'breath',
  'pant',
  'inhale',
  'exhale',
  'laughs',
  'chuckle',
  'sighs',
  'gasps',
  'groans',
  'sniffs',
  'emm',
  'lip-smacking',
  'humming',
  'hissing',
  'coughs',
  'clear-throat',
  'snorts',
  'sneezes',
  'burps',
]);

/** LLM 偶尔会把整段包进代码块，直接送 TTS 会念出反引号 */
export function stripCodeFence(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * 括号内容白名单过滤：中英文括号都收，不在白名单的一律删掉。
 * "voice breaking" 这类多词写法先归一成 "voice-breaking" 再判定，
 * 因为模板里的 lip-smacking / clear-throat 本身就带连字符。
 */
export function cleanTags(text: string): string {
  return text.replace(/[（(]([^（）()]*)[)）]/g, (_match, rawInner: string) => {
    const inner = rawInner.trim();
    // 中文只可能是舞台指示，白名单里没有中文标签
    if (/[\u4e00-\u9fff]/.test(inner)) return '';
    const normalized = inner.replace(/\s+/g, '-').toLowerCase();
    return VOICE_TAG_WHITELIST.has(normalized) ? `(${normalized})` : '';
  });
}

/**
 * 省略号、文字语气词、拖长音与句首多余标点的清理。
 *
 * TTS 遇到省略号会棒读，成段停顿全塌掉；「嗯」「唔」这类文字语气词会被逐字念出来，
 * 而不是发出对应的声音；波浪号会被念成「波浪号」；标签删掉后留在句首的逗号
 * 会让这句话以一个突兀的停顿开头。
 */
export function fixEllipsis(text: string): string {
  return text
    .replace(/。{2,}/g, '！')
    .replace(/\.{3,}/g, '，')
    .replace(/…+/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/[嗯唔][，。！？…\s]*/g, '')
    .replace(/[~～]+/g, '')
    .replace(/^[，、；：。]+/gm, '');
}

/**
 * 去掉所有成对引号字符。
 *
 * 台词本身就是「说出口的话」，引号是叙事文本的残留。speech-02-hd 对引号的处理
 * 不稳定，有时会读出「引号」两个字，有时会在引号处插入一个不该有的停顿。
 */
export function stripQuotes(text: string): string {
  return text.replace(/["'\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f`\u201e\u201f]/g, '');
}

/** 去掉所有语气标签。只用于诊断与判定，不参与送 TTS 的正文 */
export function stripTags(text: string): string {
  return text
    .replace(/\([a-z-]+\)/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * LLM 原始输出 → 成品台词。
 *
 * 这份文本既入库存档，也原样送进 TTS：标签是成品的一部分，不再单独剥一版。
 * 参照产出里存在整条台词只有 `(groans)` 的样本，剥掉标签就什么都不剩了。
 */
export function normalizeConvertedText(raw: string): string {
  return stripQuotes(fixEllipsis(cleanTags(stripCodeFence(raw)))).trim();
}

/**
 * 兜底抽取：直接从原文里把引号内的对白扒出来，一句一行。
 *
 * 写稿模型失灵时用它，产出必然是原文里真实存在的台词，不会凭空生成，
 * 而且天然短——这是最坏情况下仍然正确的那条路。
 */
export function extractQuotedLines(sourceText: string): string {
  const pattern =
    /\u201c([^\u201d]*)\u201d|\u300c([^\u300d]*)\u300d|\u300e([^\u300f]*)\u300f|"([^"]*)"/g;
  const segments: string[] = [];

  for (const match of sourceText.matchAll(pattern)) {
    const segment = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (segment) segments.push(segment);
  }

  return segments.join('\n');
}
