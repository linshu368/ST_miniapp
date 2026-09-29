import type { TextPostprocessSegment, TrustedNode } from '../api/text-postprocess';

const NONCE_PATTERN = /^[A-Za-z0-9]{22,128}$/;

export interface SlotTransportEntry {
  token: string;
  rule_id: string;
  placement: 'inline' | 'block';
  match_text: string;
  tree: TrustedNode[];
  captures: Extract<TextPostprocessSegment, { type: 'slot' }>['captures'];
  choices: Extract<TextPostprocessSegment, { type: 'slot' }>['choices'];
}

export type SlotTransportResult =
  | { ok: true; markdown: string; slots: SlotTransportEntry[] }
  | { ok: false; code: 'INVALID_NONCE' | 'NONCE_COLLISION' };

export type TransportDecision =
  | { type: 'text'; text: string }
  | { type: 'mount'; token: string; placement: 'inline' | 'block' }
  | { type: 'restore'; token: string; text: string }
  | { type: 'unsafe-block'; token: string; text: string; code: 'BLOCK_SLOT_CONTEXT_UNSAFE' };

/**
 * nonce 必须由调用方提供，且是纯字母数字。含下划线的占位会被 Markdown 强调语法吃掉。
 * 本函数不生成随机数；碰撞时返回错误，由调用方更换 nonce。
 */
export function prepareSlotTransport(input: {
  text: string;
  segments: TextPostprocessSegment[];
  nonce: string;
}): SlotTransportResult {
  if (!NONCE_PATTERN.test(input.nonce)) return { ok: false, code: 'INVALID_NONCE' };
  const slots = input.segments.filter((segment) => segment.type === 'slot');
  const entries: SlotTransportEntry[] = slots.map((slot, index) => ({
    token: `${input.nonce}s${index.toString(36)}`,
    rule_id: slot.rule_id,
    placement: slot.placement,
    match_text: slot.match_text,
    tree: slot.tree,
    captures: slot.captures,
    choices: slot.choices,
  }));
  if (entries.some((entry) => input.text.includes(entry.token))) {
    return { ok: false, code: 'NONCE_COLLISION' };
  }
  let markdown = input.text;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    const slot = slots[index];
    const entry = entries[index];
    if (!slot || !entry) continue;
    markdown = `${markdown.slice(0, slot.start)}${entry.token}${markdown.slice(slot.end)}`;
  }
  return { ok: true, markdown, slots: entries };
}

export function resolveTransportedTextNodes(input: {
  nodes: Array<{ text: string; ancestors: string[]; exclusiveBlock: 'p' | 'li' | null }>;
  slots: Array<Pick<SlotTransportEntry, 'token' | 'placement' | 'match_text'>>;
}): TransportDecision[][] {
  const slots = [...input.slots].sort((left, right) => right.token.length - left.token.length);
  return input.nodes.map((node) => splitNode(node, slots));
}

function splitNode(
  node: { text: string; ancestors: string[]; exclusiveBlock: 'p' | 'li' | null },
  slots: Array<Pick<SlotTransportEntry, 'token' | 'placement' | 'match_text'>>
): TransportDecision[] {
  const inCode = node.ancestors.includes('code') || node.ancestors.includes('pre');
  const decisions: TransportDecision[] = [];
  let cursor = 0;
  while (cursor < node.text.length) {
    const slot = slots.find((entry) => node.text.startsWith(entry.token, cursor));
    if (!slot) {
      const next = nextToken(node.text, cursor, slots);
      decisions.push({ type: 'text', text: node.text.slice(cursor, next) });
      cursor = next;
      continue;
    }
    if (inCode) {
      decisions.push({ type: 'restore', token: slot.token, text: slot.match_text });
    } else if (slot.placement === 'block') {
      const exclusive =
        (node.exclusiveBlock === 'p' || node.exclusiveBlock === 'li') && node.text === slot.token;
      if (exclusive) decisions.push({ type: 'mount', token: slot.token, placement: 'block' });
      else {
        decisions.push({
          type: 'unsafe-block',
          token: slot.token,
          text: slot.match_text,
          code: 'BLOCK_SLOT_CONTEXT_UNSAFE',
        });
      }
    } else {
      decisions.push({ type: 'mount', token: slot.token, placement: 'inline' });
    }
    cursor += slot.token.length;
  }
  return decisions.filter((decision) => decision.type !== 'text' || decision.text.length > 0);
}

function nextToken(
  text: string,
  cursor: number,
  slots: Array<Pick<SlotTransportEntry, 'token'>>
): number {
  let next = text.length;
  for (const slot of slots) {
    const found = text.indexOf(slot.token, cursor);
    if (found >= 0 && found < next) next = found;
  }
  if (next === cursor) return cursor + 1;
  return next;
}
