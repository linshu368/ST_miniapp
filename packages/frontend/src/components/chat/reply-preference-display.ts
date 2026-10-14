export type ReplyDetailsDefaultOpen = Readonly<Record<'status' | 'memory' | 'choice', boolean>>;

export const DEFAULT_REPLY_DETAILS_OPEN: ReplyDetailsDefaultOpen = {
  status: true,
  memory: false,
  choice: true,
};

const DETAILS_OPEN_STORAGE_KEY = 'st.chat.reply-details-default-open.v1';

/** 纯展示偏好，不参与模型规则或服务端配置。 */
export function readReplyDetailsDefaultOpen(): ReplyDetailsDefaultOpen {
  if (typeof window === 'undefined') return DEFAULT_REPLY_DETAILS_OPEN;
  try {
    const raw = window.localStorage.getItem(DETAILS_OPEN_STORAGE_KEY);
    if (!raw) return DEFAULT_REPLY_DETAILS_OPEN;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return DEFAULT_REPLY_DETAILS_OPEN;
    const value = stored as Partial<Record<'status' | 'memory' | 'choice', unknown>>;
    return {
      status: typeof value.status === 'boolean' ? value.status : DEFAULT_REPLY_DETAILS_OPEN.status,
      memory: typeof value.memory === 'boolean' ? value.memory : DEFAULT_REPLY_DETAILS_OPEN.memory,
      choice: typeof value.choice === 'boolean' ? value.choice : DEFAULT_REPLY_DETAILS_OPEN.choice,
    };
  } catch {
    return DEFAULT_REPLY_DETAILS_OPEN;
  }
}

export function writeReplyDetailsDefaultOpen(value: ReplyDetailsDefaultOpen): void {
  try {
    window.localStorage.setItem(DETAILS_OPEN_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // WebView 隐私模式或存储配额满时，当前页面内的展示状态仍可继续使用。
  }
}
