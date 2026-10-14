import type {
  TextPostprocessSegment,
  TextPostprocessSlotSegment,
  TextPostprocessTextSegment,
  TrustedNode,
} from '../api/text-postprocess';
import { TEXT_POSTPROCESS_LIMITS } from '../api/text-postprocess';

/**
 * Compatibility handling for replies emitted by the earlier prompt variants.
 *
 * The stored rule artifact remains authoritative for its own matches. This only
 * consumes text that is still untouched after those rules run, so legacy model
 * output cannot expose its control markers while arbitrary text never becomes
 * trusted HTML.
 */
export function applyRichReplyFallback(source: TextPostprocessSegment[]): {
  segments: TextPostprocessSegment[];
  matches: number;
} {
  const choices = replaceLegacyChoices(source);
  const status = replaceLegacyPanel(choices.segments, 'status', '人物近况', '这一刻的变化');
  const memory = replaceLegacyPanel(status.segments, 'memory', '故事记忆', '已记住这段经历');
  return {
    segments: memory.segments,
    matches: choices.matches + status.matches + memory.matches,
  };
}

function replaceLegacyChoices(source: TextPostprocessSegment[]): {
  segments: TextPostprocessSegment[];
  matches: number;
} {
  const expression =
    /\[choice\]\s*([\s\S]*?)\s*\[\/choice\]\s*\[choice\]\s*([\s\S]*?)\s*\[\/choice\]\s*\[choice\]\s*([\s\S]*?)\s*\[\/choice\]/g;
  return replaceTextSegments(source, expression, (match, segment) => {
    const choices = [match[1], match[2], match[3]].map((value) => value?.trim() ?? '');
    if (
      choices.some(
        (choice) =>
          choice.length === 0 ||
          choice.length > TEXT_POSTPROCESS_LIMITS.maxOptionUnits ||
          /\[(?:\/?choice|\/?choices|\/?status|\/?memory)\]/i.test(choice)
      )
    )
      return null;
    return slot(
      'choice',
      segment.start + match.index,
      segment.start + match.index + match[0].length,
      match[0],
      [
        element(
          'details',
          ['rp-unit', 'rp-unit--choices'],
          [
            element(
              'summary',
              [],
              [
                element(
                  'span',
                  ['rp-unit__heading'],
                  [
                    element('strong', [], [text('接下来……')]),
                    element('small', [], [text('想怎么回应？ · 3 个选项')]),
                  ]
                ),
                element(
                  'span',
                  ['rp-unit__chevron'],
                  [text('›')],
                  [{ name: 'aria-hidden', value: 'true' }]
                ),
              ]
            ),
            element(
              'div',
              ['rp-unit__body', 'rp-choice-list'],
              choices.map((choice) =>
                element(
                  'button',
                  ['rp-choice'],
                  [
                    element('span', [], [text(choice)]),
                    element(
                      'span',
                      ['rp-choice__arrow'],
                      [text('→')],
                      [{ name: 'aria-hidden', value: 'true' }]
                    ),
                  ],
                  [],
                  { type: 'send-message' }
                )
              )
            ),
          ]
        ),
      ],
      choices.map((text) => ({ text, sendable: true }))
    );
  });
}

function replaceLegacyPanel(
  source: TextPostprocessSegment[],
  tag: 'status' | 'memory',
  heading: string,
  subtitle: string
): {
  segments: TextPostprocessSegment[];
  matches: number;
} {
  const expression = new RegExp(`\\[${tag}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${tag}\\]`, 'g');
  return replaceTextSegments(source, expression, (match, segment) => {
    const body = sanitizeProtocolText(match[1] ?? '');
    if (!body) return null;
    return slot(
      tag,
      segment.start + match.index,
      segment.start + match.index + match[0].length,
      match[0],
      [
        element(
          'details',
          ['rp-unit', `rp-unit--${tag}`],
          [
            element(
              'summary',
              [],
              [
                element(
                  'span',
                  ['rp-unit__heading'],
                  [element('strong', [], [text(heading)]), element('small', [], [text(subtitle)])]
                ),
                element(
                  'span',
                  ['rp-unit__chevron'],
                  [text('›')],
                  [{ name: 'aria-hidden', value: 'true' }]
                ),
              ]
            ),
            element(
              'div',
              ['rp-unit__body', 'rp-panel-list', ...(tag === 'memory' ? ['rp-memory-list'] : [])],
              [
                element(
                  'details',
                  [],
                  [
                    element('summary', [], [text(heading)]),
                    element('pre', [], [element('code', [], [text(body)])]),
                  ]
                ),
              ]
            ),
          ]
        ),
      ]
    );
  });
}

function sanitizeProtocolText(value: string): string {
  return value
    .replace(/```(?:markdown)?\s*/gi, '')
    .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, '')
    .replace(/\[\/?(?:choices?|status|memory)\]/gi, '')
    .trim()
    .slice(0, TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits);
}

function replaceTextSegments(
  source: TextPostprocessSegment[],
  expression: RegExp,
  build: (
    match: RegExpExecArray,
    segment: TextPostprocessTextSegment
  ) => TextPostprocessSlotSegment | null
): { segments: TextPostprocessSegment[]; matches: number } {
  const next: TextPostprocessSegment[] = [];
  let matches = 0;
  for (const segment of source) {
    if (segment.type !== 'text') {
      next.push(segment);
      continue;
    }
    expression.lastIndex = 0;
    let cursor = 0;
    let found: RegExpExecArray | null;
    while ((found = expression.exec(segment.text))) {
      const built = build(found, segment);
      if (!built) continue;
      if (found.index > cursor) next.push(sliceText(segment, cursor, found.index));
      next.push(built);
      cursor = found.index + found[0].length;
      matches += 1;
    }
    if (cursor === 0) next.push(segment);
    else if (cursor < segment.text.length)
      next.push(sliceText(segment, cursor, segment.text.length));
  }
  return { segments: next, matches };
}

function slot(
  ruleId: string,
  start: number,
  end: number,
  matchText: string,
  tree: TrustedNode[],
  choices: Array<{ text: string; sendable: boolean }> = []
): TextPostprocessSlotSegment {
  return {
    type: 'slot',
    rule_id: ruleId,
    start,
    end,
    placement: 'block',
    match_text: matchText,
    captures: [],
    tree,
    choices,
  };
}

function text(value: string): TrustedNode {
  return { type: 'text', text: value };
}

function element(
  tag: string,
  classes: string[],
  children: TrustedNode[],
  attributes: Array<{ name: 'aria-hidden'; value: 'true' }> = [],
  action: { type: 'send-message' } | null = null
): TrustedNode {
  return {
    type: 'element',
    tag,
    attributes: [
      ...(classes.length > 0 ? [{ name: 'class' as const, tokens: classes }] : []),
      ...attributes,
    ],
    children,
    action,
  };
}

function sliceText(
  segment: TextPostprocessTextSegment,
  from: number,
  to: number
): TextPostprocessTextSegment {
  return {
    type: 'text',
    text: segment.text.slice(from, to),
    start: segment.start + from,
    end: segment.start + to,
  };
}
