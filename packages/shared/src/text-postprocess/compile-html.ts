import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';

import {
  TEXT_POSTPROCESS_CLASS_TOKEN,
  TEXT_POSTPROCESS_HTML_TAGS,
  TEXT_POSTPROCESS_LIMITS,
  type TextPostprocessDiagnostic,
  type TextPostprocessHtmlTag,
  type TrustedAttribute,
  type TrustedNode,
} from '../api/text-postprocess';
import { encodeNamedCaptureLexemes, findReplacementToken, scanCaptureText } from './captures';
import { diagnostic, lineColumn } from './diagnostics';
import { inspectTemplateTree, placementOf } from './template-model';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const HTML_TAGS = new Set<string>(TEXT_POSTPROCESS_HTML_TAGS);

type HtmlNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;

export interface CompiledTemplate {
  tree: TrustedNode[];
  placement: 'inline' | 'block';
  diagnostics: TextPostprocessDiagnostic[];
}

export function compileTemplate(input: {
  ruleId: string;
  replacement: string;
  groups: { count: number; names: string[] };
}): CompiledTemplate {
  const diagnostics: TextPostprocessDiagnostic[] = [];
  if (input.replacement.length === 0) {
    diagnostics.push(issue(input.ruleId, 'EMPTY_TEMPLATE', 'Template is empty.', null));
    return { tree: [], placement: 'inline', diagnostics };
  }
  const encoded = encodeNamedCaptureLexemes(input.replacement);
  const parseErrors: Array<{ offset: number; code: string }> = [];
  const fragment = parseFragment(encoded.html, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: false,
    onParseError(error) {
      parseErrors.push({
        offset: error.startOffset,
        code: error.code,
      });
    },
  });
  for (const error of parseErrors) {
    diagnostics.push(
      issue(
        input.ruleId,
        'HTML_PARSE_ERROR',
        'HTML template has a parse error.',
        originalLocation(input.replacement, encoded.toOriginal, error.offset, 1)
      )
    );
  }
  const tree: TrustedNode[] = [];
  for (const node of fragment.childNodes) {
    const converted = convertNode(node, input, encoded, diagnostics, null, 1);
    if (converted) tree.push(...converted);
  }
  if (tree.length === 0 && diagnostics.length === 0) {
    diagnostics.push(
      issue(input.ruleId, 'EMPTY_TEMPLATE', 'Template did not produce content.', null)
    );
  }
  const structure = tree.length > 0 ? inspectTemplateTree(tree, input.groups) : 'EMPTY_TEMPLATE';
  if (structure && !diagnostics.some((item) => item.code === structure)) {
    diagnostics.push(issue(input.ruleId, structure, 'HTML template violates the policy.', null));
  }
  if (diagnostics.length > 0) return { tree: [], placement: 'inline', diagnostics };
  return { tree, placement: placementOf(tree), diagnostics };
}

function convertNode(
  node: HtmlNode,
  input: { ruleId: string; replacement: string; groups: { count: number; names: string[] } },
  encoded: { html: string; toOriginal: (offset: number) => number },
  diagnostics: TextPostprocessDiagnostic[],
  parent: TextPostprocessHtmlTag | null,
  depth: number
): TrustedNode[] | null {
  if (diagnostics.length > TEXT_POSTPROCESS_LIMITS.maxDiagnostics) return null;
  if (isTextNode(node)) {
    return convertText(node, input, encoded, diagnostics);
  }
  if (node.nodeName === '#comment' || node.nodeName === '#documentType') {
    diagnostics.push(
      issue(
        input.ruleId,
        'HTML_COMMENT',
        'HTML comments and doctypes are not allowed.',
        locationOf(input.replacement, encoded.toOriginal, node.sourceCodeLocation)
      )
    );
    return null;
  }
  if (!('tagName' in node)) return null;
  const element = node;
  if (!element.sourceCodeLocation) {
    diagnostics.push(
      issue(
        input.ruleId,
        'HTML_IMPLICIT_NODE',
        'HTML parser inserted a node that is not in the template.',
        null
      )
    );
    return null;
  }
  if (element.namespaceURI !== XHTML_NAMESPACE || !HTML_TAGS.has(element.tagName)) {
    diagnostics.push(
      issue(
        input.ruleId,
        'FORBIDDEN_TAG',
        'HTML tag is not in the allowlist.',
        locationOf(input.replacement, encoded.toOriginal, element.sourceCodeLocation)
      )
    );
    return null;
  }
  const tag = element.tagName as TextPostprocessHtmlTag;
  if (depth > TEXT_POSTPROCESS_LIMITS.maxTemplateDepth) {
    diagnostics.push(
      issue(
        input.ruleId,
        'DEPTH_LIMIT',
        'HTML template is nested too deeply.',
        locationOf(input.replacement, encoded.toOriginal, element.sourceCodeLocation)
      )
    );
    return null;
  }
  const attributes = convertAttributes(element, input, encoded, diagnostics);
  const children: TrustedNode[] = [];
  for (const child of element.childNodes) {
    const converted = convertNode(child, input, encoded, diagnostics, tag, depth + 1);
    if (converted) children.push(...converted);
  }
  if (diagnostics.length > 0) return null;
  return [
    {
      type: 'element',
      tag,
      attributes,
      children,
      action: tag === 'button' ? { type: 'send-message' } : null,
    },
  ];
}

