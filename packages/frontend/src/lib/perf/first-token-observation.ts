import type { ReportFirstTokenRequest } from '@miniapp/shared';

export interface FirstTokenIdentity {
  requestId: string;
  assistantMessageId: string | null;
  revision: number;
}

/** One monotonic clock for submit, network, and display. The receipt confirms display; it never selects the price. */
export class FirstTokenObservation {
  readonly startedAt = performance.now();
  private timer: ReturnType<typeof setTimeout>;
  private outcome: ReportFirstTokenRequest['outcome'] | null = null;
  private visibleMs: number | null = null;
  private dispatchedMs: number | null = null;
  private receivedMs: number | null = null;
  private backgrounded = document.visibilityState !== 'visible';
  private reason: ReportFirstTokenRequest['reason'] = null;
  private reported = false;
  private finishedMs: number | null = null;
  private visibility = () => {
    if (document.visibilityState !== 'visible') {
      this.backgrounded = true;
      this.unavailable('page_left');
    }
  };

  constructor(
    public identity: FirstTokenIdentity,
    readonly deadlineMs: number,
    private readonly report: (body: ReportFirstTokenRequest) => void,
    private readonly onTimeout: () => void
  ) {
    this.timer = setTimeout(() => this.expire(), deadlineMs);
    document.addEventListener('visibilitychange', this.visibility);
  }

  identify(assistantMessageId: string, revision: number): void {
    this.identity = { ...this.identity, assistantMessageId, revision };
    this.flush();
  }
  dispatched(): void {
    this.dispatchedMs ??= performance.now() - this.startedAt;
  }
  received(): void {
    this.receivedMs ??= performance.now() - this.startedAt;
    // A received token must not be cancelled because the user is reading older messages.
    clearTimeout(this.timer);
  }
  get hasDisplayedToken(): boolean {
    return this.outcome === 'observed';
  }
  get hasReceivedToken(): boolean {
    return this.receivedMs !== null;
  }
  get timedOut(): boolean {
    return this.outcome === 'timed_out';
  }
  displayed(identity: FirstTokenIdentity, at: number): boolean {
    if (
      this.outcome === 'observed' ||
      (this.outcome === 'not_observed' && this.reason !== 'page_left') ||
      document.visibilityState !== 'visible' ||
      identity.requestId !== this.identity.requestId ||
      identity.assistantMessageId !== this.identity.assistantMessageId ||
      identity.revision !== this.identity.revision
    )
      return false;
    const duration = at - this.startedAt;
    this.reported = false;
    this.outcome = 'observed';
    this.reason = null;
    this.visibleMs = duration;
    this.finishedMs = duration;
    this.finish();
    return true;
  }
  deadlineFailed(
    reason: 'server_timeout' | 'fallback_timeout' | 'primary_timeout' = 'server_timeout'
  ): void {
    if (this.outcome) return;
    // A provider-stage failure may arrive before the user's total deadline. Keep it distinct.
    this.outcome =
      performance.now() - this.startedAt >= this.deadlineMs ? 'timed_out' : 'not_observed';
    this.reason = reason;
    this.finish();
  }
  private expire(): void {
    if (this.outcome || this.receivedMs !== null) return;
    if (this.backgrounded || document.visibilityState !== 'visible') {
      this.backgrounded = true;
      this.unavailable('page_left');
      return;
    }
    this.outcome = 'timed_out';
    this.reason = 'not_visible';
    this.finish();
    this.onTimeout();
  }
  unavailable(reason: ReportFirstTokenRequest['reason']): void {
    if (!this.outcome) {
      this.outcome = 'not_observed';
      this.reason = reason;
      this.finish();
    }
  }
  private finish(): void {
    this.finishedMs ??= performance.now() - this.startedAt;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.visibility);
    this.flush();
  }
  private flush(): void {
    if (!this.outcome || !this.identity.assistantMessageId || this.reported) return;
    this.reported = true;
    this.report({
      request_id: this.identity.requestId,
      assistant_message_id: this.identity.assistantMessageId,
      revision: this.identity.revision,
      measurement_method: 'visible_dom_after_frame_v3',
      wait_finished_ms: this.finishedMs,
      outcome: this.outcome,
      first_token_visible_ms: this.visibleMs,
      request_dispatched_ms: this.dispatchedMs,
      first_token_received_ms: this.receivedMs,
      backgrounded: this.backgrounded,
      reason: this.reason,
    });
  }
}

/** Detect actual text DOM in the viewport, including scrolling ancestor clipping. */
export function hasVisibleToken(node: HTMLElement): boolean {
  if (!node.isConnected || document.visibilityState !== 'visible') return false;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let text: Node | null;
  while ((text = walker.nextNode())) {
    const content = text.textContent ?? '';
    if (!/\S/.test(content)) continue;
    let left = 0,
      top = 0,
      right = window.innerWidth,
      bottom = window.innerHeight;
    for (let element = text.parentElement; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        Number(style.opacity) === 0
      ) {
        right = left;
        break;
      }
      const clip = element.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    if (right <= left || bottom <= top) continue;
    // A streaming paragraph can be one text node whose first character has scrolled away.
    // Check every non-whitespace run, not the first character or whitespace-only line boxes.
    const range = document.createRange();
    for (const match of content.matchAll(/\S+/gu)) {
      range.setStart(text, match.index);
      range.setEnd(text, match.index + match[0].length);
      if (
        Array.from(range.getClientRects()).some(
          (rect) =>
            Math.min(right, rect.right) > Math.max(left, rect.left) &&
            Math.min(bottom, rect.bottom) > Math.max(top, rect.top)
        )
      )
        return true;
    }
  }
  return false;
}

/** Double rAF gives committed text a paint opportunity; it is not a pixel acknowledgement. */
export function observeFirstVisibleToken(
  node: HTMLElement,
  onVisible: (at: number) => void
): () => void {
  let frame = 0,
    stopped = false;
  const check = () => {
    if (stopped || frame || !hasVisibleToken(node)) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!stopped && hasVisibleToken(node)) {
          stop();
          onVisible(performance.now());
        }
      });
    });
  };
  const mutation = new MutationObserver(check);
  mutation.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
  const intersection = new IntersectionObserver(check, { rootMargin: '0px' });
  intersection.observe(node);
  document.addEventListener('visibilitychange', check);
  node.addEventListener('animationend', check, true);
  node.addEventListener('transitionend', check, true);
  window.addEventListener('scroll', check, true);
  window.addEventListener('resize', check);
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    mutation.disconnect();
    intersection.disconnect();
    document.removeEventListener('visibilitychange', check);
    node.removeEventListener('animationend', check, true);
    node.removeEventListener('transitionend', check, true);
    window.removeEventListener('scroll', check, true);
    window.removeEventListener('resize', check);
  };
  check();
  return stop;
}
