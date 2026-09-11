/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-09-11 11:30:30
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-09-11 11:30:34
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import { z } from 'zod';

export const batchLabBackendEnvironmentSchema = z.enum(['development', 'test', 'production']);
export const batchLabSourceEnvironmentSchema = z.enum(['test', 'production']);

export const batchLabContextSchema = z
  .object({
    backend_environment: batchLabBackendEnvironmentSchema,
    source_environment: batchLabSourceEnvironmentSchema,
    capabilities: z
      .object({
        sample_preview: z.boolean(),
        experiment_execution: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type BatchLabContext = z.infer<typeof batchLabContextSchema>;

export const batchLabContextResponseSchema = z
  .object({
    success: z.literal(true),
    data: batchLabContextSchema,
  })
  .strict();

export const batchLabErrorCodeSchema = z.enum([
  'BATCH_LAB_DISABLED',
  'BATCH_LAB_CONFIGURATION_ERROR',
  'BATCH_LAB_TIMEOUT',
  'BATCH_LAB_REQUEST_CANCELLED',
  'BATCH_LAB_NETWORK_ERROR',
  'BATCH_LAB_PROTOCOL_ERROR',
]);

export const batchLabErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: z
      .object({
        code: batchLabErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type BatchLabErrorCode = z.infer<typeof batchLabErrorCodeSchema>;
export type BatchLabErrorResponse = z.infer<typeof batchLabErrorResponseSchema>;
