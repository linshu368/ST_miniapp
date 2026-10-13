import {
  TEXT_POSTPROCESS_LIMITS,
  outputTextLimit,
  type CompiledTextPostprocessRule,
  type TextPostprocessApplyResult,
  type TextPostprocessCaptureValue,
  type TextPostprocessSegment,
  type TextPostprocessTextSegment,
  type TrustedNode,
} from '../api/text-postprocess';
import { captureText } from './resolve-tree';
import { validateCompiledArtifact } from './validate-artifact';

export interface ApplyTextPostprocessInput {
  text: string;
  artifact: unknown;
  /** 调用方注入的时钟。不提供时纯函数不读取时间。 */
  clock?: () => number;
  deadlineAt?: number;
}

type RuleOutcome =
  | { kind: 'segments'; segments: TextPostprocessSegment[]; matches: number }
  | { kind: 'skip'; code: string }
  | { kind: 'abort'; reason: string };

export function applyTextPostprocess(input: ApplyTextPostprocessInput): TextPostprocessApplyResult {
  if (typeof input.text !== 'string') return original('', 'INVALID_INPUT');
  if (input.text.length > TEXT_POSTPROCESS_LIMITS.maxMessageUnits) {
    return original(input.text, 'INPUT_LIMIT');
  }
  const validated = validateCompiledArtifact(input.artifact);
  if (!validated.ok) return original(input.text, validated.reason);
  let segments: TextPostprocessSegment[] = [
    { type: 'text', text: input.text, start: 0, end: input.text.length },
  ];
  const skipped: Array<{ rule_id: string; code: string }> = [];
  let matches = 0;
  for (const rule of validated.artifact.rules) {
    if (!rule.enabled) continue;
    if (pastDeadline(input)) return original(input.text, 'DEADLINE');
    const outcome = applyRule(segments, rule, input);
    if (outcome.kind === 'abort') return original(input.text, outcome.reason);
    if (outcome.kind === 'skip') {
      skipped.push({ rule_id: rule.id, code: outcome.code });
      continue;
    }
    if (matches + outcome.matches > TEXT_POSTPROCESS_LIMITS.maxMatchesPerMessage) {
      return original(input.text, 'MATCH_LIMIT');
    }
    const expansion = measure(outcome.segments, input.text.length);
    if (expansion.reason) return original(input.text, expansion.reason);
    segments = outcome.segments;
    matches += outcome.matches;
  }
  const stats = measure(segments, input.text.length);
  return {
    status: 'applied',
    segments,
    skipped_rules: skipped,
    stats: {
      matches,
      slots: stats.slots,
      nodes: stats.nodes,
      text_units: stats.textUnits,
    },
  };
}

function applyRule(
  segments: TextPostprocessSegment[],
  rule: CompiledTextPostprocessRule,
  input: ApplyTextPostprocessInput
): RuleOutcome {
  const global = rule.flags.includes('g');
  const ruleStarted = input.clock?.();
  const next: TextPostprocessSegment[] = [];
  let matches = 0;
  let placed = false;
  for (const segment of segments) {
    if (segment.type !== 'text' || (placed && !global)) {
      next.push(segment);
      continue;
    }
    const found = findMatches(segment.text, rule, global, input, ruleStarted);
    if (found.kind === 'deadline') return { kind: 'abort', reason: 'DEADLINE' };
    if (found.kind !== 'matches') return { kind: 'skip', code: found.code };
    if (found.matches.length === 0) {
      next.push(segment);
      continue;
    }
    let cursor = 0;
    for (const match of found.matches) {
      if (match.index > cursor) {
        next.push(textSlice(segment, cursor, match.index));
      }
      next.push(slotFrom(rule, segment.start + match.index, match));
      cursor = match.index + match[0].length;
      matches += 1;
    }
    if (cursor < segment.text.length) next.push(textSlice(segment, cursor, segment.text.length));
    if (!global) placed = true;
  }
  const nonempty = next.filter((segment) => segment.type !== 'text' || segment.text.length > 0);
  return {
    kind: 'segments',
    segments: nonempty.length > 0 ? nonempty : next.slice(0, 1),
    matches,
  };
}

