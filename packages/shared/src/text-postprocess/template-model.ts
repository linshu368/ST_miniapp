import {
  TEXT_POSTPROCESS_CLASS_TOKEN,
  TEXT_POSTPROCESS_LIMITS,
  type TextPostprocessHtmlTag,
  type TrustedNode,
} from '../api/text-postprocess';
import { findReplacementToken } from './captures';

const BLOCK_TAGS = new Set<TextPostprocessHtmlTag>([
  'p',
  'div',
  'section',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'h3',
  'h4',
  'hr',
  'details',
]);

const REQUIRED_PARENT: Partial<Record<TextPostprocessHtmlTag, readonly TextPostprocessHtmlTag[]>> =
  {
    summary: ['details'],
    li: ['ul', 'ol'],
    thead: ['table'],
    tbody: ['table'],
    tr: ['table', 'thead', 'tbody'],
    td: ['tr'],
    th: ['tr'],
  };

const INTERACTIVE = new Set<TextPostprocessHtmlTag>(['button', 'details', 'summary']);

export interface TemplateStats {
  nodes: number;
  depth: number;
  captures: number;
  textUnits: number;
}

export function placementOf(tree: TrustedNode[]): 'inline' | 'block' {
  return tree.some((node) => node.type === 'element' && BLOCK_TAGS.has(node.tag))
    ? 'block'
    : 'inline';
}

export function inspectTemplateTree(
  tree: TrustedNode[],
  groups: { count: number; names: string[] }
): string | null {
  const stats: TemplateStats = { nodes: 0, depth: 0, captures: 0, textUnits: 0 };
  const visit = (
    nodes: TrustedNode[],
    parent: TextPostprocessHtmlTag | null,
    depth: number
  ): string | null => {
    if (depth > stats.depth) stats.depth = depth;
    for (const node of nodes) {
      stats.nodes += 1;
      if (stats.nodes > TEXT_POSTPROCESS_LIMITS.maxTemplateNodes) return 'NODE_LIMIT';
      if (node.type === 'text') {
        stats.textUnits += node.text.length;
        if (stats.textUnits > TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits) return 'TEXT_BUDGET';
        continue;
      }
      if (node.type === 'capture') {
        stats.captures += 1;
        if (stats.captures > TEXT_POSTPROCESS_LIMITS.maxCaptureRefs) return 'CAPTURE_REF_LIMIT';
        if (!captureAllowed(node.ref, groups)) return 'UNKNOWN_CAPTURE';
        continue;
      }
      if (depth > TEXT_POSTPROCESS_LIMITS.maxTemplateDepth) return 'DEPTH_LIMIT';
      const structure = checkElement(node, parent);
      if (structure) return structure;
      const child = visit(node.children, node.tag, depth + 1);
      if (child) return child;
      if (node.attributes.some((attribute) => attribute.name === 'aria-hidden')) {
        if (
          node.action ||
          hasCapture(node) ||
          node.children.some((childNode) => childNode.type === 'element')
        ) {
          return 'FORBIDDEN_ATTRIBUTE';
        }
      }
    }
    return null;
  };
  if (tree.length === 0) return 'EMPTY_TEMPLATE';
  return (
    visit(tree, null, 1) ??
    (stats.depth > TEXT_POSTPROCESS_LIMITS.maxTemplateDepth ? 'DEPTH_LIMIT' : null)
  );
}

function captureAllowed(
  ref: Extract<TrustedNode, { type: 'capture' }>['ref'],
  groups: { count: number; names: string[] }
): boolean {
  if (ref.kind === 'match') return true;
  if (ref.kind === 'number') return ref.index >= 1 && ref.index <= groups.count;
  return groups.names.includes(ref.name);
}

function checkElement(
  node: Extract<TrustedNode, { type: 'element' }>,
  parent: TextPostprocessHtmlTag | null
): string | null {
  const required = REQUIRED_PARENT[node.tag];
  if (required && (parent === null || !required.includes(parent))) return 'HTML_STRUCTURE';
  if ((node.tag === 'br' || node.tag === 'hr') && node.children.length > 0) return 'HTML_STRUCTURE';
  if (parent && INTERACTIVE.has(parent) && parent === 'button' && INTERACTIVE.has(node.tag)) {
    return 'HTML_STRUCTURE';
  }
  if (node.tag === 'button') {
    if (node.action?.type !== 'send-message') return 'FORBIDDEN_ATTRIBUTE';
  } else if (node.action) {
    return 'FORBIDDEN_ATTRIBUTE';
  }
  const names = new Set<string>();
  for (const attribute of node.attributes) {
    if (names.has(attribute.name)) return 'FORBIDDEN_ATTRIBUTE';
    names.add(attribute.name);
    if (attribute.name === 'class') {
      if (attribute.tokens.some((token) => !TEXT_POSTPROCESS_CLASS_TOKEN.test(token))) {
        return 'FORBIDDEN_ATTRIBUTE';
      }
    }
    if (attribute.name === 'open' && node.tag !== 'details') return 'FORBIDDEN_ATTRIBUTE';
    if (
      (attribute.name === 'colspan' || attribute.name === 'rowspan') &&
      node.tag !== 'td' &&
      node.tag !== 'th'
    ) {
      return 'FORBIDDEN_ATTRIBUTE';
    }
    if (attribute.name === 'aria-hidden' && node.tag === 'button') return 'FORBIDDEN_ATTRIBUTE';
    if (
      (attribute.name === 'title' || attribute.name === 'aria-label') &&
      findReplacementToken(attribute.text) !== null
    ) {
      return 'CAPTURE_IN_ATTRIBUTE';
    }
  }
  return null;
}

function hasCapture(node: TrustedNode): boolean {
  if (node.type === 'capture') return true;
  if (node.type === 'text') return false;
  return node.children.some((child) => hasCapture(child));
}
