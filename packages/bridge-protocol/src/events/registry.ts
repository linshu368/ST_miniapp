import type { z } from 'zod';
import type { EventMeta } from './types.js';
import { AppReadyPayloadSchema, appReadyMeta } from './app-ready.js';
import { CharacterChangedPayloadSchema, characterChangedMeta } from './character-changed.js';
import { ChatChangedPayloadSchema, chatChangedMeta } from './chat-changed.js';
import { ChatCreatedPayloadSchema, chatCreatedMeta } from './chat-created.js';
import { ChatDeletedPayloadSchema, chatDeletedMeta } from './chat-deleted.js';
import { ChatRenamedPayloadSchema, chatRenamedMeta } from './chat-renamed.js';
import { GenerationStartedPayloadSchema, generationStartedMeta } from './generation-started.js';
import {
  GenerationStreamingPayloadSchema,
  generationStreamingMeta,
} from './generation-streaming.js';
import {
  GenerationCompletedPayloadSchema,
  generationCompletedMeta,
} from './generation-completed.js';
import { GenerationStoppedPayloadSchema, generationStoppedMeta } from './generation-stopped.js';
import { GenerationEndedPayloadSchema, generationEndedMeta } from './generation-ended.js';
import { ModelChangedPayloadSchema, modelChangedMeta } from './model-changed.js';
import { SettingsUpdatedPayloadSchema, settingsUpdatedMeta } from './settings-updated.js';

export type EventName =
  | 'app:ready'
  | 'character:changed'
  | 'chat:changed'
  | 'chat:created'
  | 'chat:deleted'
  | 'chat:renamed'
  | 'generation:started'
  | 'generation:streaming'
  | 'generation:completed'
  | 'generation:stopped'
  | 'generation:ended'
  | 'model:changed'
  | 'settings:updated';

export type EventPayloadMap = {
  'app:ready': z.infer<typeof AppReadyPayloadSchema>;
  'character:changed': z.infer<typeof CharacterChangedPayloadSchema>;
  'chat:changed': z.infer<typeof ChatChangedPayloadSchema>;
  'chat:created': z.infer<typeof ChatCreatedPayloadSchema>;
  'chat:deleted': z.infer<typeof ChatDeletedPayloadSchema>;
  'chat:renamed': z.infer<typeof ChatRenamedPayloadSchema>;
  'generation:started': z.infer<typeof GenerationStartedPayloadSchema>;
  'generation:streaming': z.infer<typeof GenerationStreamingPayloadSchema>;
  'generation:completed': z.infer<typeof GenerationCompletedPayloadSchema>;
  'generation:stopped': z.infer<typeof GenerationStoppedPayloadSchema>;
  'generation:ended': z.infer<typeof GenerationEndedPayloadSchema>;
  'model:changed': z.infer<typeof ModelChangedPayloadSchema>;
  'settings:updated': z.infer<typeof SettingsUpdatedPayloadSchema>;
};

export const eventRegistry: Record<EventName, EventMeta> = {
  'app:ready': appReadyMeta,
  'character:changed': characterChangedMeta,
  'chat:changed': chatChangedMeta,
  'chat:created': chatCreatedMeta,
  'chat:deleted': chatDeletedMeta,
  'chat:renamed': chatRenamedMeta,
  'generation:started': generationStartedMeta,
  'generation:streaming': generationStreamingMeta,
  'generation:completed': generationCompletedMeta,
  'generation:stopped': generationStoppedMeta,
  'generation:ended': generationEndedMeta,
  'model:changed': modelChangedMeta,
  'settings:updated': settingsUpdatedMeta,
};
