import { config } from '../platform/config.js';

/** 客服服务在 Vercel 上，正常几百毫秒；超时宁可快速失败也不拖住 Telegram webhook */
const CS_SERVICE_TIMEOUT_MS = 5_000;
/** 带图片的请求要多一次图片下载/上传到 Storage，给更长的时间 */
export const CS_SERVICE_IMAGE_TIMEOUT_MS = 20_000;

export interface CsServiceResponse {
  status: number;
  /** 客服服务返回的是与本仓库一致的 { success, data | error } 信封，原样透传 */
  payload: unknown;
}

export function isCsServiceEnabled(): boolean {
  return config.csService.enabled;
}

export async function callCsService(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = CS_SERVICE_TIMEOUT_MS
): Promise<CsServiceResponse> {
  if (!config.csService.url || !config.csService.secret) {
    throw new Error('CS_SERVICE_URL / CS_SERVICE_SECRET is not configured');
  }
  const response = await fetch(`${config.csService.url}${path}`, {
    method,
    headers: {
      'x-cs-internal-secret': config.csService.secret,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (payload === null) {
    throw new Error(`cs service returned non-JSON response: HTTP ${response.status}`);
  }
  return { status: response.status, payload };
}

export async function forwardBotMessageToCs(input: {
  userId: string;
  telegramUserId: string;
  messageId: string;
  text: string;
  /** 图片消息的 file_id，客服服务自己去 Telegram 下载 */
  photoFileId: string | null;
  replyToMessageId: string | null;
}): Promise<void> {
  const { status, payload } = await callCsService(
    'POST',
    '/internal/telegram/bot-message',
    {
      user_id: input.userId,
      telegram_user_id: input.telegramUserId,
      message_id: input.messageId,
      text: input.text,
      photo_file_id: input.photoFileId,
      reply_to_message_id: input.replyToMessageId,
    },
    input.photoFileId ? CS_SERVICE_IMAGE_TIMEOUT_MS : undefined
  );
  if (status >= 400) {
    throw new Error(`cs service rejected bot message: HTTP ${status} ${JSON.stringify(payload)}`);
  }
}
