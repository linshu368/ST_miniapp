// TODO: 阶段 3 补完 — 等 SPIKE 完成后定义 action 清单

import type { z } from 'zod';
import type { HandshakePhase } from '../handshake.js';

export interface ActionMeta {
  payloadSchema: z.ZodType;
  resultSchema: z.ZodType;
  requiredPhase: HandshakePhase;
  waitable: boolean;
}
