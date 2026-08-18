import '../st-types.js';
import { handleChangeModel } from '../handlers/change-model.js';
import { handleOpenChat } from '../handlers/open-chat.js';
import { handleSelectCharacter } from '../handlers/select-character.js';

interface SimulationSendInput {
  userMessage: string;
  turnId: string;
  metadata: Record<string, unknown>;
}

interface SimulationSendResult {
  assistantReply: string;
  chatId: string | null;
  effectiveConfig: Record<string, unknown>;
}

interface PendingGeneration {
  resolve: (value: SimulationSendResult) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

declare global {
  interface Window {
    __miniappSimulation?: {
      selectCharacter: (
        avatar: string,
        forceNewChat?: boolean
      ) => Promise<{ chatId: string | null }>;
      openChat: (fileName: string) => Promise<{ chatId: string }>;
      changeModel: (modelName: string) => Promise<{ appliedModel: string }>;
      sendMessage: (input: SimulationSendInput) => Promise<SimulationSendResult>;
      getCurrentChatId: () => string | null;
    };
  }
}

let pendingGeneration: PendingGeneration | null = null;

export function installSimulationRuntime(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('miniapp_simulation') !== '1') return;

  const ctx = SillyTavern.getContext();
  ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, () => {
    settlePendingGeneration();
  });
  ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, () => {
    rejectPendingGeneration(new Error('ST generation stopped before completion'));
  });

  window.__miniappSimulation = {
    async selectCharacter(avatar, forceNewChat = true) {
      const result = await handleSelectCharacter({ avatar, forceNewChat });
      return { chatId: result.chatId };
    },
    async changeModel(modelName) {
      return await handleChangeModel({ provider: 'openrouter', modelName });
    },
    async openChat(fileName) {
      return await handleOpenChat({ fileName });
    },
    async sendMessage(input) {
      if (pendingGeneration) {
        throw new Error('A simulation generation is already in progress');
      }
      const textarea = document.querySelector<HTMLTextAreaElement>('#send_textarea');
      const sendButton = document.querySelector<HTMLElement>('#send_but');
      if (!textarea || !sendButton) {
        throw new Error('ST chat input is not ready');
      }

      window.__miniappSimulationTurn = {
        turnId: input.turnId,
        metadata: input.metadata,
      };

      const resultPromise = new Promise<SimulationSendResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingGeneration = null;
          reject(new Error('ST generation timed out'));
        }, 180_000);
        pendingGeneration = { resolve, reject, timeout };
      });

      textarea.value = input.userMessage;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await SillyTavern.getContext().generate('normal');
      return await resultPromise;
    },
    getCurrentChatId() {
      return ctx.getCurrentChatId();
    },
  };
}

function settlePendingGeneration(): void {
  const pending = pendingGeneration;
  if (!pending) return;

  try {
    const ctx = SillyTavern.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const assistant = [...chat]
      .reverse()
      .find(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          (entry as { is_user?: boolean }).is_user === false &&
          typeof (entry as { mes?: unknown }).mes === 'string'
      ) as { mes?: string } | undefined;
    if (!assistant?.mes) {
      throw new Error('ST generation ended without an assistant message');
    }

    clearTimeout(pending.timeout);
    pendingGeneration = null;
    pending.resolve({
      assistantReply: assistant.mes,
      chatId: ctx.getCurrentChatId(),
      effectiveConfig: window.__miniappSimulationTurn?.effectiveConfig ?? {},
    });
  } catch (error) {
    rejectPendingGeneration(error instanceof Error ? error : new Error(String(error)));
  } finally {
    window.__miniappSimulationTurn = undefined;
  }
}

function rejectPendingGeneration(error: Error): void {
  const pending = pendingGeneration;
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingGeneration = null;
  window.__miniappSimulationTurn = undefined;
  pending.reject(error);
}
