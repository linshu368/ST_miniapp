import {
  TEXT_POSTPROCESS_LIMITS,
  type TextPostprocessSegment,
  type TextPostprocessSlotSegment,
  type TextPostprocessTextSegment,
  type TrustedNode,
  type RichReplyRecovery,
} from '../api/text-postprocess';

const MODULE_LIMIT = 32;
const PANEL =
  /<details>\s*<summary>\s*([^<>\r\n]{1,40})\s*<\/summary>\s*```markdown\s*\r?\n?([\s\S]*?)\r?\n?```\s*<\/details>/g;
const LOOSE_PANEL =
  /<details(?:\s[^>]*)?>\s*<summary(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/summary>\s*([\s\S]*?)\s*<\/details>/gi;
// Keep the opening marker strict, but accept the common HTML-style closing
// typo inside an otherwise unambiguous choices envelope. This never parses
// arbitrary HTML as an action. Legacy snapshots require three contiguous
// entries; configured snapshots recover independently valid entries.
const CHOICE = /\[choice\]\s*([\s\S]*?)\s*(?:\[\/choice\]|<\/\s*choice\s*>)/g;
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
export function applyRichReplyProtocol(
  source: TextPostprocessSegment[],
  recovery?: RichReplyRecovery
): { segments: TextPostprocessSegment[]; matches: number } {
  if (!recovery) return applyProtocolSegments(source);
  const segments: TextPostprocessSegment[] = [];
  let matches = 0;
  for (const segment of source) {
    if (segment.type !== 'text' || matches >= MODULE_LIMIT) {
      segments.push(segment);
      continue;
    }
    const normalized = normalizeProtocolTags(segment.text, recovery);
    const input: TextPostprocessTextSegment = {
      type: 'text',
      text: normalized.text,
      start: 0,
      end: normalized.text.length,
    };
    const wrapped = recovery.unwrap_code_fences
      ? unwrapProtocolFences(input, recovery, MODULE_LIMIT - matches)
      : { segments: [input] as TextPostprocessSegment[], matches: 0 };
    const applied = applyProtocolSegments(
      wrapped.segments,
      recovery,
      MODULE_LIMIT - matches - wrapped.matches
    );
    for (const item of applied.segments) {
      const start = segment.start + (normalized.offsets[item.start] ?? segment.text.length);
      const end = segment.start + (normalized.offsets[item.end] ?? segment.text.length);
      const original = segment.text.slice(start - segment.start, end - segment.start);
      segments.push(
        item.type === 'text'
          ? { ...item, start, end, text: original }
          : { ...item, start, end, match_text: original }
      );
    }
    matches += wrapped.matches + applied.matches;
  }
  return { segments, matches };
}

function applyProtocolSegments(
  source: TextPostprocessSegment[],
  recovery?: RichReplyRecovery,
  limit = MODULE_LIMIT
): {
  segments: TextPostprocessSegment[];
  matches: number;
} {
  let segments = source;
  let matches = 0;
  for (const spec of [
    {
      tag: 'choices',
      ruleId: 'rich-reply-choices',
      build: (body: string, start: number, end: number, match: string) =>
        choicesSlot(body, start, end, match, recovery),
    },
    {
      tag: 'status',
      ruleId: 'rich-reply-status',
      build: (body: string, start: number, end: number, match: string) =>
        statusSlot(body, start, end, match, recovery),
    },
    {
      tag: 'memory',
      ruleId: 'rich-reply-memory',
      build: (body: string, start: number, end: number, match: string) =>
        memorySlot(body, start, end, match, recovery),
    },
  ] as const) {
    const applied = replaceModules(
      segments,
      spec.tag,
      spec.ruleId,
      spec.build,
      limit - matches,
      recovery
    );
    segments = applied.segments;
    matches += applied.matches;
    if (matches >= limit) return { segments, matches };
  }
  const dialogue = replaceDialogue(segments, limit - matches);
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
  protocolEnabled = true,
  recovery?: RichReplyRecovery
): RichReplyDiagnosis {
  const expected = (Object.keys(enabled) as RichReplyModule[]).filter((tag) => enabled[tag]);
  if (expected.length === 0) return { rich_reply_result: 'exact', rich_reply_issues: [] };
  if (!protocolEnabled)
    return { rich_reply_result: 'failed', rich_reply_issues: ['RICH_REPLY_PROTOCOL_DISABLED'] };

  const applied = applyRichReplyProtocol(
    [{ type: 'text', text, start: 0, end: text.length }],
    recovery
  );
  const normalizedText = recovery ? normalizeProtocolTags(text, recovery).text : text;
  const slots = new Map<string, TextPostprocessSlotSegment>();
  for (const segment of applied.segments) {
    if (segment.type === 'slot') slots.set(segment.rule_id, segment);
  }
  const issues: string[] = [];
  let recovered = normalizedText !== text;
  if (recovered) issues.push('NORMALIZED_PROTOCOL_TAG');
  if (
    recovery?.unwrap_code_fences &&
    [...slots.values()].some((item) => /^ {0,3}(?:`{3,}|~{3,})/.test(item.match_text))
  ) {
    recovered = true;
    issues.push('UNWRAPPED_PROTOCOL_FENCE');
  }
  for (const tag of expected) {
    const slot = slots.get(`rich-reply-${tag}`);
    if (!slot || (tag === 'choices' && slot.choices.length < (recovery ? 1 : 3))) {
      issues.push(`INVALID_${tag.toUpperCase()}_MODULE`);
      continue;
    }
    const raw = classifyRawEnvelope(normalizedText, tag);
    if (raw === 'missing') {
      issues.push(`MISSING_${tag.toUpperCase()}_MODULE`);
      continue;
    }
    if (raw !== 'exact') {
      recovered = true;
      issues.push(raw);
    }
    if (recovery && tag === 'choices' && slot.choices.length !== 3) {
      recovered = true;
      issues.push('RECOVERED_CHOICE_COUNT');
    }
    if (recovery && tag === 'choices' && slot.choices.length === 3) {
      const start = normalizedText.indexOf('[choices]') + '[choices]'.length;
      const close = normalizedText.indexOf('[/choices]', start);
      const boundary = nextModuleStart(normalizedText, 'choices', start);
      const end = close >= 0 ? close : boundary >= 0 ? boundary : normalizedText.length;
      if (!captureChoiceBodies(normalizedText.slice(start, end))) {
        recovered = true;
        issues.push('RECOVERED_CHOICES_CONTENT');
      }
    }
    if (tag === 'choices' && /<\/\s*choice\s*>/.test(slot.match_text)) {
      recovered = true;
      issues.push('NORMALIZED_HTML_CHOICE_CLOSE');
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
  allowance: number,
  recovery?: RichReplyRecovery
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
      const boundary = findModuleBoundary(segment.text, tag, start, recovery);
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
  start: number,
  recovery?: RichReplyRecovery
): { endStart: number; end: number } | null {
  const contentStart = start + tag.length + 2;
  const close = `[/${tag}]`;
  const explicitEndStart = value.indexOf(close, contentStart);
  const boundaryStart = nextModuleStart(value, tag, contentStart);

  if (explicitEndStart >= 0 && (boundaryStart < 0 || explicitEndStart < boundaryStart)) {
    return { endStart: explicitEndStart, end: explicitEndStart + close.length };
  }

  if (boundaryStart >= 0) {
    // Keep the original inter-module whitespace outside the recovered slot.
    // Block slots rely on that Markdown separation to mount independently, so
    // consuming it here would also make the following valid module render inert.
    const recoveredEnd = trailingWhitespaceStart(value, contentStart, boundaryStart);
    const body = value.slice(contentStart, recoveredEnd);
    return isRecoverableBody(body) ? { endStart: recoveredEnd, end: recoveredEnd } : null;
  }

  // memory is the final protocol module, so EOF is a deterministic boundary.
  if ((recovery ? recovery[tag].recover_at_eof : tag === 'memory') && explicitEndStart < 0) {
    const body = value.slice(contentStart);
    return isRecoverableBody(body) ? { endStart: value.length, end: value.length } : null;
  }
  return null;
}

function trailingWhitespaceStart(value: string, minimum: number, end: number): number {
  let cursor = end;
  while (cursor > minimum && /\s/.test(value[cursor - 1] ?? '')) cursor -= 1;
  return cursor;
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
  match: string,
  recovery?: RichReplyRecovery
): TextPostprocessSlotSegment | null {
  const recovered = recovery ? recoverChoiceBodies(body) : undefined;
  const choices = recovered ? recovered.choices : captureChoiceBodies(body);
  if (
    !choices ||
    choices.length === 0 ||
    choices.some(
      (choice) => choice.length === 0 || choice.length > TEXT_POSTPROCESS_LIMITS.maxOptionUnits
    )
  ) {
    return plainModuleSlot(
      start,
      end,
      match,
      recovery?.choices.fallback_title ?? '选项内容',
      recovery?.choices.fallback_subtitle ?? '格式异常，已安全展示',
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
                element('strong', [], [text(recovery?.choices.title ?? '接下来……')]),
                element(
                  'small',
                  [],
                  [
                    text(
                      (recovery?.choices.subtitle ?? '想怎么回应？ · 3 个选项').replace(
                        /\{count\}/g,
                        String(choices.length)
                      )
                    ),
                  ]
                ),
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
          [
            ...choices.map((choice) =>
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
            ),
            ...(recovered?.remainder
              ? [element('pre', [], [element('code', [], [text(recovered.remainder)])])]
              : []),
          ]
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
  match: string,
  recovery?: RichReplyRecovery
): TextPostprocessSlotSegment | null {
  return panelModuleSlot(
    body,
    start,
    end,
    match,
    recovery?.status.title ?? '人物近况',
    recovery?.status.subtitle ?? '这一刻的变化',
    'rp-unit--status',
    undefined,
    recovery?.status
  );
}

function memorySlot(
  body: string,
  start: number,
  end: number,
  match: string,
  recovery?: RichReplyRecovery
): TextPostprocessSlotSegment | null {
  return panelModuleSlot(
    body,
    start,
    end,
    match,
    recovery?.memory.title ?? '故事记忆',
    recovery?.memory.subtitle ?? '已记住这段经历',
    'rp-unit--memory',
    'rp-memory-list',
    recovery?.memory
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
  bodyClassName?: string,
  recovery?: RichReplyRecovery['status']
): TextPostprocessSlotSegment | null {
  const panels = capturePanels(body, recovery?.fallback_title ?? heading);
  const degraded = recovery && panels.length === 1 && panels[0]?.fallback === true;
  if (degraded) {
    heading = recovery.fallback_title;
    subtitle = recovery.fallback_subtitle;
  }
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

function recoverChoiceBodies(body: string): { choices: string[]; remainder: string } {
  // A malformed neighbor must neither disable a valid action nor become its payload.
  const pattern =
    /\[choice\]((?:(?!\[\/?(?:choice|choices|status|memory)\])[^])*?)(?:\[\/choice\]|<\/\s*choice\s*>)/g;
  const choices: string[] = [];
  let cursor = 0;
  let remainder = '';
  for (const found of body.matchAll(pattern)) {
    const value = found[1]?.trim() ?? '';
    if (!value || value.length > TEXT_POSTPROCESS_LIMITS.maxOptionUnits) continue;
    remainder += body.slice(cursor, found.index);
    choices.push(value);
    cursor = found.index + found[0].length;
    if (choices.length >= MODULE_LIMIT) break;
  }
  remainder += body.slice(cursor);
  return {
    choices,
    remainder: protocolText(remainder).slice(0, TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits),
  };
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
): Array<{ title: string; content: string; fallback?: true }> {
  const panels: Array<{ title: string; content: string; fallback?: true }> = [];
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
): Array<{ title: string; content: string; fallback?: true }> {
  const panels: Array<{ title: string; content: string; fallback?: true }> = [];
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

function fallbackPanel(
  body: string,
  title: string
): Array<{ title: string; content: string; fallback?: true }> {
  const content = protocolText(body).slice(0, TEXT_POSTPROCESS_LIMITS.maxTemplateTextUnits);
  return [{ title, content: content || '暂无', fallback: true }];
}

function protocolText(value: string): string {
  return value
    .replace(/```(?:markdown)?\s*/gi, '')
    .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, '')
    .replace(/<\/\s*choice\s*>/gi, '')
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

/** Only protocol markers are normalized; every boundary still points into the original reply. */
function normalizeProtocolTags(
  value: string,
  recovery: RichReplyRecovery
): { text: string; offsets: number[] } {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = ['choices', 'choice', 'status', 'memory'] as const;
  const names = new Map<string, string>();
  for (const tag of tags) {
    names.set(tag, tag);
    for (const alias of recovery.tag_aliases[tag]) names.set(alias.toLowerCase(), tag);
  }
  const pairs = [{ open: '[', close: ']' }, ...recovery.bracket_pairs].sort(
    (left, right) => right.open.length + right.close.length - left.open.length - left.close.length
  );
  const expressions = pairs.map(
    ({ open, close }) =>
      `${escape(open)}\\s*(/?)\\s*(${[...names.keys()].map(escape).join('|')})\\s*${escape(close)}`
  );
  const pattern = new RegExp(expressions.map((part) => `(?:${part})`).join('|'), 'giu');
  let cursor = 0;
  let text = '';
  const offsets: number[] = [0];
  const append = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      text += value[index];
      offsets.push(index + 1);
    }
  };
  for (const found of value.matchAll(pattern)) {
    append(cursor, found.index);
    const captures = found.slice(1);
    const pairIndex = captures.findIndex((part, index) => index % 2 === 0 && part !== undefined);
    const slash = captures[pairIndex] ?? '';
    const name = names.get((captures[pairIndex + 1] ?? '').toLowerCase());
    const marker = `[${slash}${name}]`;
    for (let index = 0; index < marker.length; index += 1) {
      text += marker[index];
      offsets.push(index === marker.length - 1 ? found.index + found[0].length : found.index);
    }
    cursor = found.index + found[0].length;
  }
  append(cursor, value.length);
  return { text, offsets };
}

function unwrapProtocolFences(
  segment: TextPostprocessTextSegment,
  recovery: RichReplyRecovery,
  allowance: number
): { segments: TextPostprocessSegment[]; matches: number } {
  const output: TextPostprocessSegment[] = [];
  const opening = /^ {0,3}(`{3,}|~{3,})(?:markdown|md|text|html)?[ \t]*\r?\n/gim;
  let cursor = 0;
  let matches = 0;
  let attempts = 0;
  for (const found of segment.text.matchAll(opening)) {
    if (found.index < cursor || matches >= allowance || attempts++ >= MODULE_LIMIT) continue;
    const fence = found[1] ?? '```';
    const bodyStart = found.index + found[0].length;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
    closing.lastIndex = bodyStart;
    const endings = [...segment.text.matchAll(closing)].slice(-MODULE_LIMIT);
    for (const ending of endings.reverse()) {
      if (ending.index < bodyStart) continue;
      const body = segment.text.slice(bodyStart, ending.index);
      // A code example containing prose or executable code is not a protocol wrapper.
      const parsed = applyProtocolSegments(
        [{ type: 'text', text: body, start: bodyStart, end: ending.index }],
        recovery,
        allowance - matches
      );
      const slots = parsed.segments.filter(
        (item): item is TextPostprocessSlotSegment => item.type === 'slot'
      );
      if (
        !slots.length ||
        slots.some((item) => item.placement !== 'block') ||
        parsed.segments.some((item) => item.type === 'text' && item.text.trim())
      )
        continue;
      if (found.index > cursor) output.push(sliceText(segment, cursor, found.index));
      const first = slots[0];
      const last = slots[slots.length - 1];
      if (!first || !last) continue;
      first.start = found.index;
      // Preserve the trailing newline as Markdown separation from the next module.
      last.end = ending.index + ending[0].trimEnd().length;
      for (const item of slots) {
        item.match_text = segment.text.slice(item.start, item.end);
        // The removed fence enclosed only verified modules; isolate these
        // tokens without weakening the renderer's general block-context guard.
        item.isolate_block = true;
      }
      output.push(...slots);
      cursor = last.end;
      matches += slots.length;
      break;
    }
  }
  if (!cursor) return { segments: [segment], matches: 0 };
  if (cursor < segment.text.length) output.push(sliceText(segment, cursor, segment.text.length));
  return { segments: output, matches };
}
