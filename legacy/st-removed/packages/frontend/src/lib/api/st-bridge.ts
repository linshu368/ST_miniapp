'use client';

import type { EnsureStCharacterData } from '@miniapp/shared';

import { apiClient } from './client';

/**
 * 懒下发：确保「目标角色卡」已落到该用户的 ST 数据目录，随后前端才 selectCharacter。
 */
async function postEnsureStCharacter(characterId: string): Promise<EnsureStCharacterData> {
  return apiClient<EnsureStCharacterData>(
    `/api/bridge/st-character/${encodeURIComponent(characterId)}`,
    { method: 'POST' }
  );
}

/**
 * ensure 预取（iframe 加载耗时优化：浮层期懒下发）。
 *
 * 同一 characterId 全会话共享一个 in-flight/已完成 promise：
 *  - 角色预览浮层打开时预取（用户读简介的时间掩盖 0.6~1.9s 的下发耗时）；
 *  - 点「进入角色」后对话页 await 同一个 promise —— 已完成则零等待，
 *    进行中则只等剩余部分，未预取（直链进入等场景）则现场发起。
 *
 * 失效策略：请求失败或返回 status='missing'（角色不存在/未上架）时清除缓存，
 * 允许下次重试；'written'/'skipped' 表示已在盘上，会话内无需再查。
 */
const ensurePromises = new Map<string, Promise<EnsureStCharacterData>>();

export function prefetchEnsureStCharacter(characterId: string): Promise<EnsureStCharacterData> {
  const existing = ensurePromises.get(characterId);
  if (existing) return existing;

  const promise = postEnsureStCharacter(characterId).then(
    (result) => {
      if (result.status === 'missing') ensurePromises.delete(characterId);
      return result;
    },
    (err) => {
      ensurePromises.delete(characterId);
      throw err;
    }
  );
  ensurePromises.set(characterId, promise);
  return promise;
}
