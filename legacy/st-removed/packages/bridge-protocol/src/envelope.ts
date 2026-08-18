import { z } from 'zod';

export const BRIDGE_CHANNEL = 'miniapp-bridge' as const;
export const PROTOCOL_VERSION = 1 as const;

export type BridgeMessageType = 'request' | 'response' | 'event' | 'handshake' | 'ping' | 'pong';

export type BridgeEnvelope = {
  channel: typeof BRIDGE_CHANNEL;
  protocolVersion: typeof PROTOCOL_VERSION;
  type: BridgeMessageType;
  /** UTC milliseconds */
  timestamp: number;
};

export const BridgeEnvelopeSchema = z.object({
  channel: z.literal(BRIDGE_CHANNEL),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.enum(['request', 'response', 'event', 'handshake', 'ping', 'pong']),
  timestamp: z.number(),
});
