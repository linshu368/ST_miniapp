import {
  TEXT_POSTPROCESS_CLASS_TOKEN,
  isTextPostprocessHtmlAttribute,
  isTextPostprocessHtmlTag,
  type CssDeclaration,
  type CssRule,
  type CssSelector,
  type CssToken,
  type TextPostprocessHtmlTag,
} from '../api/text-postprocess';

const FORBIDDEN_PROPERTIES = new Set([
  'behavior',
  'filter',
  'zoom',
  'animation',
  'animation-name',
  'animation-duration',
  'animation-delay',
  'animation-timing-function',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-play-state',
]);
const FORBIDDEN_FUNCTIONS = new Set([
  'url',
  'src',
  'image-set',
  'cross-fade',
  'element',
  'paint',
  'expression',
]);
const FORBIDDEN_PSEUDOS = new Set([
  'has',
  'host',
  'host-context',
  'root',
  'scope',
  'slotted',
  'part',
  'view-transition',
]);

export interface CssCheckContext {
  mentionsButton: boolean;
}

export function selectorMentionsButton(selectors: CssSelector[]): boolean {
  return selectors.some((selector) =>
    selector.compounds.some((compound) => compound.tag === 'button')
  );
}

export function checkSelector(selector: CssSelector): boolean {
  if (selector.compounds.length === 0 || selector.compounds[0]?.combinator !== null) return false;
  return selector.compounds.every((compound, index) => {
    if (index > 0 && compound.combinator === null) return false;
    if (
      compound.tag === null &&
      compound.classes.length === 0 &&
      (compound.attributes?.length ?? 0) === 0
    )
      return false;
    if (compound.tag !== null && compound.tag !== '*' && !isHtmlTag(compound.tag)) return false;
    if (!compound.classes.every((token) => TEXT_POSTPROCESS_CLASS_TOKEN.test(token))) return false;
    if (
      !(compound.attributes ?? []).every(
        (attribute) =>
          isTextPostprocessHtmlAttribute(attribute.name) &&
          (attribute.matcher === null
            ? attribute.value === null && attribute.case_sensitive === null
            : attribute.value !== null)
      )
    )
      return false;
    if (
      compound.pseudo_element != null &&
      !/^-?[a-z][a-z0-9-]{0,63}$/.test(compound.pseudo_element)
    )
      return false;
    return compound.pseudos.every((pseudo) => {
      if (pseudo.kind !== 'nth-child' && FORBIDDEN_PSEUDOS.has(pseudo.kind)) return false;
      if (pseudo.kind !== 'nth-child' || !('a' in pseudo) || !('b' in pseudo)) return true;
      if (pseudo.a !== null && (!Number.isInteger(pseudo.a) || pseudo.a < -10 || pseudo.a > 10)) {
        return false;
      }
      return Number.isInteger(pseudo.b) && pseudo.b >= 0 && pseudo.b <= 20;
    });
  });
}

export function checkCssRule(rule: CssRule): boolean {
  if (rule.type === 'media') {
    if (rule.conditions.length < 1 || rule.conditions.length > 2) return false;
    const kinds = new Set(rule.conditions.map((condition) => condition.type));
    if (kinds.size !== rule.conditions.length) return false;
    return rule.rules.every((style) => checkCssRule(style));
  }
  if (!rule.selectors.every((selector) => checkSelector(selector))) return false;
  const button = selectorMentionsButton(rule.selectors);
  return rule.declarations.every((declaration) =>
    checkDeclaration(declaration, { mentionsButton: button })
  );
}

export function checkDeclaration(declaration: CssDeclaration, _context: CssCheckContext): boolean {
  const property = declaration.property.toLowerCase();
  if (FORBIDDEN_PROPERTIES.has(property) || property.startsWith('animation')) return false;
  if (property === 'position') {
    const value = declaration.tokens[0];
    if (declaration.tokens.length !== 1 || value?.t !== 'ident') return false;
    if (value.v === 'fixed' || value.v === 'sticky') return false;
  }
  if (property === 'z-index') {
    const value = declaration.tokens[0];
    if (declaration.tokens.length !== 1 || value?.t !== 'number') return false;
    const parsed = Number(value.v);
    if (!Number.isInteger(parsed) || parsed < -10 || parsed > 10) return false;
  }
  return tokensAreSafe(declaration.tokens, 0);
}

function tokensAreSafe(tokens: CssToken[], depth: number): boolean {
  if (depth > 8 || tokens.length === 0 || tokens.length > 64) return false;
  return tokens.every((token) => {
    if (token.t !== 'function') return true;
    return !FORBIDDEN_FUNCTIONS.has(token.name) && tokensAreSafe(token.args, depth + 1);
  });
}

