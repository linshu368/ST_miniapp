import parse, { type CssNode } from 'css-tree/parser';
import walk from 'css-tree/walker';
import generate from 'css-tree/generator';

import {
  TEXT_POSTPROCESS_CLASS_TOKEN,
  TEXT_POSTPROCESS_CSS_PROPERTIES,
  TEXT_POSTPROCESS_HTML_TAGS,
  TEXT_POSTPROCESS_LIMITS,
  type CssDeclaration,
  type CssMediaCondition,
  type CssRule,
  type CssSelector,
  type CssToken,
  type TextPostprocessDiagnostic,
  type TextPostprocessHtmlTag,
} from '../api/text-postprocess';
import { checkCssRule, checkDeclaration, scopeProbeSelector } from './css-model';
import { diagnostic } from './diagnostics';

const HTML_TAGS = new Set<string>(TEXT_POSTPROCESS_HTML_TAGS);
const CSS_PROPERTIES = new Set<string>(TEXT_POSTPROCESS_CSS_PROPERTIES);
const ALLOWED_NODE_TYPES = new Set([
  'StyleSheet',
  'Rule',
  'Atrule',
  'AtrulePrelude',
  'Block',
  'SelectorList',
  'Selector',
  'ClassSelector',
  'TypeSelector',
  'Combinator',
  'PseudoClassSelector',
  'Nth',
  'Declaration',
  'Value',
  'Identifier',
  'Hash',
  'String',
  'Number',
  'Dimension',
  'Percentage',
  'Function',
  'Operator',
  'MediaQueryList',
  'MediaQuery',
  'Condition',
  'Feature',
]);
const ALLOWED_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'linear-gradient',
  'var',
  'repeat',
  'minmax',
]);
const ALLOWED_UNITS = new Set(['px', 'rem', 'em', 'ms', 's', 'deg', 'fr']);
const SELECTOR_PROBE_TYPES = new Set([
  'Selector',
  'SelectorList',
  'ClassSelector',
  'TypeSelector',
  'Combinator',
  'PseudoClassSelector',
  'Nth',
]);

export function compileCss(input: { ruleId: string; css: string }): {
  rules: CssRule[];
  diagnostics: TextPostprocessDiagnostic[];
} {
  if (input.css.trim().length === 0) return { rules: [], diagnostics: [] };
  const diagnostics: TextPostprocessDiagnostic[] = [];
  let sawComment = false;
  let ast: CssNode;
  try {
    ast = parse(input.css, {
      positions: true,
      onParseError(error) {
        diagnostics.push(
          issue(input.ruleId, 'CSS_PARSE_ERROR', 'CSS has a parse error.', locationFromError(error))
        );
      },
      onComment() {
        sawComment = true;
      },
    });
  } catch {
    return {
      rules: [],
      diagnostics: [issue(input.ruleId, 'CSS_PARSE_ERROR', 'CSS could not be parsed.', null)],
    };
  }
  if (sawComment) {
    diagnostics.push(issue(input.ruleId, 'CSS_PARSE_ERROR', 'CSS comments are not allowed.', null));
  }
  let nodes = 0;
  let selectors = 0;
  let declarations = 0;
  walk(ast, (node) => {
    nodes += 1;
    if (node.type === 'Selector') selectors += 1;
    if (node.type === 'Declaration') declarations += 1;
    if (!ALLOWED_NODE_TYPES.has(node.type) || node.type === 'Raw') {
      diagnostics.push(
        issue(
          input.ruleId,
          node.type === 'Url' ? 'EXTERNAL_RESOURCE' : 'CSS_PARSE_ERROR',
          'CSS construct is not allowed.',
          nodeLocation(node)
        )
      );
    }
    if (node.type === 'Declaration' && node.important) {
      diagnostics.push(
        issue(input.ruleId, 'CSS_IMPORTANT', 'CSS !important is not allowed.', nodeLocation(node))
      );
    }
    if (node.type === 'Url' || (node.type === 'Function' && node.name?.toLowerCase() === 'url')) {
      diagnostics.push(
        issue(
          input.ruleId,
          'EXTERNAL_RESOURCE',
          'CSS external resources are not allowed.',
          nodeLocation(node)
        )
      );
    }
  });
  if (nodes > TEXT_POSTPROCESS_LIMITS.maxCssNodes) {
    diagnostics.push(issue(input.ruleId, 'CSS_LIMIT', 'CSS AST is too large.', null));
  }
  if (
    selectors > TEXT_POSTPROCESS_LIMITS.maxCssSelectors ||
    declarations > TEXT_POSTPROCESS_LIMITS.maxCssDeclarations
  ) {
    diagnostics.push(
      issue(input.ruleId, 'CSS_LIMIT', 'CSS rule is over the selector or declaration budget.', null)
    );
  }
  if (diagnostics.length > 0)
    return { rules: [], diagnostics: diagnostics.slice(0, TEXT_POSTPROCESS_LIMITS.maxDiagnostics) };

  const rules: CssRule[] = [];
  eachChild(ast, (node) => {
    const converted = convertChild(node, input.ruleId, diagnostics);
    if (converted) rules.push(converted);
  });
  if (diagnostics.length > 0)
    return { rules: [], diagnostics: diagnostics.slice(0, TEXT_POSTPROCESS_LIMITS.maxDiagnostics) };
  for (const rule of rules) {
    if (!checkCssRule(rule)) {
      diagnostics.push(
        issue(input.ruleId, 'FORBIDDEN_VALUE', 'CSS value is outside the policy.', null)
      );
    }
    const selectorsToProbe =
      rule.type === 'style' ? rule.selectors : rule.rules.flatMap((style) => style.selectors);
    for (const selector of selectorsToProbe) {
      if (!reparseScopedSelector(selector)) {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_SELECTOR', 'Scoped selector failed revalidation.', null)
        );
      }
    }
  }
  if (diagnostics.length > 0) return { rules: [], diagnostics };
  return { rules, diagnostics };
}

