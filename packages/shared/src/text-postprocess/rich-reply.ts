import {
  TEXT_POSTPROCESS_LIMITS,
  type TextPostprocessSegment,
  type TextPostprocessSlotSegment,
  type TextPostprocessTextSegment,
  type TrustedNode,
} from '../api/text-postprocess';

const MODULE_LIMIT = 32;
const PANEL =
  /<details>\s*<summary>\s*([^<>\r\n]{1,40})\s*<\/summary>\s*```markdown\s*\r?\n?([\s\S]*?)\r?\n?```\s*<\/details>/g;
const LOOSE_PANEL =
  /<details(?:\s[^>]*)?>\s*<summary(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/summary>\s*([\s\S]*?)\s*<\/details>/gi;
const CHOICE = /\[choice\]\s*([\s\S]*?)\s*\[\/choice\]/g;
const DIALOGUE = /“([^”\r\n]{1,500})”/g;
type RichReplyModule = 'choices' | 'status' | 'memory';

export type RichReplyResult = 'exact' | 'recovered' | 'failed';

export interface RichReplyDiagnosis {
  rich_reply_result: RichReplyResult;
  rich_reply_issues: string[];
}

/**
 * Parses the fixed v1 model protocol into the same trusted-slot transport used
 * by custom rules.  This keeps all rendering inside the existing trusted-tree
 * boundary. Complete protocol envelopes always become trusted slots: exact
 * grammar gets the rich structure, while format drift is rendered as inert
 * text so control markers never leak into the conversation.
 */
export function applyRichReplyProtocol(source: TextPostprocessSegment[]): {
  segments: TextPostprocessSegment[];
  matches: number;
} {
  let segments = source;
  let matches = 0;
  for (const spec of [
    { tag: 'choices', ruleId: 'rich-reply-choices', build: choicesSlot },
    { tag: 'status', ruleId: 'rich-reply-status', build: statusSlot },
    { tag: 'memory', ruleId: 'rich-reply-memory', build: memorySlot },
  ] as const) {
    const applied = replaceModules(
      segments,
      spec.tag,
      spec.ruleId,
      spec.build,
      MODULE_LIMIT - matches
    );
    segments = applied.segments;
    matches += applied.matches;
    if (matches >= MODULE_LIMIT) return { segments, matches };
  }
  const dialogue = replaceDialogue(segments, MODULE_LIMIT - matches);
  return { segments: dialogue.segments, matches: matches + dialogue.matches };
}

/**
 * Produces the small, persistence-safe protocol diagnostic used to select the
 * next turn's prompt. It deliberately records neither source text nor parsed
 * slot contents. A recovered envelope is acceptable only when the same
 * deterministic parser produced every enabled module.
 */
export function diagnoseRichReplyProtocol(
  text: string,
  enabled: Readonly<Record<RichReplyModule, boolean>>,
  protocolEnabled = true
): RichReplyDiagnosis {
  const expected = (Object.keys(enabled) as RichReplyModule[]).filter((tag) => enabled[tag]);
  if (expected.length === 0) return { rich_reply_result: 'exact', rich_reply_issues: [] };
  if (!protocolEnabled)
    return { rich_reply_result: 'failed', rich_reply_issues: ['RICH_REPLY_PROTOCOL_DISABLED'] };

  const applied = applyRichReplyProtocol([{ type: 'text', text, start: 0, end: text.length }]);
  const slots = new Map<string, TextPostprocessSlotSegment>();
  for (const segment of applied.segments) {
    if (segment.type === 'slot') slots.set(segment.rule_id, segment);
  }
  const issues: string[] = [];
  let recovered = false;
  for (const tag of expected) {
    const slot = slots.get(`rich-reply-${tag}`);
    if (!slot || (tag === 'choices' && slot.choices.length !== 3)) {
      issues.push(`INVALID_${tag.toUpperCase()}_MODULE`);
      continue;
    }
    const raw = classifyRawEnvelope(text, tag);
    if (raw === 'missing') {
      issues.push(`MISSING_${tag.toUpperCase()}_MODULE`);
      continue;
    }
    if (raw !== 'exact') {
      recovered = true;
      issues.push(raw);
    }
  }
  if (issues.some((issue) => issue.startsWith('INVALID_') || issue.endsWith('_MODULE')))
    return { rich_reply_result: 'failed', rich_reply_issues: issues };
  return { rich_reply_result: recovered ? 'recovered' : 'exact', rich_reply_issues: issues };
}

function classifyRawEnvelope(text: string, tag: RichReplyModule): 'exact' | 'missing' | string {
  const open = `[${tag}]`;
  const start = text.indexOf(open);
  if (start < 0) return 'missing';
  const contentStart = start + open.length;
  const close = `[/${tag}]`;
  const explicitEnd = text.indexOf(close, contentStart);
  const boundary = nextModuleStart(text, tag, contentStart);
  if (explicitEnd >= 0 && (boundary < 0 || explicitEnd < boundary)) return 'exact';
  if (boundary >= 0) {
    const next = (['choices', 'status', 'memory'] as RichReplyModule[]).find(
      (candidate) => text.indexOf(`[${candidate}]`, contentStart) === boundary
    );
    return `MISSING_${tag.toUpperCase()}_CLOSE_BEFORE_${(next ?? 'MODULE').toUpperCase()}`;
  }
  return `MISSING_${tag.toUpperCase()}_CLOSE_AT_EOF`;
}

function replaceModules(
  segments: TextPostprocessSegment[],
  tag: RichReplyModule,
  ruleId: string,
  build: (
    body: string,
    start: number,
    end: number,
    match: string
  ) => TextPostprocessSlotSegment | null,
  allowance: number
): { segments: TextPostprocessSegment[]; matches: number } {
  if (allowance <= 0) return { segments, matches: 0 };
  const open = `[${tag}]`;
  const next: TextPostprocessSegment[] = [];
  let matches = 0;
  for (const segment of segments) {
    if (segment.type !== 'text' || matches >= allowance) {
      next.push(segment);
      continue;
    }
    let cursor = 0;
    let scan = 0;
    while (scan < segment.text.length && matches < allowance) {
      const start = segment.text.indexOf(open, scan);
      if (start < 0) break;
      const boundary = findModuleBoundary(segment.text, tag, start);
      if (!boundary) {
        // No close tag and no unambiguous next-module boundary means this is
        // ordinary text as far as the protocol parser is concerned.
        break;
      }
      const { endStart, end } = boundary;
      const match = segment.text.slice(start, end);
      const slot = build(
        segment.text.slice(start + open.length, endStart),
        segment.start + start,
        segment.start + end,
        match
      );
      if (!slot) {
        // Keep malformed protocol text verbatim, but continue scanning so a
        // later complete module in the same reply can still render.
        scan = end;
        continue;
      }
      if (start > cursor) next.push(sliceText(segment, cursor, start));
      next.push({ ...slot, rule_id: ruleId });
      cursor = end;
      scan = end;
      matches += 1;
    }
    if (cursor === 0) next.push(segment);
    else if (cursor < segment.text.length)
      next.push(sliceText(segment, cursor, segment.text.length));
  }
  return { segments: next, matches };
}

/**
 * Recover only a missing *outer* close tag when the protocol itself supplies
 * one deterministic boundary. This intentionally does not guess from prose,
 * HTML, or a later closing tag: an ambiguous reply remains ordinary Markdown.
 */
function findModuleBoundary(
  value: string,
  tag: RichReplyModule,
  start: number
): { endStart: number; end: number } | null {
  const contentStart = start + tag.length + 2;
  const close = `[/${tag}]`;
  const explicitEndStart = value.indexOf(close, contentStart);
  const boundaryStart = nextModuleStart(value, tag, contentStart);

  if (explicitEndStart >= 0 && (boundaryStart < 0 || explicitEndStart < boundaryStart)) {
    return { endStart: explicitEndStart, end: explicitEndStart + close.length };
  }

  if (boundaryStart >= 0) {
    const body = value.slice(contentStart, boundaryStart);
    return isRecoverableBody(body) ? { endStart: boundaryStart, end: boundaryStart } : null;
  }

  // memory is the final protocol module, so EOF is a deterministic boundary.
  if (tag === 'memory' && explicitEndStart < 0) {
    const body = value.slice(contentStart);
    return isRecoverableBody(body) ? { endStart: value.length, end: value.length } : null;
  }
  return null;
}

function nextModuleStart(value: string, tag: RichReplyModule, from: number): number {
  const candidates =
    tag === 'choices' ? ['[status]', '[memory]'] : tag === 'status' ? ['[memory]'] : [];
  let next = -1;
  for (const marker of candidates) {
    const index = value.indexOf(marker, from);
    if (index >= 0 && (next < 0 || index < next)) next = index;
  }
  return next;
}

function isRecoverableBody(body: string): boolean {
  if (body.trim().length === 0) return false;
  // A repeated outer envelope or a stray close makes the intended boundary
  // uncertain. [choice] remains allowed inside the choices envelope.
  return !/\[\/?(?:choices|status|memory)\]/.test(body);
}

function choicesSlot(
  body: string,
  start: number,
  end: number,
  match: string
): TextPostprocessSlotSegment | null {
  const choices = captureChoiceBodies(body);
  if (
    !choices ||
    choices.some(
      (choice) => choice.length === 0 || choice.length > TEXT_POSTPROCESS_LIMITS.maxOptionUnits
    )
  ) {
    return plainModuleSlot(
      start,
      end,
      match,
      '选项内容',
      '格式异常，已安全展示',
      'rp-unit--choices',
      protocolText(body).slice(0, TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits) || '暂无'
    );
  }
  const result = slot(start, end, match, [
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
  ]);
  result.choices = choices.map((text) => ({ text, sendable: true }));
  return result;
}

function statusSlot(
  body: string,
  start: number,
  end: number,
  match: string
): TextPostprocessSlotSegment | null {
  return panelModuleSlot(body, start, end, match, '人物近况', '这一刻的变化', 'rp-unit--status');
}

function memorySlot(
  body: string,
  start: number,
  end: number,
  match: string
): TextPostprocessSlotSegment | null {
  return panelModuleSlot(
    body,
    start,
    end,
    match,
    '故事记忆',
    '已记住这段经历',
    'rp-unit--memory',
    'rp-memory-list'
  );
}

function panelModuleSlot(
  body: string,
  start: number,
  end: number,
  match: string,
  heading: string,
  subtitle: string,
  className: string,
  bodyClassName?: string
): TextPostprocessSlotSegment | null {
  const panels = capturePanels(body, heading);
  return slot(start, end, match, [
    element(
      'details',
      ['rp-unit', className],
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
          ['rp-unit__body', 'rp-panel-list', ...(bodyClassName ? [bodyClassName] : [])],
          panels.map(({ title, content }) =>
            element(
              'details',
              [],
              [
                element('summary', [], [text(title)]),
                element('pre', [], [element('code', [], [text(content)])]),
              ]
            )
          )
        ),
      ]
    ),
  ]);
}

