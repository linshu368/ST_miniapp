# Design

## Reuse research

Read AGENTS, README, ARCHITECTURE, backend/shared indexes and specialist specs, cross-layer guide; inspected bot.ts, bot-cs-forward.test.ts, cs-service.ts, config.ts, shared support.ts, and community.ts. Extend existing authenticated main webhook, shared support DTO, callCsService with its 5-second timeout, and current tests. Community Bot has no first-version consumer and stays untouched. No parallel HTTP client, queue, LLM or user repository.

## Contract and flow

Add TelegramGroupMessageInput in shared/api/support.ts matching CS GroupMessageInput: chat_id/chat_title/message_id/telegram_user_id/sender_name/is_bot/text/sent_at/reply_to_message_id/photo_file_id/edited/bot_source/sender_chat_id/message_thread_id/edited_at. IDs are strings; group IDs may be negative. sent_at is ISO. text uses text or caption; largest photo or allowed image-document supplies file_id.

Authenticate then identify message/edited_message group type before /start parsing. Require explicit enabled flag and nonempty matching group-ID allowlist. Validate required message ID/date. sender_chat forces telegram_user_id null even with fake from. Forward via /internal/telegram/group-message without user creation. Existing private path explicitly requires message.chat.type=private; private edits remain ignored.

## Reliability

CS only persists receipt; main never downloads images. Keep the existing 5-second request deadline, no inline retries. Both 2xx and success:true envelope are required; errors contain only status, never response bodies. Return 503 on allowed-group forwarding failure for Telegram retry. CS owns idempotency by chat/message and edited-message convergence. No main DB transaction or compensation is needed because it has no group writes. No new queue/process state; Telegram delivery retention is at most 24 hours. Existing Fastify/Telegram message limits bound payloads.

## Minimal solution, rollout and recovery

Only existing files plus a service-client test; no new framework, dependency or database. CS receiver first, main producer next with switch disabled. Before enabling, both sides need matching configured groups and manual integration verification. Disabling the switch stops collection. Private route unchanged except explicit isolation. Wrong group-to-private routing is a stop condition. No data migration or automatic deployment.

## Protocol evidence

https://core.telegram.org/bots/api#getting-updates: webhook/polling are exclusive; pending updates max 24h. Batch reads our buffer, not Telegram history.
https://core.telegram.org/bots/api#message: group-scoped message ID, sender_chat fake from, replies and edits.
https://core.telegram.org/bots/features#privacy-mode: group admin or privacy disabled needed for ordinary messages.
https://core.telegram.org/bots/webapps#webappuser: DM permission independent from group membership.

Planning reviewed by root and independent reviewer on 2026-10-22 before task start. Root added edited_at ISO for monotonic edit handling. Disabled/unconfigured ingestion acknowledges and drops incoming group messages; no retrospective history recovery.
