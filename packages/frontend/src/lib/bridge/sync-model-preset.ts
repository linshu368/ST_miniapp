import type { GetEffectivePresetData } from '@miniapp/shared';
import { platformAction } from './platform-action';

const PRESET_CHUNK_SIZE = 20_000;
const inFlightSyncs = new Map<string, Promise<void>>();
let syncQueue: Promise<void> = Promise.resolve();

function createSyncId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function syncModelPresetToST(data: GetEffectivePresetData): Promise<void> {
  const key = `${data.model_id}:${data.preset_assignments_version}:${data.effective_preset_id}`;
  const existing = inFlightSyncs.get(key);
  if (existing) return existing;

  const task = syncQueue.catch(() => undefined).then(() => performSyncModelPresetToST(data));
  syncQueue = task;
  inFlightSyncs.set(key, task);
  try {
    await task;
  } finally {
    if (inFlightSyncs.get(key) === task) inFlightSyncs.delete(key);
  }
}

async function performSyncModelPresetToST(data: GetEffectivePresetData): Promise<void> {
  if (data.preset_degraded && data.effective_preset_id === null) {
    await platformAction('changeModel', {
      provider: 'openrouter',
      modelName: data.openrouter_model_id,
      presetConfigCode: data.preset_config_code,
    });
    return;
  }
  if (!data.effective_preset_id || !data.effective_preset_pointer || !data.preset_payload) {
    throw new Error('有效模型预设内容缺失');
  }

  const serialized = JSON.stringify(data.preset_payload);
  const chunks =
    serialized.length === 0
      ? ['']
      : Array.from({ length: Math.ceil(serialized.length / PRESET_CHUNK_SIZE) }, (_value, index) =>
          serialized.slice(index * PRESET_CHUNK_SIZE, (index + 1) * PRESET_CHUNK_SIZE)
        );
  const syncId = createSyncId();

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const result = await platformAction('syncModelPreset', {
      syncId,
      modelName: data.openrouter_model_id,
      presetId: data.effective_preset_id,
      presetPointer: data.effective_preset_pointer,
      assignmentsVersion: data.preset_assignments_version,
      chunkIndex,
      chunkCount: chunks.length,
      chunk: chunks[chunkIndex] ?? '',
    });

    if (chunkIndex === chunks.length - 1 && !result.complete) {
      throw new Error('模型预设分片传输未完成');
    }
  }
}
