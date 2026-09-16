'use client';

import { getPostHogAdapter } from './adapter';
import { getReplayLifecycle } from './lifecycle';

export { PH_CHAT_REPLAY_VISIBLE_CLASS, PH_MASK_TEXT_CLASS, PH_NO_CAPTURE_CLASS } from './masking';
export { ReplayLifecycleOwner } from './ReplayLifecycleOwner';
export {
  getReplayLifecycle,
  useReplayLifecycle,
  type ReplayEventDraft,
  type ReplayLifecycleApi,
  type ReplayLifecycleSnapshot,
  type ReplayLifecycleState,
  type StartChatReplayInput,
} from './lifecycle';

export async function initReplayTelemetry(telegramUserId: number | undefined): Promise<void> {
  if (telegramUserId === undefined) return;
  await getPostHogAdapter().init(String(telegramUserId));
  getReplayLifecycle().refreshTelemetryReady();
}