function convertChild(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[]
): CssRule | null {
  if (node.type === 'Rule') return convertStyle(node, ruleId, diagnostics);
  if (node.type === 'Atrule') return convertMedia(node, ruleId, diagnostics);
  diagnostics.push(
    issue(ruleId, 'FORBIDDEN_ATRULE', 'CSS construct is not allowed.', nodeLocation(node))
  );
  return null;
}

function convertStyle(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[]
): CssRule | null {
  const selectors = node.prelude ? readSelectorList(node.prelude, ruleId, diagnostics) : null;
  const mentionsButton = selectors?.some((selector) =>
    selector.compounds.some((compound) => compound.tag === 'button')
  );
  const declarations = node.block
    ? readDeclarations(node.block, ruleId, diagnostics, mentionsButton ?? false)
    : null;
  if (!selectors || !declarations || selectors.length === 0 || declarations.length === 0)
    return null;
  return { type: 'style', selectors, declarations };
}

function convertMedia(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[]
): CssRule | null {
  if (node.name !== 'media') {
    diagnostics.push(
      issue(
        ruleId,
        node.name === 'import' || node.name === 'font-face'
          ? 'EXTERNAL_RESOURCE'
          : 'FORBIDDEN_ATRULE',
        'CSS at-rule is not allowed.',
        nodeLocation(node)
      )
    );
    return null;
  }
  const conditions = node.prelude ? readMediaConditions(node.prelude, ruleId, diagnostics) : null;
  const rules: CssRule[] = [];
  if (node.block) {
    eachChild(node.block, (child) => {
      if (child.type !== 'Rule') {
        diagnostics.push(
          issue(
            ruleId,
            'FORBIDDEN_ATRULE',
            'Nested CSS at-rules are not allowed.',
            nodeLocation(child)
          )
        );
        return;
      }
      const style = convertStyle(child, ruleId, diagnostics);
      if (style) rules.push(style);
    });
  }
  if (!conditions || conditions.length === 0 || rules.length === 0) return null;
  return {
    type: 'media',
    conditions,
    rules: rules.filter(
      (rule): rule is Extract<CssRule, { type: 'style' }> => rule.type === 'style'
    ),
  };
}

function readSelectorList(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[]
): CssSelector[] | null {
  const selectors: CssSelector[] = [];
  let failed = false;
  eachChild(node, (child) => {
    if (child.type !== 'Selector') {
      failed = true;
      diagnostics.push(
        issue(ruleId, 'FORBIDDEN_SELECTOR', 'Selector is not allowed.', nodeLocation(child))
      );
      return;
    }
    const selector = readSelector(child, ruleId, diagnostics);
    if (!selector) failed = true;
    else selectors.push(selector);
  });
  return failed ? null : selectors;
}

