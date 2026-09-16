import type { CapturedNetworkRequest, SessionRecordingOptions } from 'posthog-js';

/** 官方 web `blockClass` 默认值；元素在回放中被占位块替换。 */
export const PH_NO_CAPTURE_CLASS = 'ph-no-capture';

/** 官方 web `maskTextClass` 默认值；屏蔽非输入文本。 */
export const PH_MASK_TEXT_CLASS = 'ph-mask';

/**
 * 已批准的聊天消息区（气泡 + composer）。
 * web 没有 `ph-no-mask`；用该类让 `maskInputFn` 对输入取消掩码。
 */
export const PH_CHAT_REPLAY_VISIBLE_CLASS = 'ph-chat-replay-visible';

const SENSITIVE_QUERY_PARAM =
  /([?&#](?:pay_url|payUrl|token|auth|authorization|password|secret|initData|init_data|rawInitData|tgWebAppData|code|otp)=)[^&#\s]*/gi;

export function isInsideChatReplayVisible(element: HTMLElement | undefined): boolean {
  if (!element) return false;
  return Boolean(element.closest(`.${PH_CHAT_REPLAY_VISIBLE_CLASS}`));
}

export function maskReplayInput(text: string, element?: HTMLElement): string {
  if (isInsideChatReplayVisible(element)) return text;
  return '*'.repeat(text.length);
}

export function redactCapturedNetworkRequest(
  request: CapturedNetworkRequest
): CapturedNetworkRequest | undefined {
  const copy: CapturedNetworkRequest = { ...request };
  if (typeof copy.name === 'string') {
    copy.name = redactReplayUrl(copy.name);
  }
  copy.requestBody = undefined;
  copy.responseBody = undefined;
  copy.requestHeaders = undefined;
  copy.responseHeaders = undefined;
  return copy;
}

export function redactReplayUrl(value: string): string {
  const withoutSensitiveQuery = value.replace(SENSITIVE_QUERY_PARAM, '$1[REDACTED]');
  try {
    const url = new URL(withoutSensitiveQuery);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    const cut = withoutSensitiveQuery.split('#')[0] ?? withoutSensitiveQuery;
    return cut.split('?')[0] ?? cut;
  }
}

export function maskReplayAttribute(name: string, value: string): string {
  const normalized = name.toLowerCase();
  if (
    normalized === 'href' ||
    normalized === 'src' ||
    normalized === 'action' ||
    normalized === 'formaction' ||
    normalized === 'cite'
  ) {
    return redactReplayUrl(value);
  }
  return value;
}

export function buildSessionRecordingOptions(): SessionRecordingOptions {
  return {
    maskAllInputs: true,
    maskInputFn: maskReplayInput,
    maskTextSelector: `.${PH_MASK_TEXT_CLASS}`,
    maskAttributeFn: maskReplayAttribute,
    recordBody: false,
    recordHeaders: false,
    streamNetworkBody: false,
    captureJsonLd: false,
    maskCapturedNetworkRequestFn: redactCapturedNetworkRequest,
  };
}
