import type { z } from 'zod';
import type { HandshakePhase } from '../handshake.js';

export interface ActionMeta {
  name: string;
  payloadSchema: z.ZodType;
  resultSchema: z.ZodType;
  requiredPhase: HandshakePhase;
  waitable: boolean;
}
