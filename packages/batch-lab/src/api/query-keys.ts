import type { BatchLabContext } from '@miniapp/shared';

export const batchLabQueryKeys = {
  context: ['batch-lab', 'context'] as const,
  environment(context: BatchLabContext) {
    return ['batch-lab', context.backend_environment, context.source_environment] as const;
  },
};