function readSelector(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[]
): CssSelector | null {
  const compounds: CssSelector['compounds'] = [];
  let current: CssSelector['compounds'][number] = {
    combinator: null,
    tag: null,
    classes: [],
    pseudos: [],
  };
  let started = false;
  let failed = false;
  const fail = (child: CssNode): void => {
    failed = true;
    diagnostics.push(
      issue(ruleId, 'FORBIDDEN_SELECTOR', 'Selector is not allowed.', nodeLocation(child))
    );
  };
  eachChild(node, (child) => {
    if (child.type === 'Combinator') {
      if (!started || (child.name !== ' ' && child.name !== '>')) {
        fail(child);
        return;
      }
      compounds.push(current);
      current = {
        combinator: child.name === '>' ? 'child' : 'descendant',
        tag: null,
        classes: [],
        pseudos: [],
      };
      started = false;
      return;
    }
    started = true;
    if (
      child.type === 'TypeSelector' &&
      child.name &&
      HTML_TAGS.has(child.name) &&
      current.tag === null
    ) {
      current.tag = child.name as TextPostprocessHtmlTag;
      return;
    }
    if (
      child.type === 'ClassSelector' &&
      child.name &&
      TEXT_POSTPROCESS_CLASS_TOKEN.test(child.name)
    ) {
      current.classes.push(child.name);
      return;
    }
    if (child.type === 'PseudoClassSelector') {
      const pseudo = readPseudo(child);
      if (!pseudo) fail(child);
      else current.pseudos.push(pseudo);
      return;
    }
    fail(child);
  });
  if (started || current.tag !== null || current.classes.length > 0) compounds.push(current);
  if (failed || compounds.length === 0) return null;
  return { compounds };
}

function readPseudo(node: CssNode): CssSelector['compounds'][number]['pseudos'][number] | null {
  const name = node.name ?? '';
  if (
    name === 'first-child' ||
    name === 'last-child' ||
    name === 'hover' ||
    name === 'focus-visible'
  ) {
    if (hasChild(node)) return null;
    return { kind: name };
  }
  if (name !== 'nth-child') return null;
  const nth = firstChild(node);
  if (!nth || nth.type !== 'Nth' || nth.selector) return null;
  const spec = nth.nth;
  if (!spec || spec.type !== 'AnPlusB') return null;
  const a = spec.a == null ? null : Number(spec.a);
  const b = spec.b == null ? 0 : Number(spec.b);
  if (a !== null && (!Number.isInteger(a) || a < -10 || a > 10)) return null;
  if (!Number.isInteger(b) || b < 0 || b > 20) return null;
  return { kind: 'nth-child', a, b };
}

function readDeclarations(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[],
  mentionsButton: boolean
): CssDeclaration[] | null {
  const declarations: CssDeclaration[] = [];
  let failed = false;
  eachChild(node, (child) => {
    if (
      child.type !== 'Declaration' ||
      !child.property ||
      !child.value ||
      typeof child.value !== 'object'
    ) {
      failed = true;
      diagnostics.push(
        issue(ruleId, 'FORBIDDEN_PROPERTY', 'CSS declaration is not allowed.', nodeLocation(child))
      );
      return;
    }
    if (
      child.property.startsWith('--') ||
      child.property.startsWith('animation') ||
      !CSS_PROPERTIES.has(child.property)
    ) {
      failed = true;
      diagnostics.push(
        issue(ruleId, 'FORBIDDEN_PROPERTY', 'CSS property is not allowed.', nodeLocation(child))
      );
      return;
    }
    const valueNode = child.value as CssNode;
    const tokens = readTokens(valueNode);
    if (!tokens || tokens.length === 0) {
      failed = true;
      diagnostics.push(
        issue(ruleId, 'FORBIDDEN_VALUE', 'CSS value is not allowed.', nodeLocation(child))
      );
      return;
    }
    const declaration = { property: child.property as CssDeclaration['property'], tokens };
    if (!checkDeclaration(declaration, { mentionsButton })) {
      failed = true;
      diagnostics.push(
        issue(ruleId, 'FORBIDDEN_VALUE', 'CSS value is outside the policy.', nodeLocation(child))
      );
      return;
    }
    declarations.push(declaration);
  });
  return failed ? null : declarations;
}

function readMediaConditions(
  node: CssNode,
  ruleId: string,
  diagnostics: TextPostprocessDiagnostic[]
): CssMediaCondition[] | null {
  const queries = children(node).flatMap((child) =>
    child.type === 'MediaQueryList' ? children(child) : [child]
  );
  const mediaQueries = queries.filter((child) => child.type === 'MediaQuery');
  if (mediaQueries.length !== 1) {
    diagnostics.push(
      issue(ruleId, 'FORBIDDEN_ATRULE', 'Only one media query is allowed.', nodeLocation(node))
    );
    return null;
  }
  const query = mediaQueries[0];
  if (!query || query.modifier || query.mediaType) {
    diagnostics.push(
      issue(ruleId, 'FORBIDDEN_ATRULE', 'Media type modifiers are not allowed.', nodeLocation(node))
    );
    return null;
  }
  const condition = query.condition;
  if (!condition) return null;
  const features: CssMediaCondition[] = [];
  for (const child of children(condition)) {
    if (child.type === 'Identifier') {
      if (child.name !== 'and') {
        diagnostics.push(
          issue(ruleId, 'FORBIDDEN_ATRULE', 'Media condition is not allowed.', nodeLocation(child))
        );
        return null;
      }
      continue;
    }
    if (
      child.type !== 'Feature' ||
      !child.name ||
      !child.value ||
      typeof child.value !== 'object'
    ) {
      diagnostics.push(
        issue(ruleId, 'FORBIDDEN_ATRULE', 'Media feature is not allowed.', nodeLocation(child))
      );
      return null;
    }
    const feature = readFeature(child.name, child.value as CssNode);
    if (!feature) {
      diagnostics.push(
        issue(
          ruleId,
          'FORBIDDEN_ATRULE',
          'Media feature is outside the allowed range.',
          nodeLocation(child)
        )
      );
      return null;
    }
    features.push(feature);
  }
  return features;
}