function replaceDialogue(
  segments: TextPostprocessSegment[],
  allowance: number
): { segments: TextPostprocessSegment[]; matches: number } {
  if (allowance <= 0) return { segments, matches: 0 };
  const next: TextPostprocessSegment[] = [];
  let matches = 0;
  for (const segment of segments) {
    if (segment.type !== 'text' || matches >= allowance) {
      next.push(segment);
      continue;
    }
    DIALOGUE.lastIndex = 0;
    let cursor = 0;
    let found: RegExpExecArray | null;
    while (matches < allowance && (found = DIALOGUE.exec(segment.text))) {
      if (found.index > cursor) next.push(sliceText(segment, cursor, found.index));
      next.push(
        slot(
          segment.start + found.index,
          segment.start + found.index + found[0].length,
          found[0],
          [element('span', ['rp-dialogue'], [text(found[0])])],
          'rich-reply-dialogue',
          'inline'
        )
      );
      cursor = found.index + found[0].length;
      matches += 1;
    }
    if (cursor === 0) next.push(segment);
    else if (cursor < segment.text.length)
      next.push(sliceText(segment, cursor, segment.text.length));
  }
  return { segments: next, matches };
}

function captureChoiceBodies(body: string): string[] | null {
  const choices: string[] = [];
  let cursor = 0;
  CHOICE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = CHOICE.exec(body))) {
    if (body.slice(cursor, found.index).trim().length > 0) return null;
    choices.push(found[1]?.trim() ?? '');
    cursor = found.index + found[0].length;
  }
  if (body.slice(cursor).trim().length > 0 || choices.length !== 3) return null;
  return choices;
}

