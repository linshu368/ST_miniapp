import {
  readPostprocessVersion,
  type ChatMessage,
  type CompiledTextPostprocessArtifact,
  type TextPostprocessArtifactSnapshot,
} from '@miniapp/shared';

import { lookupVersionState, verifiedSnapshotArtifact, type VersionStateMap } from './versions';

export type AssistantBodyPlan =
  | { kind: 'original' }
  | { kind: 'renderer'; artifact: CompiledTextPostprocessArtifact };

/**
 * 只读取版本快照中的 artifact。
 * MiniApp 不编译 HTML/CSS，也不拿别的版本顶上。校验失败就继续走原来的 Markdown。
 */
export function resolveReplyArtifact(
  snapshot: TextPostprocessArtifactSnapshot
): CompiledTextPostprocessArtifact | null {
  return verifiedSnapshotArtifact(snapshot);
}

export function planAssistantBody(input: {
  message: Pick<ChatMessage, 'role' | 'postprocess_version' | 'turn_index'>;
  states: VersionStateMap;
}): AssistantBodyPlan {
  if (input.message.role !== 'assistant' || input.message.turn_index <= 0)
    return { kind: 'original' };
  const version = readPostprocessVersion(input.message.postprocess_version);
  if (version === null) return { kind: 'original' };
  const snapshot = lookupVersionState(input.states, version);
  if (!snapshot || snapshot.status !== 'ready' || snapshot.snapshot.version !== version) {
    return { kind: 'original' };
  }
  const artifact = resolveReplyArtifact(snapshot.snapshot);
  if (!artifact) return { kind: 'original' };
  return { kind: 'renderer', artifact };
}

/** 只拿这条消息自己的快照做校验，不接收调用方塞进来的另一份 artifact。 */
export function planMessageReply(
  message: Pick<ChatMessage, 'role' | 'postprocess_version' | 'turn_index'>,
  states: VersionStateMap
): AssistantBodyPlan {
  return planAssistantBody({ message, states });
}

/** 正文始终用消息上的原文。占位符只由最终那一个渲染器替换一次。 */
export function replySourceText(message: Pick<ChatMessage, 'content'>): string {
  return message.content;
}

export function usernameReplacementOwner(
  message: Pick<ChatMessage, 'role'>,
  plan: AssistantBodyPlan
): 'renderer' | 'markdown' | 'none' {
  if (message.role !== 'assistant') return 'none';
  return plan.kind === 'renderer' ? 'renderer' : 'markdown';
}
