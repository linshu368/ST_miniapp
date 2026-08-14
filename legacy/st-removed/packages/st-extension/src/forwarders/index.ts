import type { BridgeServer } from '../bridge-server.js';
import { setGenerationPhase } from '../mirror-state.js';
import '../st-types.js';

/**
 * Register ST eventSource listeners that forward ST internal events
 * as bridge events to the parent frame.
 */
export function registerForwarders(server: BridgeServer): void {
  const ctx = SillyTavern.getContext();
  const et = ctx.eventTypes;

  // ── Chat events ──

  ctx.eventSource.on(et.CHAT_CHANGED, (chatId: string) => {
    server.sendEvent('chat:changed', {
      chatId,
      messageCount: ctx.chat?.length ?? 0,
    });
  });

  ctx.eventSource.on(et.CHAT_CREATED, () => {
    server.sendEvent('chat:created', { chatId: ctx.getCurrentChatId()! });
  });

  ctx.eventSource.on(et.CHAT_DELETED, (fileName: string) => {
    server.sendEvent('chat:deleted', { fileName });
  });

  ctx.eventSource.on(et.CHAT_RENAMED, (eventData: { oldFileName: string; newFileName: string }) => {
    server.sendEvent('chat:renamed', {
      oldFileName: eventData.oldFileName,
      newFileName: eventData.newFileName,
    });
  });

  // ── Generation events ──

  ctx.eventSource.on(et.GENERATION_STARTED, (_type: string, _opts: unknown, dryRun: boolean) => {
    if (dryRun) return;
    server.sendEvent('generation:started', { type: _type });
    setGenerationPhase('started');
  });

  // generation:streaming — throttled at 1s interval
  let streamingInterval: ReturnType<typeof setInterval> | null = null;
  let hasNewToken = false;

  ctx.eventSource.on(et.STREAM_TOKEN_RECEIVED, () => {
    hasNewToken = true;
    if (!streamingInterval) {
      setGenerationPhase('streaming');
      server.sendEvent('generation:streaming', { phase: 'streaming' });
      streamingInterval = setInterval(() => {
        if (hasNewToken) {
          server.sendEvent('generation:streaming', { phase: 'streaming' });
          hasNewToken = false;
        }
      }, 1000);
    }
  });

  ctx.eventSource.on(et.MESSAGE_RECEIVED, (chatId: number) => {
    clearStreamingInterval();
    setGenerationPhase('finished');
    server.sendEvent('generation:completed', {
      chatId,
      messageCount: ctx.chat?.length ?? 0,
    });
  });

  ctx.eventSource.on(et.GENERATION_STOPPED, () => {
    clearStreamingInterval();
    setGenerationPhase('aborted');
    server.sendEvent('generation:stopped', {});
  });

  ctx.eventSource.on(et.GENERATION_ENDED, (chatLength: number) => {
    clearStreamingInterval();
    server.sendEvent('generation:ended', { chatLength });
    setTimeout(() => setGenerationPhase('idle'), 500);
  });

  // ── Model & settings ──

  ctx.eventSource.on(et.CHATCOMPLETION_MODEL_CHANGED, () => {
    server.sendEvent('model:changed', {
      model: ctx.getChatCompletionModel(),
      provider: ctx.chatCompletionSettings.chat_completion_source,
    });
  });

  ctx.eventSource.on(et.SETTINGS_UPDATED, () => {
    server.sendEvent('settings:updated', {});
  });

  function clearStreamingInterval(): void {
    if (streamingInterval) {
      clearInterval(streamingInterval);
      streamingInterval = null;
      hasNewToken = false;
    }
  }
}
