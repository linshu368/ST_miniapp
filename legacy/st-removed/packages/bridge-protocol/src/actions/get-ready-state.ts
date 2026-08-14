import { z } from 'zod';
import { HandshakePhaseSchema } from '../handshake.js';
import type { ActionMeta } from './types.js';

export const GetReadyStatePayloadSchema = z.object({});

export const GetReadyStateResultSchema = z.object({
  phase: HandshakePhaseSchema,
});

export const getReadyStateMeta: ActionMeta = {
  name: 'getReadyState',
  payloadSchema: GetReadyStatePayloadSchema,
  resultSchema: GetReadyStateResultSchema,
  requiredPhase: 'handshake',
  waitable: false,
};
