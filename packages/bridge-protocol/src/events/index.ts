// TODO: 阶段 3 补完 — 等 SPIKE 完成后定义 event 清单

import type { z } from 'zod';

export interface EventMeta {
  payloadSchema: z.ZodType;
}
