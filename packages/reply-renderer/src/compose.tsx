import { createElement, Fragment, type ReactNode } from 'react';
import {
  prepareSlotTransport,
  replaceUserPlaceholder,
  resolveTransportedTextNodes,
  resolveTrustedTree,
  type TextPostprocessSegment,
} from '@miniapp/shared';

import { BASE_CSS } from './base-css';
import { isSafeCss } from './css-safety';
import { isMarkdownTag, parseMarkdownDocument, renderMarkdownHtml } from './markdown';
import { createAlphanumericNonce } from './nonce';
import { ruleScopeClass } from './scope-class';
import { TrustedTree } from './trusted-tree';
import type { ReplyChoicePayload } from './types';

const THEME_BOUNDARY_CSS = '.reply-markdown[data-theme] .rp-unit { color-scheme: inherit; }';

type AppliedSegments = Extract<
  { status: 'applied'; segments: TextPostprocessSegment[] },
  { status: 'applied' }
>['segments'];

type TransportSlot = Extract<
  ReturnType<typeof prepareSlotTransport>,
  { ok: true }
>['slots'][number];

interface DisplaySlot extends TransportSlot {
  start: number;
  end: number;
}

export interface ComposeInput {
  content: string;
  displayName: string | null | undefined;
  segments: TextPostprocessSegment[];
  css: string;
  messageKey: string;
  interactive: boolean;
  onChoice?: (choice: ReplyChoicePayload) => void;
  openStore: Map<string, boolean>;
  detailsDefaultOpen?: Readonly<Record<string, boolean>>;
  createNonce?: () => string;
}

export function composeAppliedView(
  input: ComposeInput
): { ok: true; body: ReactNode } | { ok: false; reason: string } {
  if (!isSafeCss(input.css)) return { ok: false, reason: 'CSS_REJECTED' };
  const createNonce = input.createNonce ?? createAlphanumericNonce;
  let failure: string = 'NONCE_COLLISION';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nonce = createNonce();
    const transport = prepareSlotTransport({
      text: input.content,
      segments: input.segments,
      nonce,
    });
    if (!transport.ok) {
      failure = transport.code;
      continue;
    }
    const markdown = replaceUserPlaceholder(transport.markdown, input.displayName);
    const slots = zipSlots(input.segments, transport.slots);
    if (slots.some((slot) => countOccurrences(markdown, slot.token) !== 1)) {
      failure = 'NONCE_COLLISION';
      continue;
    }
    const built = buildMarkdown(markdown, slots, input);
    if (!built.ok && built.reason === 'NONCE_COLLISION') {
      failure = built.reason;
      continue;
    }
    return built;
  }
  return { ok: false, reason: failure };
}

export function renderOriginalBody(
  content: string,
  displayName: string | null | undefined
): ReactNode {
  const plain = replaceUserPlaceholder(content, displayName);
  try {
    const html = renderMarkdownHtml(plain);
    if (!html) return plain;
    const built = buildMarkdown(
      html,
      [],
      {
        content,
        displayName,
        segments: [],
        css: '',
        messageKey: 'original',
        interactive: false,
        openStore: new Map(),
      },
      true
    );
    if (!built.ok) return plain;
    return built.body;
  } catch {
    return plain;
  }
}

function zipSlots(segments: AppliedSegments, slots: TransportSlot[]): DisplaySlot[] {
  const ranges = segments.filter((segment) => segment.type === 'slot');
  return slots.map((slot, index) => {
    const range = ranges[index];
    return {
      ...slot,
      start: range?.start ?? 0,
      end: range?.end ?? 0,
    };
  });
}

