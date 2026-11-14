/** Internal log metadata, never an API DTO or an authorization decision. */
export interface BusinessFields {
  business_module?: string;
  user_id?: string;
  telegram_user_id?: string;
  session_id?: string;
  character_id?: string;
  creation_id?: string;
  drama_id?: string;
  video_id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULES = new Set(['chat', 'character', 'creator', 'drama', 'image', 'voice', 'payment']);
const ID_ALIASES = {
  user_id: 'userId',
  session_id: 'sessionId',
  character_id: 'characterId',
  creation_id: 'creationId',
  drama_id: 'dramaId',
  video_id: 'videoId',
} as const;

export function safeBusinessFields(record: object): BusinessFields {
  const source = record as Record<string, unknown>;
  const result: BusinessFields = {};
  for (const [key, alias] of Object.entries(ID_ALIASES)) {
    const value = source[key] ?? source[alias];
    if (typeof value === 'string' && UUID.test(value))
      result[key as keyof typeof ID_ALIASES] = value.toLowerCase();
  }
  if (typeof source.business_module === 'string' && MODULES.has(source.business_module))
    result.business_module = source.business_module;
  // Only the canonical field is accepted; legacy numeric userId is not an internal user UUID.
  if (
    typeof source.telegram_user_id === 'string' &&
    /^[1-9][0-9]{0,15}$/.test(source.telegram_user_id) &&
    Number.isSafeInteger(Number(source.telegram_user_id))
  )
    result.telegram_user_id = source.telegram_user_id;
  return result;
}

/** Business identifiers are authorized for Railway stdout, not other telemetry exports. */
export function withoutBusinessIds<T extends Record<string, unknown>>(record: T): T {
  const result = { ...record };
  for (const [key, alias] of Object.entries(ID_ALIASES)) {
    delete result[key];
    delete result[alias];
  }
  delete result.telegram_user_id;
  delete result.telegramUserId;
  return result;
}
