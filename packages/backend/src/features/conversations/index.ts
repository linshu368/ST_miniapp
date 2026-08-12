/**
 * backend / features / conversations / index.ts
 *
 * 自研对话链路（M3b）对 backend 内部的出口。routes/conversations.ts 只消费这里的东西。
 */

export { buildEngineHistory } from './history.js';

export { createReplyStreamSink, encodeStreamEvent, type ConversationStreamSink } from './sse.js';

export { conversationErrorStatus, sendConversationError } from './errors.js';

export {
  runConversationTurn,
  toEngineCharacter,
  toMessageStatus,
  type ConversationTurnMode,
  type ConversationTurnOutcome,
  type RunConversationTurnInput,
} from './generate.js';
