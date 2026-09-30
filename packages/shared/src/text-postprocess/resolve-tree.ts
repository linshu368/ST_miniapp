import type {
  TextPostprocessCaptureValue,
  TrustedAttribute,
  TrustedNode,
} from '../api/text-postprocess';

export type ResolvedNode =
  | { type: 'text'; text: string }
  | {
      type: 'element';
      tag: Extract<TrustedNode, { type: 'element' }>['tag'];
      attributes: TrustedAttribute[];
      children: ResolvedNode[];
      action: { type: 'send-message' } | null;
    };

/** 捕获组只替换成文本节点，不再解析成 HTML、属性或 CSS。 */
export function resolveTrustedTree(
  tree: TrustedNode[],
  matchText: string,
  captures: TextPostprocessCaptureValue[]
): ResolvedNode[] {
  return tree.map((node) => resolveNode(node, matchText, captures));
}

function resolveNode(
  node: TrustedNode,
  matchText: string,
  captures: TextPostprocessCaptureValue[]
): ResolvedNode {
  if (node.type === 'text') return { type: 'text', text: node.text };
  if (node.type === 'capture') {
    return { type: 'text', text: captureText(node.ref, matchText, captures) };
  }
  return {
    type: 'element',
    tag: node.tag,
    attributes: node.attributes,
    action: node.action,
    children: node.children.map((child) => resolveNode(child, matchText, captures)),
  };
}

export function captureText(
  ref: Extract<TrustedNode, { type: 'capture' }>['ref'],
  matchText: string,
  captures: TextPostprocessCaptureValue[]
): string {
  if (ref.kind === 'match') return matchText;
  if (ref.kind === 'number') {
    return captures.find((capture) => capture.index === ref.index)?.text ?? '';
  }
  return captures.find((capture) => capture.name === ref.name)?.text ?? '';
}
