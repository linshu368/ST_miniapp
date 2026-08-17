/**
 * 语音文本清洗。逐条对齐语音管道 v1 的 pipeline.py（clean_tags / fix_ellipsis / strip_tags）。
 *
 * 这一层的存在理由是 LLM 不完全可控：模板明令只许用 19 个白名单标签，
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
 * 省略号与文字语气词清理。TTS 遇到省略号会棒读，成段停顿全塌掉；
 * 「嗯」「唔」这类文字语气词会被逐字念出来，而不是发出对应的声音。
 */
export function fixEllipsis(text: string): string {
  return text
    .replace(/。{2,}/g, '！')
    .replace(/\.{3,}/g, '，')
    .replace(/…+/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/[嗯唔][，。！？…\s]*/g, '');
}

/** 去掉所有语气标签，得到真正送进 TTS 的文本 */
export function stripTags(text: string): string {
  return text
    .replace(/\([a-z-]+\)/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * LLM 原始输出 → 带标签的存档文本。
 * 存档保留标签，排查「为什么这句念得怪」时能看出模板判了什么情绪。
 */
export function normalizeConvertedText(raw: string): string {
  return fixEllipsis(cleanTags(stripCodeFence(raw))).trim();
}

/**
 * 带标签文本 → 实际送进 TTS 的文本。
 *
 * 标准配置产出的是去标签版：speech-02-hd 对这些标签的支持并不稳定，
 * 漏读成字面文字的代价远大于少一点呼吸声。加标签那一步仍有价值——
 * 它会改变 LLM 断句和用词的方式，只是最后不把标签本身送上去。
 */
export function toSpokenText(convertedText: string): string {
  return stripTags(convertedText);
}
