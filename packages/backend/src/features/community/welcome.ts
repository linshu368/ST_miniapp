import type { FastifyBaseLogger } from 'fastify';

import { buildMiniappDeepLink } from '../../lib/telegram-links.js';
import { config } from '../../platform/config.js';

/**
 * 入群欢迎语：由发奖 bot（TELEGRAM_COMMUNITY_BOT_TOKEN）在发奖结果确定后发到官方群。
 * 发奖 webhook 最清楚「这次有没有发、发了多少」，所以欢迎语挂在这里而不是群管 bot。
 */
const NAME_MAX = 24;
const TELEGRAM_TIMEOUT_MS = 5_000;
export const COMMUNITY_WELCOME_START_PARAM = 'community';

export interface CommunityWelcomeInput {
  chatId: string;
  telegramUserId: number;
  firstName?: string;
  lastName?: string;
  /** 本次到账的星尘；null 表示还没有账号、没有奖励 */
  rewardCredits: number | null;
}

export interface CommunityWelcomeMessage {
  text: string;
  buttonText: string;
}

// 群里只留最新一条欢迎语。只记在进程内：重启后最多残留一条，不值得为此持久化。
let lastWelcome: { chatId: string; messageId: number } | null = null;

export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function welcomeDisplayName(firstName?: string, lastName?: string): string {
  const name = [firstName, lastName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(name || '新朋友');
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX).join('')}…` : chars.join('');
}

export function buildCommunityWelcome(input: CommunityWelcomeInput): CommunityWelcomeMessage {
  const name = escapeTelegramHtml(welcomeDisplayName(input.firstName, input.lastName));
  const mention = `<a href="tg://user?id=${input.telegramUserId}">${name}</a>`;
  if (input.rewardCredits !== null) {
    return {
      text: `🎉 欢迎 ${mention} 加入秘境社群！\n入群奖励 <b>${input.rewardCredits} 星尘</b>已到账。`,
      buttonText: '回到秘境继续聊 ›',
    };
  }
  return {
    text: `🎉 欢迎 ${mention} 加入秘境社群！\n点下面的按钮进入秘境，和角色们聊起来。`,
    buttonText: '进入秘境 ›',
  };
}

async function callTelegram(method: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramCommunityBotToken}/${method}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    }
  );
  const payload = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram ${method} failed (${response.status})`);
  }
  return payload.result;
}

/** 发欢迎语；失败只记日志。sendMessage 不是幂等操作，不重试。 */
export async function sendCommunityWelcome(
  input: CommunityWelcomeInput,
  log: FastifyBaseLogger
): Promise<void> {
  if (!config.telegramCommunityBotToken) return;
  const started = Date.now();
  try {
    const message = buildCommunityWelcome(input);
    const link = await buildMiniappDeepLink(COMMUNITY_WELCOME_START_PARAM);
    const result = ((await callTelegram('sendMessage', {
      chat_id: input.chatId,
      text: message.text,
      parse_mode: 'HTML',
      disable_notification: true,
      link_preview_options: { is_disabled: true },
      ...(link
        ? { reply_markup: { inline_keyboard: [[{ text: message.buttonText, url: link }]] } }
        : {}),
    })) ?? {}) as { message_id?: number };
    const previous = lastWelcome;
    lastWelcome =
      typeof result.message_id === 'number'
        ? { chatId: input.chatId, messageId: result.message_id }
        : previous;
    log.info(
      {
        event: 'community.welcome.sent',
        rewarded: input.rewardCredits !== null,
        with_button: Boolean(link),
        duration_ms: Date.now() - started,
      },
      '[community] welcome sent'
    );
    if (previous && previous.chatId === input.chatId && previous.messageId !== result.message_id) {
      await callTelegram('deleteMessage', {
        chat_id: previous.chatId,
        message_id: previous.messageId,
      }).catch((err: unknown) =>
        log.debug({ err, event: 'community.welcome.delete_failed' }, '[community] old welcome kept')
      );
    }
  } catch (err) {
    log.warn(
      { err, event: 'community.welcome.failed', duration_ms: Date.now() - started },
      '[community] welcome failed'
    );
  }
}
