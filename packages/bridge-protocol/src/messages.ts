import { z } from 'zod';
import type { BridgeEnvelope } from './envelope.js';
import { BridgeEnvelopeSchema } from './envelope.js';
import type { HandshakePhase, HandshakeMeta } from './handshake.js';
import { HandshakePhaseSchema, HandshakeMetaSchema } from './handshake.js';
import type { BridgeErrorPayload } from './errors.js';
import { BridgeErrorPayloadSchema } from './errors.js';
import type { STMirrorState } from './mirror-state.js';
import { STMirrorStateSchema } from './mirror-state.js';

export type BridgeRequest<A extends string = string> = BridgeEnvelope & {
  type: 'request';
  requestId: string;
  action: A;
  payload: unknown;
};

export const BridgeRequestSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('request'),
  requestId: z.string(),
  action: z.string(),
  payload: z.unknown(),
});

export type BridgeResponse = BridgeEnvelope & {
  type: 'response';
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: BridgeErrorPayload;
};

export const BridgeResponseSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('response'),
  requestId: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: BridgeErrorPayloadSchema.optional(),
});

export type BridgeEvent<E extends string = string> = BridgeEnvelope & {
  type: 'event';
  eventName: E;
  payload: unknown;
};

export const BridgeEventSchema = BridgeEnvelopeSchema.extend({
  type: z.literal('event'),
  eventName: z.string(),
  payload: z.unknown(),
});

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
