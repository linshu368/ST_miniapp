import type { PrismaClient } from '@prisma/client';
import { measureDbOperation } from '../../lib/perf-metrics.js';

/** Shared and single-connection lock owners need identical observation without replacing the pool. */
export function applyPrismaObservation(client: PrismaClient): PrismaClient {
  // No methods are added; preserve the existing TransactionClient compatibility at callers.
  return client.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return measureDbOperation(model, operation, () => query(args));
        },
      },
      $queryRaw({ args, query }) {
        return measureDbOperation('raw', 'queryRaw', () => query(args));
      },
      $executeRaw({ args, query }) {
        return measureDbOperation('raw', 'executeRaw', () => query(args));
      },
      $queryRawUnsafe({ args, query }) {
        return measureDbOperation('raw', 'queryRawUnsafe', () => query(args));
      },
      $executeRawUnsafe({ args, query }) {
        return measureDbOperation('raw', 'executeRawUnsafe', () => query(args));
      },
    },
  }) as unknown as PrismaClient;
}
