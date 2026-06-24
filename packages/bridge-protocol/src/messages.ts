import { z } from 'zod';
import type { BridgeEnvelope } from './envelope.js';
import { BridgeEnvelopeSchema } from './envelope.js';
import type { HandshakePhase, HandshakeMeta } from './handshake.js';
import { HandshakePhaseSchema, HandshakeMetaSchema } from './handshake.js';
import type { BridgeErrorPayload } from './errors.js';
import { BridgeErrorPayloadSchema } from './errors.js';
import type { STMirrorState } from './mirror-state.js';
import { STMirrorStateSchema } from './mirror-state.js';
import type { ActionName, ActionPayloadMap, ActionResultMap } from './actions/registry.js';
import type { EventName, EventPayloadMap } from './events/registry.js';

// ── Strongly-typed generics (use when the action/event name is known) ──

export type BridgeRequest<A extends ActionName = ActionName> = BridgeEnvelope & {
  type: 'request';
  requestId: string;
  action: A;
  payload: ActionPayloadMap[A];
};

export type BridgeResponse<A extends ActionName = ActionName> = BridgeEnvelope & {
  type: 'response';
  requestId: string;
  success: boolean;
  data?: ActionResultMap[A];
  error?: BridgeErrorPayload;
};

export type BridgeEvent<E extends EventName = EventName> = BridgeEnvelope & {
  type: 'event';
  eventName: E;
  payload: EventPayloadMap[E];
};

// ── Loose "Any" variants (for parsing before action/event name is validated) ──

export type BridgeRequestAny = BridgeEnvelope & {
  type: 'request';
  requestId: string;
  action: string;
  payload: unknown;
};

export type BridgeResponseAny = BridgeEnvelope & {
  type: 'response';
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: BridgeErrorPayload;
};

export type BridgeEventAny = BridgeEnvelope & {
  type: 'event';
  eventName: string;
  payload: unknown;
};

// ── Zod schemas (parse into "Any" variants first, then narrow) ──

export const BridgeRequestSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('request'),
  requestId: z.string(),
  action: z.string(),
  payload: z.unknown(),
});

export const BridgeResponseSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('response'),
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: BridgeErrorPayloadSchema.optional(),
});

export const BridgeEventSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('event'),
  eventName: z.string(),
  payload: z.unknown(),
});

// ── Handshake / Ping / Pong (unchanged) ──

export type HandshakeMessage = BridgeEnvelope & {
  type: 'handshake';
  phase: HandshakePhase;
  meta?: HandshakeMeta;
};

export const HandshakeMessageSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('handshake'),
  phase: HandshakePhaseSchema,
  meta: HandshakeMetaSchema.optional(),
});

export type PingMessage = BridgeEnvelope & {
  type: 'ping';
};

export const PingMessageSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('ping'),
});

export type PongMessage = BridgeEnvelope & {
  type: 'pong';
  mirrorState: STMirrorState;
};

export const PongMessageSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('pong'),
  mirrorState: STMirrorStateSchema,
});
