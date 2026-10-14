/**
 * @Author: whc 952987912@qq.com
 * @Date: 2026-10-14 14:39:12
 * @LastEditors: whc 952987912@qq.com
 * @LastEditTime: 2026-10-14 14:39:23
 * @Description:
 * @Copyright (c) 2026 by git config user.name, All Rights Reserved.
 */
import type { ImagePlazaTagConfig } from '@miniapp/shared';
import type { FastifyBaseLogger } from 'fastify';
import { getImageRuntimeConfig } from '../image/config.js';
import { requestImagePlazaTags } from '../generation/image-plaza-tagging.js';

/** 模型输出不可信：仅保留本次已发布的启用 id，绝不将 label 或自由文本写入作品。 */
export function sanitizeImagePlazaTags(value: unknown, tags: ImagePlazaTagConfig): string[] {
  if (!Array.isArray(value)) return [];
  const enabled = new Set(tags.filter((tag) => tag.enabled).map((tag) => tag.id));
  return [
    ...new Set(value.filter((id): id is string => typeof id === 'string' && enabled.has(id))),
  ].slice(0, 12);
}

export async function classifyImagePlazaTags(input: {
  prompt: string;
  tags: ImagePlazaTagConfig;
  log: FastifyBaseLogger;
}): Promise<string[]> {
  const tags = input.tags.filter((tag) => tag.enabled).map(({ id, label }) => ({ id, label }));
  if (tags.length === 0) return [];
  const startedAt = Date.now();
  try {
    const { textModel } = await getImageRuntimeConfig();
    const result = await requestImagePlazaTags({ prompt: input.prompt, tags, textModel });
    const sanitized = sanitizeImagePlazaTags(result, input.tags);
    input.log.info(
      {
        event: 'image_plaza.tagging.completed',
        durationMs: Date.now() - startedAt,
        tagCount: sanitized.length,
      },
      'Image plaza tagging completed'
    );
    return sanitized;
  } catch (err) {
    // 配置读取异常也可能含底层连接信息，仅记录脱敏错误码。
    const safeError = new Error(
      err instanceof Error && /^image_plaza_tagging_[a-z0-9_]+$/.test(err.message)
        ? err.message
        : 'image_plaza_tagging_failed'
    );
    input.log.warn(
      {
        err: safeError,
        event: 'image_plaza.tagging.failed',
        durationMs: Date.now() - startedAt,
      },
      'Image plaza tagging failed'
    );
    return [];
  }
}

/** race 不取消模型请求；清理快路径定时器，慢路径由调用者接续同一个 Promise。 */
export async function waitForImagePlazaTags(
  pending: Promise<string[]>,
  waitMs = 2000
): Promise<string[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
