import { BridgeError } from '@miniapp/bridge-protocol';
import type { ActionPayloadMap, ActionResultMap } from '@miniapp/bridge-protocol';
import { handleChangeModel } from './change-model.js';
import { setPresetConfigWarning } from '../patches/llm-metadata-inject.js';
import '../st-types.js';

type Payload = ActionPayloadMap['syncModelPreset'];
type Result = ActionResultMap['syncModelPreset'];

const MAX_PRESET_JSON_SIZE = 2_200_000;
const SYNC_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_SYNCS = 4;
const PRESET_APPLY_TIMEOUT_MS = 5_000;
const SAFE_PRESET_KEYS = new Set([
  'temperature',
  'frequency_penalty',
  'presence_penalty',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'repetition_penalty',
  'max_context_unlocked',
  'tool_reasoning_mode',
  'openai_max_context',
  'openai_max_tokens',
  'names_behavior',
  'send_if_empty',
  'impersonation_prompt',
  'new_chat_prompt',
  'new_group_chat_prompt',
  'new_example_chat_prompt',
  'continue_nudge_prompt',
  'bias_preset_selected',
  'wi_format',
  'scenario_format',
  'personality_format',
  'group_nudge_prompt',
  'stream_openai',
  'prompts',
  'prompt_order',
  'assistant_prefill',
  'assistant_impersonation',
  'use_sysprompt',
  'squash_system_messages',
  'media_inlining',
  'inline_image_quality',
  'continue_prefill',
  'continue_postfix',
  'function_calling',
  'tool_call_recurse_limit',
  'show_thoughts',
  'reasoning_effort',
  'verbosity',
  'enable_web_search',
  'seed',
  'n',
  'request_images',
  'request_image_aspect_ratio',
  'request_image_resolution',
  'extensions',
]);

interface PendingSync {
  createdAt: number;
  modelName: string;
  presetId: string;
  presetPointer: string;
  assignmentsVersion: number;
  chunks: Array<string | undefined>;
  receivedSize: number;
}

const pendingSyncs = new Map<string, PendingSync>();

function pruneExpiredSyncs(now: number): void {
  for (const [syncId, pending] of pendingSyncs) {
    if (now - pending.createdAt > SYNC_TTL_MS) pendingSyncs.delete(syncId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleSyncModelPreset(payload: Payload): Promise<Result> {
  const now = Date.now();
  pruneExpiredSyncs(now);

  const existing = pendingSyncs.get(payload.syncId);
  if (!existing && pendingSyncs.size >= MAX_PENDING_SYNCS) {
    throw new BridgeError(
      'BRIDGE_EXEC_PRECONDITION_FAILED',
      'Too many preset synchronizations are pending'
    );
  }
  const pending: PendingSync = existing ?? {
    createdAt: now,
    modelName: payload.modelName,
    presetId: payload.presetId,
    presetPointer: payload.presetPointer,
    assignmentsVersion: payload.assignmentsVersion,
    chunks: new Array<string | undefined>(payload.chunkCount),
    receivedSize: 0,
  };

  if (
    pending.modelName !== payload.modelName ||
    pending.presetId !== payload.presetId ||
    pending.presetPointer !== payload.presetPointer ||
    pending.assignmentsVersion !== payload.assignmentsVersion ||
    pending.chunks.length !== payload.chunkCount
  ) {
    pendingSyncs.delete(payload.syncId);
    throw new BridgeError(
      'BRIDGE_CALL_INVALID_PAYLOAD',
      'Preset sync chunks contain inconsistent metadata'
    );
  }

  if (payload.chunkIndex >= pending.chunks.length) {
    throw new BridgeError('BRIDGE_CALL_INVALID_PAYLOAD', 'Preset sync chunk index is out of range');
  }

  const previousChunk = pending.chunks[payload.chunkIndex];
  pending.receivedSize += payload.chunk.length - (previousChunk?.length ?? 0);
  if (pending.receivedSize > MAX_PRESET_JSON_SIZE) {
    pendingSyncs.delete(payload.syncId);
    throw new BridgeError(
      'BRIDGE_CALL_INVALID_PAYLOAD',
      'Serialized preset payload exceeds 2.2 MB'
    );
  }
  pending.chunks[payload.chunkIndex] = payload.chunk;
  pendingSyncs.set(payload.syncId, pending);

  if (pending.chunks.some((chunk) => chunk === undefined)) {
    return { complete: false, appliedModel: null, appliedPresetId: null };
  }

  pendingSyncs.delete(payload.syncId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(pending.chunks.join(''));
  } catch {
    throw new BridgeError('BRIDGE_CALL_INVALID_PAYLOAD', 'Preset payload is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new BridgeError('BRIDGE_CALL_INVALID_PAYLOAD', 'Preset payload must be a JSON object');
  }
  const safePreset = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => SAFE_PRESET_KEYS.has(key))
  );
  if (Object.keys(safePreset).length === 0) {
    throw new BridgeError('BRIDGE_CALL_INVALID_PAYLOAD', 'Preset payload has no applicable fields');
  }

  const ctx = SillyTavern.getContext();
  const presetManager = ctx.getPresetManager();
  if (!presetManager || presetManager.apiId !== 'openai') {
    throw new BridgeError(
      'BRIDGE_EXEC_PRECONDITION_FAILED',
      'OpenAI preset manager is unavailable'
    );
  }

  const settings = ctx.chatCompletionSettings as Record<string, unknown>;
  // 平台连接、代理和模型字段必须继续由平台强制控制；原生 ST 默认值为 true，
  // 因此热应用前显式解除预设与连接字段的绑定。
  settings.bind_preset_to_connection = false;

  let cancelPresetWait = () => {};
  const presetApplied = new Promise<void>((resolve, reject) => {
    const eventName = ctx.eventTypes.OAI_PRESET_CHANGED_AFTER;
    const onApplied = () => {
      cleanup();
      resolve();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the preset to apply'));
    }, PRESET_APPLY_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      ctx.eventSource.removeListener(eventName, onApplied);
    };
    cancelPresetWait = () => {
      cleanup();
      resolve();
    };
    ctx.eventSource.once(eventName, onApplied);
  });

  // 保存会同步更新 ST 内存预设列表、选择 platform_<uuid> 并走原生
  // onSettingsPresetChange，确保 prompts、extensions 和采样参数完整应用。
  try {
    await presetManager.savePreset(pending.presetPointer, safePreset);
  } catch (error) {
    cancelPresetWait();
    throw error;
  }
  await presetApplied;

  settings.preset_settings_openai = pending.presetPointer;
  await handleChangeModel({ provider: 'openrouter', modelName: pending.modelName });
  setPresetConfigWarning(null);
  ctx.saveSettingsDebounced();

  return {
    complete: true,
    appliedModel: ctx.getChatCompletionModel(),
    appliedPresetId: pending.presetId,
  };
}
