/**
 * Stabilizes ST's native reasoning block during streaming.
 *
 * Native stream fade re-animates the accumulated reasoning on every token.
 * This patch keeps the content fully opaque, presents a lightweight header
 * indicator, and collapses completed reasoning without deleting it.
 */

export type ReasoningUiState = 'idle' | 'thinking' | 'completing' | 'completed';

const DETAILS_SELECTOR = '.mes_reasoning_details';
const STYLE_ID = 'miniapp-reasoning-stream-ui';
const COMPLETE_TRANSITION_MS = 220;
const stateByDetails = new WeakMap<HTMLDetailsElement, ReasoningUiState>();
const completionTimers = new WeakMap<HTMLDetailsElement, number>();

const CSS = `
  .mes_reasoning_details .mes_reasoning .text_segment {
    animation: none !important;
    opacity: 1 !important;
  }

  .mes_reasoning_details[data-miniapp-reasoning-state="thinking"] .mes_reasoning_header {
    color: var(--SmartThemeBodyColor);
  }

  .miniapp-reasoning-dots {
    display: inline-flex;
    width: 1.5em;
    margin-left: 0.28em;
    letter-spacing: 0.08em;
  }

  .miniapp-reasoning-dots::after {
    content: "...";
    display: inline-block;
    width: 0;
    overflow: hidden;
    vertical-align: bottom;
    animation: miniapp-reasoning-dots 1.2s steps(4, end) infinite;
  }

  .mes_reasoning_details[data-miniapp-reasoning-state="completing"] .mes_reasoning {
    opacity: 0;
    transform: translateY(-3px);
    transition:
      opacity ${COMPLETE_TRANSITION_MS}ms ease,
      transform ${COMPLETE_TRANSITION_MS}ms ease;
  }

  .mes_reasoning_details[data-miniapp-reasoning-state="completed"] .mes_reasoning {
    opacity: 1;
    transform: none;
  }

  @keyframes miniapp-reasoning-dots {
    to {
      width: 1.5em;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .miniapp-reasoning-dots::after {
      width: 1.5em;
      animation: none;
    }

    .mes_reasoning_details[data-miniapp-reasoning-state="completing"] .mes_reasoning {
      transition: none;
    }
  }
`;

export function resolveReasoningUiState(
  nativeState: string | undefined,
  hasContent: boolean
): ReasoningUiState {
  if (nativeState === 'thinking') return 'thinking';
  if ((nativeState === 'done' || nativeState === 'hidden') && hasContent) return 'completed';
  return 'idle';
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function getTitle(details: HTMLDetailsElement): HTMLElement | null {
  return details.querySelector<HTMLElement>('.mes_reasoning_header_title');
}

function renderThinkingTitle(details: HTMLDetailsElement): void {
  const title = getTitle(details);
  if (!title) return;
  if (title.firstChild?.textContent !== '思考中') title.textContent = '思考中';
  if (!title.querySelector('.miniapp-reasoning-dots')) {
    const dots = document.createElement('span');
    dots.className = 'miniapp-reasoning-dots';
    dots.setAttribute('aria-hidden', 'true');
    title.appendChild(dots);
  }
}

function renderCompletedTitle(details: HTMLDetailsElement): void {
  const title = getTitle(details);
  if (title && title.textContent !== '思考完成') title.textContent = '思考完成';
}

function cancelCompletion(details: HTMLDetailsElement): void {
  const timer = completionTimers.get(details);
  if (timer !== undefined) window.clearTimeout(timer);
  completionTimers.delete(details);
}

function setUiDataset(details: HTMLDetailsElement, state: ReasoningUiState): void {
  if (details.dataset.miniappReasoningState !== state) {
    details.dataset.miniappReasoningState = state;
  }
}

function setState(details: HTMLDetailsElement, state: ReasoningUiState): void {
  const previous = stateByDetails.get(details) ?? 'idle';

  if (state === 'thinking') {
    cancelCompletion(details);
    stateByDetails.set(details, state);
    setUiDataset(details, state);
    if (previous !== 'thinking') details.open = true;
    renderThinkingTitle(details);
    return;
  }

  if (state === 'completed') {
    renderCompletedTitle(details);
    if (previous === 'thinking') {
      stateByDetails.set(details, 'completing');
      setUiDataset(details, 'completing');
      cancelCompletion(details);
      const timer = window.setTimeout(() => {
        details.open = false;
        setUiDataset(details, 'completed');
        stateByDetails.set(details, 'completed');
        completionTimers.delete(details);
      }, COMPLETE_TRANSITION_MS);
      completionTimers.set(details, timer);
      return;
    }

    stateByDetails.set(details, 'completed');
    setUiDataset(details, 'completed');
    if (previous === 'idle') details.open = false;
    return;
  }

  cancelCompletion(details);
  stateByDetails.set(details, 'idle');
  setUiDataset(details, 'idle');
}

function syncDetails(details: HTMLDetailsElement): void {
  const content = details.querySelector<HTMLElement>('.mes_reasoning');
  const state = resolveReasoningUiState(
    details.dataset.state,
    Boolean(content?.textContent?.trim())
  );
  setState(details, state);
}

function scan(root: ParentNode = document): void {
  if (root instanceof HTMLDetailsElement && root.matches(DETAILS_SELECTOR)) syncDetails(root);
  root.querySelectorAll<HTMLDetailsElement>(DETAILS_SELECTOR).forEach(syncDetails);
}

export function installReasoningStreamUi(): void {
  installStyles();
  scan();

  let animationFrame = 0;
  const pending = new Set<HTMLDetailsElement>();
  const schedule = (details: HTMLDetailsElement) => {
    pending.add(details);
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      for (const item of pending) syncDetails(item);
      pending.clear();
    });
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const details =
        record.target instanceof Element
          ? record.target.closest<HTMLDetailsElement>(DETAILS_SELECTOR)
          : record.target.parentElement?.closest<HTMLDetailsElement>(DETAILS_SELECTOR);
      if (details) schedule(details);

      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLDetailsElement && node.matches(DETAILS_SELECTOR)) schedule(node);
        node.querySelectorAll<HTMLDetailsElement>(DETAILS_SELECTOR).forEach(schedule);
      }
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-state'],
    childList: true,
    characterData: true,
    subtree: true,
  });
}