function buildMarkdown(
  markdownOrHtml: string,
  slots: DisplaySlot[],
  input: ComposeInput,
  alreadyHtml = false
): { ok: true; body: ReactNode } | { ok: false; reason: string } {
  const html = alreadyHtml ? markdownOrHtml : renderMarkdownHtml(markdownOrHtml);
  if (!html && slots.length > 0) return { ok: false, reason: 'MARKDOWN_UNAVAILABLE' };
  const root = parseMarkdownDocument(html);
  if (!root) return { ok: false, reason: 'MARKDOWN_UNAVAILABLE' };
  separateRootBlockSlots(root, slots);
  const used = new Map<string, number>();
  const nodes = renderNodeList(root.childNodes, root, slots, used, input);
  for (const slot of slots) {
    if (used.get(slot.token) !== 1) return { ok: false, reason: 'SLOT_TRANSPORT' };
  }
  return {
    ok: true,
    body: createElement(
      Fragment,
      null,
      createElement('style', null, `${BASE_CSS}\n${input.css}\n${THEME_BOUNDARY_CSS}`),
      nodes
    ),
  };
}

/** Split only top-level prose paragraphs after Markdown has identified code and list contexts. */
function separateRootBlockSlots(root: HTMLElement, slots: DisplaySlot[]): void {
  const blockTokens = slots.filter((slot) => slot.placement === 'block').map((slot) => slot.token);
  if (blockTokens.length === 0) return;
  for (const child of Array.from(root.children)) {
    if (child.tagName.toLowerCase() !== 'p') continue;
    const paragraph = child as HTMLParagraphElement;
    if (
      !Array.from(paragraph.childNodes).some(
        (node) =>
          node.nodeType === Node.TEXT_NODE &&
          blockTokens.some((token) => node.textContent?.includes(token))
      )
    ) {
      continue;
    }
    const document = root.ownerDocument;
    const replacement = document.createDocumentFragment();
    let current = document.createElement('p');
    const flush = (): void => {
      while (
        current.lastChild?.nodeName.toLowerCase() === 'br' ||
        (current.lastChild?.nodeType === Node.TEXT_NODE && !current.lastChild.textContent?.trim())
      ) {
        current.lastChild.remove();
      }
      if (current.textContent?.trim()) replacement.appendChild(current);
      current = document.createElement('p');
    };
    for (const node of Array.from(paragraph.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) {
        if (node.nodeName.toLowerCase() !== 'br' || current.textContent?.trim())
          current.appendChild(node);
        continue;
      }
      const value = node.textContent ?? '';
      let cursor = 0;
      while (cursor < value.length) {
        const next = blockTokens
          .map((token) => ({ token, index: value.indexOf(token, cursor) }))
          .filter((match) => match.index >= 0)
          .sort((left, right) => left.index - right.index)[0];
        if (!next) {
          current.appendChild(document.createTextNode(value.slice(cursor)));
          break;
        }
        if (next.index > cursor)
          current.appendChild(document.createTextNode(value.slice(cursor, next.index)));
        flush();
        const isolated = document.createElement('p');
        isolated.textContent = next.token;
        replacement.appendChild(isolated);
        cursor = next.index + next.token.length;
      }
    }
    flush();
    paragraph.replaceWith(replacement);
  }
}

function renderNodeList(
  nodes: NodeListOf<ChildNode>,
  root: HTMLElement,
  slots: DisplaySlot[],
  used: Map<string, number>,
  input: ComposeInput
): ReactNode[] {
  const rendered: ReactNode[] = [];
  nodes.forEach((node, index) => {
    rendered.push(renderDomNode(node, root, slots, used, input, String(index)));
  });
  return rendered;
}

function renderDomNode(
  node: ChildNode,
  root: HTMLElement,
  slots: DisplaySlot[],
  used: Map<string, number>,
  input: ComposeInput,
  key: string
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return renderText(node as Text, root, slots, used, input, key);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return createElement(Fragment, { key });
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (!isMarkdownTag(tag)) {
    return createElement(
      Fragment,
      { key },
      renderNodeList(element.childNodes, root, slots, used, input)
    );
  }
  if ((tag === 'p' || tag === 'li') && element.childNodes.length === 1) {
    const only = element.childNodes[0];
    if (only && only.nodeType === Node.TEXT_NODE) {
      const block = blockMount(only as Text, root, slots);
      if (block) {
        note(used, block.token);
        const slot = renderSlot(block.token, 'block', slots, input);
        if (tag === 'li') return createElement('li', { key }, slot);
        return createElement(Fragment, { key }, slot);
      }
    }
  }
  const children = renderNodeList(element.childNodes, root, slots, used, input);
  if (tag === 'br' || tag === 'hr') return createElement(tag, { key });
  return createElement(tag, { key }, children);
}

