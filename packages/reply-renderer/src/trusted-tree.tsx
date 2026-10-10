import {
  createElement,
  Fragment,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { resolveTrustedTree, type TextPostprocessChoice } from '@miniapp/shared';

import type { ReplyChoicePayload } from './types';

type ResolvedNode = ReturnType<typeof resolveTrustedTree>[number];
type ResolvedElement = Extract<ResolvedNode, { type: 'element' }>;

const CHOICE_STYLE: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  touchAction: 'manipulation',
};

const SUMMARY_STYLE: CSSProperties = {
  minHeight: 44,
  display: 'flex',
  alignItems: 'center',
  touchAction: 'manipulation',
};

interface TreeContext {
  nodes: ResolvedNode[];
  messageKey: string;
  ruleId: string;
  start: number;
  end: number;
  choices: TextPostprocessChoice[];
  interactive: boolean;
  onChoice?: (choice: ReplyChoicePayload) => void;
  openStore: Map<string, boolean>;
}

export function TrustedTree(props: TreeContext) {
  return props.nodes.map((node, index) => renderResolved(node, String(index), props));
}

function renderResolved(node: ResolvedNode, path: string, context: TreeContext): ReactNode {
  if (node.type === 'text') return createElement(Fragment, { key: path }, node.text);
  if (node.tag === 'details') {
    return createElement(TrustedDetails, {
      key: `${context.messageKey}:${path}`,
      node,
      path,
      context,
    });
  }

  const children = node.children.map((child, index) =>
    renderResolved(child, `${path}.${index}`, context)
  );
  if (node.tag === 'br' || node.tag === 'hr') {
    return createElement(node.tag, { ...attributesOf(node), key: path });
  }
  if (node.tag === 'button' && node.action?.type === 'send-message') {
    const choice = context.choices[countButtonsBefore(context.nodes, path)];
    const disabled = !context.interactive || !choice?.sendable;
    return createElement(
      'button',
      {
        ...attributesOf(node),
        key: path,
        type: 'button',
        disabled,
        style: CHOICE_STYLE,
        onClick: (event: MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();
          if (disabled || !choice) return;
          context.onChoice?.({
            text: choice.text,
            ruleId: context.ruleId,
            start: context.start,
            end: context.end,
          });
        },
      },
      children
    );
  }
  return createElement(node.tag, { ...attributesOf(node), key: path }, children);
}

function TrustedDetails(input: { node: ResolvedElement; path: string; context: TreeContext }) {
  const stateKey = `${input.context.messageKey}:${input.context.ruleId}:${input.context.start}:${input.context.end}:${input.path}`;
  const defaultOpen = input.node.attributes.some((attribute) => attribute.name === 'open');
  const [open, setOpen] = useState(() => input.context.openStore.get(stateKey) ?? defaultOpen);
  const fromKeyboard = useRef(false);
  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      input.context.openStore.set(stateKey, next);
      return next;
    });
  };
  return createElement(
    'details',
    { open },
    input.node.children.map((child, index) => {
      const childPath = `${input.path}.${index}`;
      if (child.type === 'element' && child.tag === 'summary') {
        return createElement(
          'summary',
          {
            ...attributesOf(child),
            key: childPath,
            style: SUMMARY_STYLE,
            tabIndex: 0,
            onClick: (event: MouseEvent<HTMLElement>) => {
              event.preventDefault();
              if (fromKeyboard.current) {
                fromKeyboard.current = false;
                return;
              }
              toggle();
            },
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              fromKeyboard.current = true;
              toggle();
            },
          },
          child.children.map((summaryChild, summaryIndex) =>
            renderResolved(summaryChild, `${childPath}.${summaryIndex}`, input.context)
          )
        );
      }
      return renderResolved(child, childPath, input.context);
    })
  );
}

function attributesOf(node: ResolvedElement): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of node.attributes) {
    if (attribute.name === 'class') result.className = attribute.tokens.join(' ');
    else if (attribute.name === 'title') result.title = attribute.text;
    else if (attribute.name === 'aria-label') result['aria-label'] = attribute.text;
    else if (attribute.name === 'aria-hidden') result['aria-hidden'] = attribute.value;
    else if (attribute.name === 'colspan') result.colSpan = attribute.value;
    else if (attribute.name === 'rowspan') result.rowSpan = attribute.value;
    else if (attribute.name === 'attribute')
      result[reactAttributeName(attribute.key)] = attribute.value;
  }
  return result;
}

function reactAttributeName(name: string): string {
  if (name === 'tabindex') return 'tabIndex';
  if (name === 'spellcheck') return 'spellCheck';
  if (name === 'autocapitalize') return 'autoCapitalize';
  return name;
}

function countButtonsBefore(nodes: ResolvedNode[], path: string): number {
  let count = 0;
  let found = false;
  const visit = (node: ResolvedNode, current: string) => {
    if (found || node.type === 'text') return;
    if (node.tag === 'button' && node.action?.type === 'send-message') {
      if (current === path) {
        found = true;
        return;
      }
      count += 1;
    }
    node.children.forEach((child, index) => visit(child, `${current}.${index}`));
  };
  nodes.forEach((node, index) => visit(node, String(index)));
  return count;
}
