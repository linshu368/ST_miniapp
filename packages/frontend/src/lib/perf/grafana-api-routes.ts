/**
 * Bounded API groups accepted by the browser telemetry exporter.
 * Keeping this list separate prevents endpoint paths and identifiers from
 * becoming Grafana labels while keeping the exporter itself below the size cap.
 */
export const API_ROUTE_VALUES = [
  'characters',
  'lobby_characters',
  'character_activity',
  'character_recommendation',
  'character_social',
  'character_detail',
  'creator',
  'creator_public',
  'character_wishes',
  'favorites',
  'conversations',
  'conversation_detail',
  'conversation_turn',
  'dramas',
  'drama_detail',
  'drama_playback',
  'drama_social',
  'images',
  'voice',
  'image_plaza',
  'models',
  'settings',
  'wallet',
  'payment',
  'vip',
  'notifications',
  'support',
  'community',
  'invite',
  'growth',
  'text_postprocess',
  'other',
] as const;
