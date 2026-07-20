/**
 * Keeps JS-Slash-Runner rich-message iframes usable on narrow MiniApp viewports.
 *
 * The renderer owns the iframe and its srcdoc, so the platform applies a small,
 * idempotent responsive layer after each iframe load instead of patching the
 * vendored renderer bundle.
 */

const FRAME_SELECTOR = '.TH-render iframe, iframe[id^="TH-message--"]';
const STYLE_ID = 'miniapp-rich-message-responsive';
const MOBILE_BREAKPOINT = 520;

const OUTER_CSS = `
  .mes_block,
  .mes_text,
  .TH-render,
  .TH-streaming {
    min-width: 0 !important;
    max-width: 100% !important;
  }

  .TH-render,
  .TH-streaming {
    overflow-x: clip !important;
  }

  .TH-render iframe,
  iframe[id^="TH-message--"] {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    border: 0;
  }
`;

const INNER_CSS = `
  html,
  body {
    width: 100% !important;
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  img,
  svg,
  video,
  canvas,
  table,
  pre,
  input,
  textarea,
  select,
  button {
    max-width: 100% !important;
  }

  img,
  video,
  canvas {
    height: auto;
  }

  pre,
  table {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  p,
  li,
  td,
  th,
  a,
  span {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  @media (max-width: ${MOBILE_BREAKPOINT}px) {
    body {
      margin-left: 0 !important;
      margin-right: 0 !important;
      padding-left: clamp(8px, 3vw, 14px) !important;
      padding-right: clamp(8px, 3vw, 14px) !important;
    }

    body > *,
    [class*="max-w-"],
    [class*="min-w-"],
    [style*="min-width"],
    [style*="max-width"] {
      min-width: 0 !important;
      max-width: 100% !important;
    }

    [class*="grid-cols-"] {
      grid-template-columns: minmax(0, 1fr) !important;
    }

    .flex,
    [class*="flex-"] {
      min-width: 0;
    }
  }
`;

const frameCleanups = new WeakMap<HTMLIFrameElement, () => void>();

function ensureOuterStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = OUTER_CSS;
  document.head.appendChild(style);
}

function resizeFrame(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  const height = Math.ceil(
    Math.max(doc.body.scrollHeight, doc.body.offsetHeight, doc.documentElement.scrollHeight)
  );
  if (height > 0) frame.style.height = `${height}px`;
}

function applyResponsiveLayer(frame: HTMLIFrameElement): void {
  try {
    const doc = frame.contentDocument;
    if (!doc?.head || !doc.body) return;

    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = INNER_CSS;
      doc.head.appendChild(style);
    }

    frame.style.width = '100%';
    frame.style.minWidth = '0';
    frame.style.maxWidth = '100%';

    if (!frameCleanups.has(frame)) {
      let resizeRaf = 0;
      const scheduleResize = () => {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => resizeFrame(frame));
      };
      const resizeObserver = new ResizeObserver(scheduleResize);
      resizeObserver.observe(doc.documentElement);
      resizeObserver.observe(doc.body);
      window.addEventListener('resize', scheduleResize, { passive: true });
      frameCleanups.set(frame, () => {
        cancelAnimationFrame(resizeRaf);
        resizeObserver.disconnect();
        window.removeEventListener('resize', scheduleResize);
      });
    }

    requestAnimationFrame(() => resizeFrame(frame));
  } catch {
    // A future renderer may switch away from same-origin srcdoc. Outer sizing
    // still prevents the iframe element itself from overflowing.
  }
}

function registerFrame(frame: HTMLIFrameElement): void {
  if (frame.dataset.miniappResponsive === 'true') {
    applyResponsiveLayer(frame);
    return;
  }
  frame.dataset.miniappResponsive = 'true';
  frame.addEventListener('load', () => {
    frameCleanups.get(frame)?.();
    frameCleanups.delete(frame);
    applyResponsiveLayer(frame);
  });
  applyResponsiveLayer(frame);
}

function scanFrames(root: ParentNode = document): void {
  root.querySelectorAll<HTMLIFrameElement>(FRAME_SELECTOR).forEach(registerFrame);
}

export function installRichMessageResponsive(): void {
  ensureOuterStyles();
  scanFrames();

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(FRAME_SELECTOR) && node instanceof HTMLIFrameElement) registerFrame(node);
        scanFrames(node);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        const frames = node.matches(FRAME_SELECTOR)
          ? [node]
          : Array.from(node.querySelectorAll(FRAME_SELECTOR));
        for (const candidate of frames) {
          if (!(candidate instanceof HTMLIFrameElement)) continue;
          frameCleanups.get(candidate)?.();
          frameCleanups.delete(candidate);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
