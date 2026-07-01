import { BridgeEnvelopeSchema } from './envelope.js';
import {
  BridgeRequestSchema,
  BridgeResponseSchema,
  BridgeEventSchema,
  HandshakeMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
} from './messages.js';
import type {
  BridgeRequestAny,
  BridgeResponseAny,
  BridgeEventAny,
  HandshakeMessage,
  PingMessage,
  PongMessage,
} from './messages.js';
import { actionRegistry } from './actions/registry.js';
import { eventRegistry } from './events/registry.js';
import type { ActionName } from './actions/registry.js';
import type { EventName } from './events/registry.js';
import { MAX_MESSAGE_SIZE } from './limits.js';

// ── Parse result discriminated union ──

export type ParseResult =
  | { type: 'request'; message: BridgeRequestAny }
  | { type: 'response'; message: BridgeResponseAny }
  | { type: 'event'; message: BridgeEventAny }
  | { type: 'handshake'; message: HandshakeMessage }
  | { type: 'ping'; message: PingMessage }
  | { type: 'pong'; message: PongMessage };

/**
 * Parse and validate a raw postMessage payload into a typed bridge message.
 *
 * 1. Validates the envelope (channel + protocolVersion + type + timestamp).
 * 2. Routes by `type` to the specific message schema.
 * 3. For `request` messages: validates the action payload against the action registry schema.
 * 4. For `event` messages: validates the event payload against the event registry schema.
 *
 * @throws {Error} with descriptive message on validation failure
 */
export function parseBridgeMessage(raw: unknown): ParseResult {
  const envelopeResult = BridgeEnvelopeSchema.safeParse(raw);
  if (!envelopeResult.success) {
    throw new Error(`BRIDGE_PROTOCOL_INVALID_ENVELOPE: ${envelopeResult.error.message}`);
  }

  const { type } = envelopeResult.data;

  switch (type) {
    case 'request': {
      const result = BridgeRequestSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: request: ${result.error.message}`);
      }
      const msg = result.data as BridgeRequestAny;

      const meta = actionRegistry[msg.action as ActionName];
      if (meta) {
        const payloadResult = meta.payloadSchema.safeParse(msg.payload);
        if (!payloadResult.success) {
          throw new Error(
            `BRIDGE_CALL_INVALID_PAYLOAD: action=${msg.action}: ${payloadResult.error.message}`
          );
        }
      }

      return { type: 'request', message: msg };
    }

    case 'response': {
      const result = BridgeResponseSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: response: ${result.error.message}`
        );
      }
      return { type: 'response', message: result.data as BridgeResponseAny };
    }

    case 'event': {
      const result = BridgeEventSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: event: ${result.error.message}`);
      }
      const msg = result.data as BridgeEventAny;

      const meta = eventRegistry[msg.eventName as EventName];
      if (meta) {
        const payloadResult = meta.payloadSchema.safeParse(msg.payload);
        if (!payloadResult.success) {
          throw new Error(
            `BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: event=${msg.eventName}: ${payloadResult.error.message}`
          );
        }
      }

      return { type: 'event', message: msg };
    }

    case 'handshake': {
      const result = HandshakeMessageSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: handshake: ${result.error.message}`
        );
      }
      return { type: 'handshake', message: result.data as HandshakeMessage };
    }

    case 'ping': {
      const result = PingMessageSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: ping: ${result.error.message}`);
      }
      return { type: 'ping', message: result.data as PingMessage };
    }

    case 'pong': {
      const result = PongMessageSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(`BRIDGE_PROTOCOL_PAYLOAD_SCHEMA_INVALID: pong: ${result.error.message}`);
      }
      return { type: 'pong', message: result.data as PongMessage };
    }

    default:
      throw new Error(`BRIDGE_PROTOCOL_UNKNOWN_TYPE: ${String(type)}`);
  }
}

/**
 * Check whether a serialized message exceeds the size limit.
 * @throws {Error} with code MESSAGE_TOO_LARGE if the size exceeds MAX_MESSAGE_SIZE
 */
export function checkMessageSize(data: string): void {
  if (data.length > MAX_MESSAGE_SIZE) {
    throw new Error(
      `BRIDGE_PROTOCOL_MESSAGE_TOO_LARGE: message size ${data.length} exceeds limit ${MAX_MESSAGE_SIZE}`
    );
  }
}
