/**
 * Restores generated-message bold rendering when malformed spacing or a
 * third-party Markdown optimization leaves literal **markers** in the DOM.
 *
 * This is deliberately a display-only fallback. It never touches source chat
 * data, code blocks, editable areas, or rich-message iframe content.
 */

export type BoldSegment = { text: string; bold: boolean };

const BOLD_PATTERN = /\*\*[ \t]*(\S(?:[^\n]*?\S)?)[ \t]*\*\*/g;
const EXCLUDED_SELECTOR =
  'strong, b, code, pre, script, style, textarea, input, [contenteditable="true"], .TH-render';
const STYLE_ID = 'miniapp-markdown-bold-fallback';

export function splitBoldSegments(text: string): BoldSegment[] {
  const segments: BoldSegment[] = [];
  let cursor = 0;
  BOLD_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(BOLD_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), bold: false });
    segments.push({ text: match[1] ?? '', bold: true });
    cursor = index + match[0].length;
  }

  if (cursor === 0) return [{ text, bold: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), bold: false });
  return segments;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #chat .mes_text strong,
    #chat .mes_text b {
      font-weight: 700 !important;
      color: inherit;
    }
  `;
  document.head.appendChild(style);
}

function formatTextNode(node: Text): void {
  if (!node.data.includes('**')) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(EXCLUDED_SELECTOR)) return;

  const segments = splitBoldSegments(node.data);
  if (!segments.some((segment) => segment.bold)) return;

  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    if (!segment.text) continue;
    if (segment.bold) {
      const strong = document.createElement('strong');
      strong.textContent = segment.text;
      fragment.appendChild(strong);
    } else {
      fragment.appendChild(document.createTextNode(segment.text));
    }
  }
  node.replaceWith(fragment);
}

function formatRoot(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  nodes.forEach(formatTextNode);
}

export function installMarkdownBoldFallback(): void {
  installStyles();

  let animationFrame = 0;
  const pendingRoots = new Set<ParentNode>();
  const schedule = (root: ParentNode) => {
    pendingRoots.add(root);
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      for (const pendingRoot of pendingRoots) formatRoot(pendingRoot);
      pendingRoots.clear();
    });
  };

  document.querySelectorAll<HTMLElement>('#chat .mes_text').forEach(schedule);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target =
        record.target instanceof Element
          ? record.target.closest<HTMLElement>('.mes_text')
          : record.target.parentElement?.closest<HTMLElement>('.mes_text');
      if (target) schedule(target);

      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches('.mes_text')) schedule(node);
        node.querySelectorAll<HTMLElement>('.mes_text').forEach(schedule);
      }
    }
  });

  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
}