function readFeature(name: string, value: CssNode): CssMediaCondition | null {
  if (
    (name === 'min-width' || name === 'max-width') &&
    value.type === 'Dimension' &&
    value.unit === 'px'
  ) {
    const px = typeof value.value === 'string' ? Number(value.value) : Number.NaN;
    if (!Number.isInteger(px) || px < 240 || px > 1200) return null;
    return { type: 'width', feature: name, px };
  }
  if (
    name === 'prefers-color-scheme' &&
    value.type === 'Identifier' &&
    (value.name === 'light' || value.name === 'dark')
  ) {
    return { type: 'theme', scheme: value.name };
  }
  return null;
}

function readTokens(node: CssNode): CssToken[] | null {
  if (node.type === 'Value') {
    const tokens: CssToken[] = [];
    for (const child of children(node)) {
      const token = readToken(child);
      if (!token) return null;
      tokens.push(token);
    }
    return tokens;
  }
  const token = readToken(node);
  return token ? [token] : null;
}

function readToken(node: CssNode): CssToken | null {
  const value = typeof node.value === 'string' ? node.value : null;
  switch (node.type) {
    case 'Identifier':
      return node.name ? { t: 'ident', v: node.name } : null;
    case 'Hash':
      return value ? { t: 'hash', v: value } : null;
    case 'String':
      return value !== null ? { t: 'string', v: value } : null;
    case 'Number':
      return value !== null ? { t: 'number', v: value } : null;
    case 'Dimension':
      if (value === null || !node.unit || !ALLOWED_UNITS.has(node.unit)) return null;
      return { t: 'dimension', v: value, u: node.unit as 'px' };
    case 'Percentage':
      return value !== null ? { t: 'percentage', v: value } : null;
    case 'Operator':
      return value === ',' || value === '/' ? { t: 'operator', v: value } : null;
    case 'Function': {
      const name = node.name?.toLowerCase();
      if (!name || !ALLOWED_FUNCTIONS.has(name)) return null;
      const args: CssToken[] = [];
      for (const child of children(node)) {
        const token = readToken(child);
        if (!token) return null;
        args.push(token);
      }
      return {
        t: 'function',
        name: name as 'var',
        args,
      };
    }
    default:
      return null;
  }
}

function reparseScopedSelector(selector: CssSelector): boolean {
  let failed = false;
  try {
    const scoped = scopeProbeSelector(selector);
    const ast = parse(scoped, {
      context: 'selector',
      positions: true,
      onParseError() {
        failed = true;
      },
    });
    if (failed) return false;
    generate(ast);
    walk(ast, (node) => {
      if (!SELECTOR_PROBE_TYPES.has(node.type)) failed = true;
    });
    return !failed;
  } catch {
    return false;
  }
}

function eachChild(node: CssNode, visit: (child: CssNode) => void): void {
  node.children?.forEach((child) => visit(child));
}

function children(node: CssNode): CssNode[] {
  const list: CssNode[] = [];
  eachChild(node, (child) => list.push(child));
  return list;
}

function hasChild(node: CssNode): boolean {
  return children(node).length > 0;
}

function firstChild(node: CssNode): CssNode | null {
  return children(node)[0] ?? null;
}

function nodeLocation(node: CssNode): TextPostprocessDiagnostic['location'] {
  if (!node.loc) return null;
  return {
    line: node.loc.start.line,
    column: node.loc.start.column,
    offset: node.loc.start.offset,
    length: Math.max(0, node.loc.end.offset - node.loc.start.offset),
  };
}

function locationFromError(error: {
  line?: number;
  column?: number;
  offset?: number;
}): TextPostprocessDiagnostic['location'] {
  if (error.offset === undefined || error.line === undefined || error.column === undefined)
    return null;
  return { line: error.line, column: error.column, offset: error.offset, length: 1 };
}

function issue(
  ruleId: string,
  code: string,
  message: string,
  location: TextPostprocessDiagnostic['location']
): TextPostprocessDiagnostic {
  return diagnostic({ code, ruleId, field: 'css', message, location });
}