function findMatches(
  text: string,
  rule: CompiledTextPostprocessRule,
  global: boolean,
  input: ApplyTextPostprocessInput,
  ruleStarted: number | undefined
):
  | { kind: 'matches'; matches: RegExpExecArray[] }
  | { kind: 'skip'; code: string }
  | { kind: 'deadline' } {
  let expression: RegExp;
  try {
    const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
    expression = new RegExp(rule.pattern, flags);
  } catch {
    return { kind: 'skip', code: 'INVALID_PATTERN' };
  }
  const matches: RegExpExecArray[] = [];
  while (matches.length <= TEXT_POSTPROCESS_LIMITS.maxMatchesPerRule) {
    if (pastDeadline(input)) return { kind: 'deadline' };
    if (
      input.clock &&
      ruleStarted !== undefined &&
      input.clock() - ruleStarted >= TEXT_POSTPROCESS_LIMITS.ruleBudgetMs
    ) {
      return { kind: 'skip', code: 'RULE_BUDGET' };
    }
    const match = expression.exec(text);
    if (!match) break;
    if (match[0].length === 0) return { kind: 'skip', code: 'EMPTY_MATCH' };
    matches.push(match);
    if (!global) break;
  }
  if (matches.length > TEXT_POSTPROCESS_LIMITS.maxMatchesPerRule) {
    return { kind: 'skip', code: 'RULE_MATCH_LIMIT' };
  }
  return { kind: 'matches', matches };
}

function slotFrom(
  rule: CompiledTextPostprocessRule,
  start: number,
  match: RegExpExecArray
): TextPostprocessSegment {
  const captures: TextPostprocessCaptureValue[] = [];
  for (let index = 1; index < match.length; index += 1) {
    captures.push({
      index,
      name: rule.groups.name_by_index[index - 1] ?? null,
      text: match[index] ?? '',
    });
  }
  return {
    type: 'slot',
    rule_id: rule.id,
    start,
    end: start + match[0].length,
    placement: rule.placement,
    match_text: match[0],
    captures,
    tree: rule.tree,
    choices: choicesFrom(rule.tree, match[0], captures),
  };
}

function choicesFrom(
  tree: TrustedNode[],
  matchText: string,
  captures: TextPostprocessCaptureValue[]
): Array<{ text: string; sendable: boolean }> {
  const choices: Array<{ text: string; sendable: boolean }> = [];
  const visit = (node: TrustedNode): void => {
    if (node.type !== 'element') return;
    if (node.tag === 'button') {
      const text = node.children
        .map((child) => visibleText(child, matchText, captures))
        .join('')
        .trim();
      choices.push({
        text,
        sendable: text.length > 0 && text.length <= TEXT_POSTPROCESS_LIMITS.maxOptionUnits,
      });
    }
    for (const child of node.children) visit(child);
  };
  for (const node of tree) visit(node);
  return choices;
}

function visibleText(
  node: TrustedNode,
  matchText: string,
  captures: TextPostprocessCaptureValue[]
): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'capture') return captureText(node.ref, matchText, captures);
  return node.children.map((child) => visibleText(child, matchText, captures)).join('');
}

function textSlice(
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

function measure(
  segments: TextPostprocessSegment[],
  inputUnits: number
): { slots: number; nodes: number; textUnits: number; reason: string | null } {
  let slots = 0;
  let nodes = 0;
  let textUnits = 0;
  for (const segment of segments) {
    if (segment.type === 'text') {
      textUnits += segment.text.length;
      continue;
    }
    slots += 1;
    nodes += countNodes(segment.tree);
    textUnits += segment.tree.reduce(
      (sum, node) => sum + visibleText(node, segment.match_text, segment.captures).length,
      0
    );
  }
  if (slots > TEXT_POSTPROCESS_LIMITS.maxTrustedSlots) {
    return { slots, nodes, textUnits, reason: 'SLOT_LIMIT' };
  }
  if (nodes > TEXT_POSTPROCESS_LIMITS.maxGeneratedNodes) {
    return { slots, nodes, textUnits, reason: 'NODE_LIMIT' };
  }
  if (textUnits > outputTextLimit(inputUnits)) {
    return { slots, nodes, textUnits, reason: 'OUTPUT_LIMIT' };
  }
  return { slots, nodes, textUnits, reason: null };
}

function countNodes(nodes: TrustedNode[]): number {
  return nodes.reduce((sum, node) => {
    if (node.type !== 'element') return sum + 1;
    return sum + 1 + countNodes(node.children);
  }, 0);
}

function pastDeadline(input: ApplyTextPostprocessInput): boolean {
  return (
    input.clock !== undefined && input.deadlineAt !== undefined && input.clock() >= input.deadlineAt
  );
}

function original(text: string, reason: string): TextPostprocessApplyResult {
  return {
    status: 'original',
    reason,
    segments: [{ type: 'text', text, start: 0, end: text.length }],
  };
}