function renderText(
  node: Text,
  root: HTMLElement,
  slots: DisplaySlot[],
  used: Map<string, number>,
  input: ComposeInput,
  key: string
): ReactNode {
  const decisions =
    resolveTransportedTextNodes({
      nodes: [
        {
          text: node.data,
          ancestors: ancestorsOf(node, root),
          exclusiveBlock: exclusiveOf(node),
        },
      ],
      slots,
    })[0] ?? [];
  return createElement(
    Fragment,
    { key },
    decisions.map((decision, index) => {
      if (decision.type === 'text') return createElement(Fragment, { key: index }, decision.text);
      note(used, decision.token);
      if (decision.type === 'mount') {
        return createElement(
          Fragment,
          { key: index },
          renderSlot(decision.token, decision.placement, slots, input)
        );
      }
      return createElement(Fragment, { key: index }, decision.text);
    })
  );
}

function blockMount(node: Text, root: HTMLElement, slots: DisplaySlot[]): { token: string } | null {
  const decisions =
    resolveTransportedTextNodes({
      nodes: [
        {
          text: node.data,
          ancestors: ancestorsOf(node, root),
          exclusiveBlock: exclusiveOf(node),
        },
      ],
      slots,
    })[0] ?? [];
  const only = decisions[0];
  if (decisions.length === 1 && only?.type === 'mount' && only.placement === 'block') {
    return { token: only.token };
  }
  return null;
}

function renderSlot(
  token: string,
  placement: 'inline' | 'block',
  slots: DisplaySlot[],
  input: ComposeInput
): ReactNode {
  const slot = slots.find((entry) => entry.token === token);
  if (!slot) return null;
  const nodes = resolveTrustedTree(slot.tree, slot.match_text, slot.captures).map((node) =>
    mapText(node, (text) => replaceUserPlaceholder(text, input.displayName))
  );
  const scope = ruleScopeClass(input.messageKey, slot.rule_id);
  const tree = createElement(TrustedTree, {
    nodes,
    messageKey: input.messageKey,
    ruleId: slot.rule_id,
    start: slot.start,
    end: slot.end,
    choices: slot.choices,
    interactive: input.interactive,
    onChoice: input.onChoice,
    openStore: input.openStore,
    detailsDefaultOpen: input.detailsDefaultOpen,
  });
  return createElement(
    placement === 'block' ? 'div' : 'span',
    {
      className: scope,
      // The compiler bans viewport overlays; this local boundary additionally confines paint and stacking.
      style: { contain: 'paint style', isolation: 'isolate', position: 'relative' },
    },
    tree
  );
}

function mapText<T extends ReturnType<typeof resolveTrustedTree>[number]>(
  node: T,
  map: (text: string) => string
): T {
  if (node.type === 'text') return { ...node, text: map(node.text) };
  return {
    ...node,
    children: node.children.map((child) => mapText(child, map)),
  };
}

function ancestorsOf(node: Node, root: HTMLElement): string[] {
  const tags: string[] = [];
  let current = node.parentElement;
  while (current && current !== root) {
    tags.push(current.tagName.toLowerCase());
    current = current.parentElement;
  }
  return tags;
}

function exclusiveOf(node: Text): 'p' | 'li' | null {
  const parent = node.parentElement;
  if (!parent) return null;
  const tag = parent.tagName.toLowerCase();
  if (tag !== 'p' && tag !== 'li') return null;
  if (parent.childNodes.length !== 1 || parent.childNodes[0] !== node) return null;
  return tag;
}

function note(used: Map<string, number>, token: string): void {
  used.set(token, (used.get(token) ?? 0) + 1);
}

function countOccurrences(text: string, token: string): number {
  if (token.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(token, index);
    if (found < 0) return count;
    count += 1;
    index = found + token.length;
  }
  return count;
}