function isTextNode(node: HtmlNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function convertText(
  node: DefaultTreeAdapterTypes.TextNode,
  input: { ruleId: string; replacement: string; groups: { count: number; names: string[] } },
  encoded: { html: string; toOriginal: (offset: number) => number },
  diagnostics: TextPostprocessDiagnostic[]
): TrustedNode[] | null {
  const location = node.sourceCodeLocation;
  if (!location) {
    diagnostics.push(issue(input.ruleId, 'HTML_IMPLICIT_NODE', 'HTML parser inserted text.', null));
    return null;
  }
  const scanned = scanCaptureText(node.value, input.groups);
  if (!scanned.ok) {
    const raw = encoded.html.slice(location.startOffset, location.endOffset);
    const decoded = decodeEntities(raw);
    const rawOffset = decoded.text === node.value ? (decoded.rawOffsets[scanned.offset] ?? 0) : 0;
    diagnostics.push(
      issue(
        input.ruleId,
        scanned.code,
        scanned.code === 'UNKNOWN_CAPTURE'
          ? 'Replacement references a capture group that does not exist.'
          : 'Replacement token is invalid.',
        originalLocation(input.replacement, encoded.toOriginal, location.startOffset + rawOffset, 2)
      )
    );
    return null;
  }
  return scanned.pieces.map((piece) =>
    piece.kind === 'text'
      ? { type: 'text', text: piece.text ?? '' }
      : { type: 'capture', ref: piece.ref ?? { kind: 'match' } }
  );
}

function convertAttributes(
  element: HtmlElement,
  input: { ruleId: string; replacement: string },
  encoded: { html: string; toOriginal: (offset: number) => number },
  diagnostics: TextPostprocessDiagnostic[]
): TrustedAttribute[] {
  const attributes: TrustedAttribute[] = [];
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    const tokenAt = findReplacementToken(attribute.value);
    const location = locationOf(
      input.replacement,
      encoded.toOriginal,
      element.sourceCodeLocation?.attrs?.[attribute.name] ?? element.sourceCodeLocation
    );
    if (tokenAt !== null) {
      diagnostics.push(
        issue(
          input.ruleId,
          'CAPTURE_IN_ATTRIBUTE',
          'Capture replacements cannot be placed in attributes.',
          location
        )
      );
      continue;
    }
    if (name === 'class') {
      const tokens = attribute.value.split(/\s+/).filter((token) => token.length > 0);
      if (
        tokens.length < 1 ||
        tokens.length > TEXT_POSTPROCESS_LIMITS.maxClassTokens ||
        tokens.some((token) => !TEXT_POSTPROCESS_CLASS_TOKEN.test(token))
      ) {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_ATTRIBUTE', 'Class token is not allowed.', location)
        );
        continue;
      }
      attributes.push({ name: 'class', tokens });
      continue;
    }
    if (name === 'open') {
      if (attribute.value !== '' && attribute.value !== 'open') {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_ATTRIBUTE', 'Invalid open attribute.', location)
        );
        continue;
      }
      attributes.push({ name: 'open' });
      continue;
    }
    if (name === 'title' || name === 'aria-label') {
      if (attribute.value.length > 200) {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_ATTRIBUTE', 'Text attribute is too long.', location)
        );
        continue;
      }
      attributes.push({ name, text: attribute.value });
      continue;
    }
    if (name === 'aria-hidden') {
      if (attribute.value !== 'true') {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_ATTRIBUTE', 'aria-hidden must be true.', location)
        );
        continue;
      }
      attributes.push({ name: 'aria-hidden', value: 'true' });
      continue;
    }
    if (name === 'colspan' || name === 'rowspan') {
      if (!/^[1-9]\d?$/.test(attribute.value)) {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_ATTRIBUTE', 'Table span is invalid.', location)
        );
        continue;
      }
      const value = Number(attribute.value);
      if (value < 1 || value > 20) {
        diagnostics.push(
          issue(input.ruleId, 'FORBIDDEN_ATTRIBUTE', 'Table span is out of range.', location)
        );
        continue;
      }
      attributes.push({ name, value });
      continue;
    }
    diagnostics.push(
      issue(
        input.ruleId,
        'FORBIDDEN_ATTRIBUTE',
        'HTML attribute is not in the allowlist.',
        location
      )
    );
  }
  return attributes;
}

function decodeEntities(raw: string): { text: string; rawOffsets: number[] } {
  let text = '';
  const rawOffsets: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entities: Array<[string, string]> = [
      ['&lt;', '<'],
      ['&gt;', '>'],
      ['&amp;', '&'],
      ['&quot;', '"'],
    ];
    const entity = entities.find(([token]) => raw.startsWith(token, index));
    if (entity) {
      text += entity[1];
      rawOffsets.push(index);
      index += entity[0].length - 1;
      continue;
    }
    text += raw[index] ?? '';
    rawOffsets.push(index);
  }
  rawOffsets.push(raw.length);
  return { text, rawOffsets };
}

function locationOf(
  source: string,
  toOriginal: (offset: number) => number,
  location: { startOffset: number; endOffset: number } | null | undefined
): TextPostprocessDiagnostic['location'] {
  if (!location) return null;
  return originalLocation(
    source,
    toOriginal,
    location.startOffset,
    Math.max(0, location.endOffset - location.startOffset)
  );
}

function originalLocation(
  source: string,
  toOriginal: (offset: number) => number,
  transformedOffset: number,
  transformedLength: number
): TextPostprocessDiagnostic['location'] {
  const offset = toOriginal(transformedOffset);
  const end = toOriginal(transformedOffset + transformedLength);
  const point = lineColumn(source, offset);
  return {
    line: point.line,
    column: point.column,
    offset,
    length: Math.max(0, end - offset),
  };
}

function issue(
  ruleId: string,
  code: string,
  message: string,
  location: TextPostprocessDiagnostic['location']
): TextPostprocessDiagnostic {
  return diagnostic({
    code,
    ruleId,
    field: 'replacement',
    message,
    location,
  });
}
