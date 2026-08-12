// 自研引擎对话链路（M1）的仓库层错误类型。
//
// 会话写入的原子操作在 RPC 里以 SQLSTATE 表达业务判定（见 migration 070 的头部约定），
// 这里把它翻译成 shared 的 ConversationErrorCode，让 M3b 只需要一处 switch 就能决定
// HTTP 状态码，而不必在 handler 里认 Postgres 错误码。

import type { ConversationErrorCode } from '@miniapp/shared';

export class ConversationRepositoryError extends Error {
  constructor(
    readonly code: ConversationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConversationRepositoryError';
  }
}

/** migration 070 头部的 SQLSTATE 约定 */
const SQLSTATE_TO_CODE: Record<string, ConversationErrorCode> = {
  P0002: 'session_not_found',
  '55006': 'session_busy',
  '55000': 'regenerate_not_allowed',
};

export interface PostgrestLikeError {
  code?: string | null;
  message: string;
}

/** RPC 报错统一从这里出去：能识别的 SQLSTATE 转成业务错误码，其余按普通异常抛。 */
export function throwConversationRpcError(
  error: PostgrestLikeError,
  fallbackMessage: string
): never {
  const mapped = error.code ? SQLSTATE_TO_CODE[error.code] : undefined;
  if (mapped) {
    throw new ConversationRepositoryError(mapped, error.message);
  }
  throw new Error(`${fallbackMessage}：${error.message}`);
}
