/**
 * Minimal type declarations for the SillyTavern runtime API surface
 * that st-extension depends on. These are NOT exhaustive ST types —
 * only the subset needed for bridge handlers/forwarders.
 *
 * 不确定：部分 API 签名来自 spike 阶段探测，未必 100% 准确。
 * 运行时通过 getContext() 返回的对象可能包含额外属性。
 */

export interface STCharacter {
  avatar: string;
  name: string;
  [key: string]: unknown;
}

export interface STEventSource {
  on(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): Promise<void>;
  makeFirst(event: string, callback: (...args: any[]) => void): void;
}

export interface STPresetManager {
  getSelectedPresetName(): string | null;
}

export interface STAccountStorage {
  currentUser?: { id: string } | null;
}

export interface STChatCompletionSettings {
  chat_completion_source: string;
  [key: string]: unknown;
}

export interface STContext {
  characters: STCharacter[];
  characterId: number | undefined;
  chat: unknown[] | undefined;
  chatCompletionSettings: STChatCompletionSettings;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
  accountStorage?: STAccountStorage | null;

  getCurrentChatId(): string | null;
  getRequestHeaders(): Record<string, string>;
  getChatCompletionModel(): string;
  getPresetManager(): STPresetManager | null;
  selectCharacterById(index: number, opts?: { switchMenu?: boolean }): Promise<void>;
  saveSettingsDebounced(): void;
  openCharacterChat(fileName: string): Promise<void>;
  renameChat(oldFileName: string, newName: string): Promise<void>;
  executeSlashCommandsWithOptions(command: string): Promise<unknown>;
}

export interface STEventTypes {
  CHAT_CHANGED: string;
  CHAT_CREATED: string;
  CHAT_DELETED: string;
  CHAT_RENAMED: string;
  GENERATION_STARTED: string;
  GENERATION_STOPPED: string;
  GENERATION_ENDED: string;
  STREAM_TOKEN_RECEIVED: string;
  MESSAGE_RECEIVED: string;
  CHATCOMPLETION_MODEL_CHANGED: string;
  SETTINGS_UPDATED: string;
  APP_READY: string;
}

export interface STGlobal {
  getContext(): STContext;
}

declare global {
  // eslint-disable-next-line no-var
  var SillyTavern: STGlobal;
}
