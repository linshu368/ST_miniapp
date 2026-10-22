import '../platform/config.js';
import { PrismaClient } from '@prisma/client';

import { measureDbOperation } from './perf-metrics.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL 未配置，无法初始化 PrismaClient');
}

const baseClient = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl,
    },
  },
});

// 只加耗时观测，不改变任何调用的行为或返回值。
// $extends 的返回类型和 Prisma.TransactionClient 不兼容（alerting/repository 等传 tx 的地方会编译失败），
// 而扩展本身没有新增任何方法，所以对外仍声明为 PrismaClient，避免把类型问题扩散到所有调用方。
export const prisma = baseClient.$extends({
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
  },
}) as unknown as PrismaClient;