function isHtmlTag(value: string): value is TextPostprocessHtmlTag {
  return isTextPostprocessHtmlTag(value);
}

export function scopeProbeSelector(selector: CssSelector): string {
  return `.tp-scope ${serializeSelector(selector)}`;
}

/**
 * `scopeCombinator: 'child'` 只给「正文」规则使用：它的 scope 挂在整条回复根节点上，
 * 用直接子级选择器才能只命中普通段落，不波及卡片内部的段落。
 */
export type CssScopeCombinator = 'descendant' | 'child';

export function serializeScopedCss(
  rules: CssRule[],
  scopeClass: string,
  scopeCombinator: CssScopeCombinator = 'descendant'
): string {
  if (!TEXT_POSTPROCESS_CLASS_TOKEN.test(scopeClass)) {
    throw new Error('Invalid text postprocess scope class.');
  }
  const prefix = scopeCombinator === 'child' ? `.${scopeClass} > ` : `.${scopeClass} `;
  return rules.map((rule) => serializeRule(rule, prefix)).join('\n');
}

function serializeRule(rule: CssRule, scopePrefix: string): string {
  if (rule.type === 'media') {
    const condition = rule.conditions
      .map((item) =>
        item.type === 'width'
          ? `(${item.feature}: ${item.px}px)`
          : `(prefers-color-scheme: ${item.scheme})`
      )
      .join(' and ');
    const body = rule.rules.map((style) => serializeRule(style, scopePrefix)).join('\n');
    return `@media ${condition} {\n${body}\n}`;
  }
  const selectors = rule.selectors
    .map((selector) => `${scopePrefix}${serializeSelector(selector)}`)
    .join(', ');
  const declarations = rule.declarations
    .map((declaration) => `${declaration.property}: ${serializeTokens(declaration.tokens)};`)
    .join(' ');
  return `${selectors} { ${declarations} }`;
}

function serializeSelector(selector: CssSelector): string {
  return selector.compounds
    .map((compound, index) => {
      const prefix =
        index === 0
          ? ''
          : compound.combinator === 'child'
            ? ' > '
            : compound.combinator === 'adjacent'
              ? ' + '
              : compound.combinator === 'sibling'
                ? ' ~ '
                : ' ';
      const tag = compound.tag ?? '';
      const classes = compound.classes.map((token) => `.${token}`).join('');
      const attributes = (compound.attributes ?? [])
        .map((attribute) => {
          if (attribute.matcher === null) return `[${attribute.name}]`;
          const value = attribute.value ?? '';
          const flag =
            attribute.case_sensitive === null ? '' : attribute.case_sensitive ? ' s' : ' i';
          return `[${attribute.name}${attribute.matcher}"${value.replace(/(["\\])/g, '\\$1')}"${flag}]`;
        })
        .join('');
      const pseudos = compound.pseudos
        .map((pseudo) =>
          pseudo.kind === 'nth-child' && 'a' in pseudo && 'b' in pseudo
            ? `:nth-child(${formatNth(pseudo.a, pseudo.b)})`
            : `:${pseudo.kind}`
        )
        .join('');
      const pseudoElement = compound.pseudo_element ? `::${compound.pseudo_element}` : '';
      return `${prefix}${tag}${classes}${attributes}${pseudos}${pseudoElement}`;
    })
    .join('');
}

function formatNth(a: number | null, b: number): string {
  if (a === null) return String(b);
  if (b === 0) return `${a}n`;
  if (b > 0) return `${a}n+${b}`;
  return `${a}n${b}`;
}

function serializeTokens(tokens: CssToken[]): string {
  return tokens
    .map((token, index) => {
      const text = serializeToken(token);
      const previous = tokens[index - 1];
      if (index === 0 || token.t === 'operator' || previous?.t === 'operator') return text;
      return ` ${text}`;
    })
    .join('');
}

function serializeToken(token: CssToken): string {
  switch (token.t) {
    case 'ident':
      return token.v;
    case 'hash':
      return `#${token.v}`;
    case 'string':
      return `"${token.v.replace(/"/g, '\\"')}"`;
    case 'number':
      return token.v;
    case 'dimension':
      return `${token.v}${token.u}`;
    case 'percentage':
      return `${token.v}%`;
    case 'operator':
      return token.v === ',' ? ', ' : ' / ';
    case 'function':
      return `${token.name}(${serializeTokens(token.args)})`;
    default:
      return '';
  }
}