function capturePanels(
  body: string,
  fallbackTitle: string
): Array<{ title: string; content: string }> {
  const panels: Array<{ title: string; content: string }> = [];
  let cursor = 0;
  PANEL.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = PANEL.exec(body))) {
    if (body.slice(cursor, found.index).trim().length > 0)
      return captureLoosePanels(body, fallbackTitle);
    const title = found[1]?.trim() ?? '';
    const content = found[2]?.trim() ?? '';
    if (!title || !content || content.length > TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits)
      return captureLoosePanels(body, fallbackTitle);
    panels.push({ title, content });
    cursor = found.index + found[0].length;
  }
  return panels.length > 0 && body.slice(cursor).trim().length === 0
    ? panels
    : captureLoosePanels(body, fallbackTitle);
}

function captureLoosePanels(
  body: string,
  fallbackTitle: string
): Array<{ title: string; content: string }> {
  const panels: Array<{ title: string; content: string }> = [];
  let cursor = 0;
  LOOSE_PANEL.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = LOOSE_PANEL.exec(body))) {
    if (protocolText(body.slice(cursor, found.index)).length > 0) {
      return fallbackPanel(body, fallbackTitle);
    }
    const title = protocolText(found[1] ?? '').slice(0, 40);
    const content = protocolText(found[2] ?? '');
    if (!title || !content || content.length > TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits) {
      return fallbackPanel(body, fallbackTitle);
    }
    panels.push({ title, content });
    cursor = found.index + found[0].length;
  }
  return panels.length > 0 && protocolText(body.slice(cursor)).length === 0
    ? panels
    : fallbackPanel(body, fallbackTitle);
}

function fallbackPanel(body: string, title: string): Array<{ title: string; content: string }> {
  const content = protocolText(body).slice(0, TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits);
  return [{ title, content: content || '暂无' }];
}

function protocolText(value: string): string {
  return value
    .replace(/```(?:markdown)?\s*/gi, '')
    .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, '')
    .replace(/\[\/?(?:choices?|status|memory)\]/gi, '')
    .trim();
}

function plainModuleSlot(
  start: number,
  end: number,
  match: string,
  heading: string,
  subtitle: string,
  className: string,
  content: string
): TextPostprocessSlotSegment {
  return slot(start, end, match, [
    element(
      'details',
      ['rp-unit', className],
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
          ['rp-unit__body', 'rp-panel-list'],
          [element('pre', [], [element('code', [], [text(content)])])]
        ),
      ]
    ),
  ]);
}

function slot(
  start: number,
  end: number,
  matchText: string,
  tree: TrustedNode[],
  ruleId = '',
  placement: 'inline' | 'block' = 'block'
): TextPostprocessSlotSegment {
  return {
    type: 'slot',
    rule_id: ruleId,
    start,
    end,
    placement,
    match_text: matchText,
    captures: [],
    tree,
    choices: [],
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
