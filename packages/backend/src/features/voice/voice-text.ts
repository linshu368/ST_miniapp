/**
 * 语音台词清洗。逐条对齐语音管道 0821 版的 pipeline.py（clean_output / strip_tags /
 * fallback_extract_quotes）。
 *
 * 这一层的存在理由是 LLM 不完全可控：v4.0 的 system 已明令「不要任何括号标签」，
 * 但它仍会时不时漏出 (breath) 或写中文舞台指示（声音颤抖）。
 * 这些括号内容一旦漏到 TTS，会被原样念出来，整段语音就毁了。
 * 所以清洗不是锦上添花，是兜底。
 */

/**
 * 上一代 TTS 模型 speech-2.8-turbo 能听懂的标签全集。
 *
 * 现行模型 speech-02-hd 听不懂，会把它们当英文单词念出来，所以成品台词里
 * 一个都不留（见 normalizeConvertedText 末尾的 stripTags）。白名单本身仍然保留：
 * cleanTags 要靠它区分「模型漏出来的标签」和「不该出现的中文舞台指示」，
 * 两者在诊断日志里的含义不同。将来换回认标签的 TTS 模型，去掉末尾那一步即可。
 */
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
 * 省略号、拖长音与句首多余标点的清理。
 *
 * TTS 遇到省略号会棒读，成段停顿全塌掉；波浪号会被念成「波浪号」；
 * 标签删掉后留在句首的逗号会让这句话以一个突兀的停顿开头。
 */
export function fixPunctuation(text: string): string {
  return text
    .replace(/。{2,}/g, '！')
    .replace(/\.{3,}/g, '，')
    .replace(/…+/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/[~～]+/g, '')
    .replace(/^[，、；：。]+/gm, '');
}

/**
 * 删掉「嗯」「唔」这类文字语气词。
 *
 * 写稿模型用它们替代一次呼吸或迟疑，但 TTS 是逐字念的，听上去是在念「嗯」这个字，
 * 而不是发出那个声音。只对写稿产物生效——用户自己敲的「嗯」是他想说的话，不能动。
 */
export function stripFillerWords(text: string): string {
  return text.replace(/[嗯唔][，。！？…\s]*/g, '');
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

/** 去掉所有语气标签 */
export function stripTags(text: string): string {
  return text
    .replace(/\([a-z-]+\)/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * LLM 原始输出 → 成品台词。这份文本既入库存档、展示给用户，也原样送进 TTS。
 *
 * 末尾的 stripTags 是硬门：送进 speech-02-hd 的文本必须是纯文本。
 * 极端情况下整条台词只剩空字符串（模型只回了一个标签），这不算 bug——
 * 空台词判定为无效，交给写稿的下一道闸重试，比让 TTS 念出 "groans" 好。
 */
export function normalizeConvertedText(raw: string): string {
  return stripTags(
    stripQuotes(stripFillerWords(fixPunctuation(cleanTags(stripCodeFence(raw)))))
  ).trim();
}

/**
 * 用户自定义台词 → 送 TTS 的文本。
 *
 * 不重写、不补语气词、不概括：用户敲什么就念什么，这是产品口径。
 * 但纯标记必须挡掉——括号、省略号、波浪号、引号会被 speech-02-hd 照字面念出来，
 * 用户看着自己输入的字，却听到几个莫名的英文词，那是 bug 不是尊重原文。
 *
 * 与写稿产物的区别只有一处：不删「嗯」「唔」。
 */
export function normalizeCustomText(raw: string): string {
  return stripTags(stripQuotes(fixPunctuation(cleanTags(raw)))).trim();
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
