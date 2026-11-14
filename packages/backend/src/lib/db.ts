import '../platform/config.js';
import { PrismaClient } from '@prisma/client';

import { applyPrismaObservation } from '../platform/observability/prisma.js';

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

export const prisma = applyPrismaObservation(baseClient);
