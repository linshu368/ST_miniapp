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
  data?: {
    character_book?: STCharacterBook;
    extensions?: { world?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
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
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** power_user 设置子集（仅本扩展用到的字段） */
export interface STPowerUserSettings {
  /** 是否对含内置世界书的角色弹「阻塞式」导入确认框（默认 true） */
  world_import_dialog?: boolean;
  [key: string]: unknown;
}

/** 角色卡内置世界书（character card spec v2 的 character_book） */
export interface STCharacterBook {
  name?: string;
  entries: unknown[];
  [key: string]: unknown;
}

export interface STChatCompletionSettings {
  chat_completion_source: string;
  [key: string]: unknown;
}

/** 酒馆助手（JS-Slash-Runner）的全局设置子集（仅本扩展用到的字段） */
export interface STTavernHelperSettings {
  optimize?: {
    /** 默认 true：会把 openai_max_context 顶到 2_000_000，与平台 32768 冲突 */
    maximize_preset_context_length?: boolean;
    /** 默认 true：静默改写 ST 全局世界书引擎设置（context_percentage=100 等） */
    force_recommended_worldbook_global_settings?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface STExtensionSettings {
  /** 已被允许使用内置正则的角色 avatar 文件名列表（regex 扩展维护） */
  character_allowed_regex?: string[];
  /** 酒馆助手设置（setting_field='tavern_helper'，见 JS-Slash-Runner src/type/settings.ts） */
  tavern_helper?: STTavernHelperSettings;
  [key: string]: unknown;
}

export interface STContext {
  characters: STCharacter[];
  characterId: number | undefined;
  chat: unknown[] | undefined;
  chatCompletionSettings: STChatCompletionSettings;
  extensionSettings: STExtensionSettings;
  powerUserSettings: STPowerUserSettings;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
  accountStorage?: STAccountStorage | null;

  getCurrentChatId(): string | null;
  /** 重新从服务端拉取角色列表并重建内存 characters 数组（见 vendor script.js getCharacters） */
  getCharacters(): Promise<void>;
  getRequestHeaders(): Record<string, string>;
  getChatCompletionModel(): string;
  getPresetManager(): STPresetManager | null;
  selectCharacterById(index: number, opts?: { switchMenu?: boolean }): Promise<void>;
  saveSettingsDebounced(): void;
  openCharacterChat(fileName: string): Promise<void>;
  renameChat(oldFileName: string, newName: string): Promise<void>;
  executeSlashCommandsWithOptions(command: string): Promise<unknown>;

  /** 角色内置世界书相关（见 vendor scripts/world-info.js / extensions.js） */
  convertCharacterBook(book: STCharacterBook): unknown;
  saveWorldInfo(name: string, data: unknown, immediately?: boolean): Promise<void>;
  updateWorldInfoList(): Promise<void>;
  getWorldInfoNames(): string[];
  writeExtensionField(characterId: number | string, key: string, value: unknown): Promise<void>;
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
  CHAT_COMPLETION_SETTINGS_READY: string;
  OAI_PRESET_CHANGED_AFTER: string;
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
