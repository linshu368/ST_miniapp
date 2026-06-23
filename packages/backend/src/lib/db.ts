import { PrismaClient } from '@prisma/client';
import '../platform/config.js';

export const prisma = new PrismaClient();
