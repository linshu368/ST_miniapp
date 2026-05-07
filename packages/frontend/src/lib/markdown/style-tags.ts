// 移植自 SillyTavern public/scripts/chats.js:530-626
// <style> 在 sanitize 前编码为 <custom-style>(避开 DOMPurify 默认剥离),
// sanitize 后解码并把所有 selector 加上 .mes-text 前缀,限制 CSS 作用域。
//
// 实现差异:ST 用 Node 的 `css` 包做 AST,本项目运行在浏览器,改用浏览器原生
// CSSStyleSheet API(Chrome 73+ / Safari 16.4+ / FF 101+;Telegram WebView 覆盖)。
// SSR 路径(Node)不会执行 decodeStyleTags——formatMessageContent 只在
// 'use client' 组件里跑,故 SSR 安全。

const STYLE_REGEX = /<style>(.+?)<\/style>/gims;
const CUSTOM_STYLE_REGEX = /<custom-style>(.+?)<\/custom-style>/gms;

export function encodeStyleTags(text: string): string {
  return text.replace(
    STYLE_REGEX,
    (_, body: string) => `<custom-style>${encodeURIComponent(body)}</custom-style>`
  );
}

interface DecodeOptions {
  prefix?: string;
  allowExternalUrls?: boolean;
}

const PSEUDO_CLASSES = ['has', 'not', 'where', 'is', 'matches', 'any'];
const PSEUDO_REGEX = new RegExp(`:(${PSEUDO_CLASSES.join('|')})\\(([^)]+)\\)`, 'g');

function sanitizeSimpleSelector(selector: string): string {
  return selector
    .split(/\s+/)
    .map((part) =>
      part.replace(/\.([\w-]+)/g, (match, className: string) => {
        if (className.startsWith('custom-')) return match;
        return `.custom-${className}`;
      })
    )
    .join(' ');
}

function sanitizeSelector(selector: string): string {
  selector = selector.replace(
    PSEUDO_REGEX,
    (_match, pseudo, content: string) => `:${pseudo}(${sanitizeSimpleSelector(content)})`
  );
  return sanitizeSimpleSelector(selector);
}

function prefixSelectors(selectorText: string, prefix: string): string {
  return selectorText
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => prefix + sanitizeSelector(s))
    .join(', ');
}

function rewriteRules(rules: CSSRuleList, prefix: string, allowExternalUrls: boolean): string {
  const out: string[] = [];
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      const selectors = prefixSelectors(rule.selectorText, prefix);
      const decls = sanitizeDeclarations(rule.style, allowExternalUrls);
      if (decls) out.push(`${selectors} { ${decls} }`);
    } else if (rule instanceof CSSMediaRule) {
      const inner = rewriteRules(rule.cssRules, prefix, allowExternalUrls);
      if (inner) out.push(`@media ${rule.conditionText} { ${inner} }`);
    } else if (rule instanceof CSSSupportsRule) {
      const inner = rewriteRules(rule.cssRules, prefix, allowExternalUrls);
      if (inner) out.push(`@supports ${rule.conditionText} { ${inner} }`);
    } else if (rule instanceof CSSKeyframesRule) {
      // @keyframes 不需要前缀(全局命名空间但只能被前缀过的 selector 引用)
      out.push(rule.cssText);
    } else if (rule instanceof CSSImportRule) {
      // 不允许 @import(过滤掉,与 ST 原版一致)
      continue;
    } else {
      out.push(rule.cssText);
    }
  }
  return out.join(' ');
}

function sanitizeDeclarations(style: CSSStyleDeclaration, allowExternalUrls: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i);
    if (!prop) continue;
    const value = style.getPropertyValue(prop);
    if (!allowExternalUrls && value.includes('://')) continue;
    const priority = style.getPropertyPriority(prop);
    parts.push(`${prop}: ${value}${priority ? ' !' + priority : ''}`);
  }
  return parts.join('; ');
}

export function decodeStyleTags(text: string, opts: DecodeOptions = {}): string {
  // SSR 阶段没有 CSSStyleSheet 构造器,直接 strip 掉 custom-style(沿用 ST 心态:宁可丢失视觉也不冒污染风险)
  if (typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined') {
    return text.replace(CUSTOM_STYLE_REGEX, '');
  }
  const prefix = opts.prefix ?? '.mes-text ';
  const allowExternalUrls = opts.allowExternalUrls ?? false;
  return text.replace(CUSTOM_STYLE_REGEX, (_, body: string) => {
    try {
      const cssText = decodeURIComponent(body).replace(/<br\/>/g, '');
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      const rewritten = rewriteRules(sheet.cssRules, prefix, allowExternalUrls);
      return rewritten ? `<style>${rewritten}</style>` : '';
    } catch (error) {
      console.warn('[markdown] CSS parse failed:', error);
      return '';
    }
  });
}
