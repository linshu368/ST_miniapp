'use client';

import { create } from 'zustand';

import {
  changeScope,
  currentScope,
  EMPTY_PREFS,
  forgetImage,
  parseBackgroundPrefs,
  selectImage,
  setLight,
  type Appearance,
  type BackgroundChoice,
  type BackgroundPrefs,
  type BackgroundScope,
  type ImageTone,
} from '@/lib/appearance/chat-background';
import {
  deleteImage,
  ImageImportError,
  listImages,
  MAX_IMAGES,
  prepareImage,
  saveImage,
  type StoredImage,
} from '@/lib/appearance/image-store';
import { sendSentryLog } from '@/lib/sentry/client';

const PREFS_KEY = (ownerId: string) => `st_miniapp_chat_bg_v1:${ownerId}`;

export interface BackgroundImage extends ImageTone {
  id: string;
  url: string;
}

interface ChatBackgroundState {
  ownerId: string | null;
  prefs: BackgroundPrefs;
  /** null = 还没读完本机图片 */
  images: BackgroundImage[] | null;
  /** 面板里的范围开关；面板打开时由 openPanel 定好。 */
  scope: BackgroundScope;
  globalAtOpen: BackgroundChoice | null;
  globalTouched: boolean;
  hydrate: (ownerId: string) => void;
  openPanel: (characterId: string) => void;
  pick: (characterId: string, img: string) => void;
  pickScope: (characterId: string, scope: BackgroundScope) => void;
  light: (characterId: string, appearance: Appearance, value: number) => void;
  addImage: (characterId: string, file: File) => Promise<boolean>;
  removeImage: (id: string) => void;
}

function readPrefs(ownerId: string): BackgroundPrefs {
  try {
    return parseBackgroundPrefs(window.localStorage.getItem(PREFS_KEY(ownerId)));
  } catch {
    return EMPTY_PREFS;
  }
}

function persist(ownerId: string | null, prefs: BackgroundPrefs): void {
  if (!ownerId) return;
  try {
    window.localStorage.setItem(PREFS_KEY(ownerId), JSON.stringify(prefs));
  } catch {
    // 隐私模式或配额满：本次仍生效，下次打开回到之前的设置。
  }
}

function toBackgroundImage(image: StoredImage): BackgroundImage {
  return {
    id: image.id,
    hi: image.hi,
    lo: image.lo,
    url: URL.createObjectURL(new Blob([image.bytes], { type: image.type })),
  };
}

export const useChatBackgroundStore = create<ChatBackgroundState>((set, get) => {
  const commit = (prefs: BackgroundPrefs, extra: Partial<ChatBackgroundState> = {}) => {
    set({ prefs, ...extra });
    persist(get().ownerId, prefs);
  };

  return {
    ownerId: null,
    prefs: EMPTY_PREFS,
    images: null,
    scope: 'character',
    globalAtOpen: null,
    globalTouched: false,

    hydrate: (ownerId) => {
      if (get().ownerId === ownerId) return;
      get().images?.forEach((image) => URL.revokeObjectURL(image.url));
      set({ ownerId, prefs: readPrefs(ownerId), images: null });
      listImages(ownerId)
        .catch(() => [])
        .then((rows) => {
          if (get().ownerId !== ownerId) return;
          // 读取期间刚导入的图已在列表里，不重复放。
          const added = get().images ?? [];
          const known = new Set(added.map((image) => image.id));
          set({
            images: [...added, ...rows.filter((row) => !known.has(row.id)).map(toBackgroundImage)],
          });
        });
    },

    openPanel: (characterId) => {
      const { prefs } = get();
      set({
        scope: currentScope(prefs, characterId),
        globalAtOpen: prefs.global,
        globalTouched: false,
      });
    },

    pick: (characterId, img) => {
      const { prefs, scope } = get();
      commit(selectImage(prefs, characterId, scope, img), {
        globalTouched: get().globalTouched || scope === 'all',
      });
      sendSentryLog('info', 'appearance.background_applied', {
        source: img === 'none' || img === 'cover' ? img : 'own',
        scope,
      });
    },

    pickScope: (characterId, scope) => {
      const state = get();
      if (scope === state.scope) return;
      const restore = scope === 'character' && state.globalTouched ? state.globalAtOpen : undefined;
      commit(changeScope(state.prefs, characterId, scope, restore), {
        scope,
        globalTouched: scope === 'all',
      });
    },

    light: (characterId, appearance, value) =>
      commit(setLight(get().prefs, characterId, appearance, value)),

    addImage: async (characterId, file) => {
      const { ownerId, images } = get();
      if (!ownerId || (images?.length ?? 0) >= MAX_IMAGES) return false;
      try {
        const stored = await prepareImage(file, ownerId);
        // 存不进本机也先用上，只是下次打开没有了；失败单独记一笔。
        await saveImage(stored).catch(() => reportImportFailure('storage', file.size));
        if (get().ownerId !== ownerId) return false;
        set({ images: [toBackgroundImage(stored), ...(get().images ?? [])] });
        get().pick(characterId, stored.id);
        return true;
      } catch (error) {
        reportImportFailure(error instanceof ImageImportError ? error.reason : 'decode', file.size);
        return false;
      }
    },

    removeImage: (id) => {
      const image = get().images?.find((item) => item.id === id);
      if (!image) return;
      commit(forgetImage(get().prefs, id), {
        images: get().images?.filter((item) => item.id !== id) ?? null,
      });
      URL.revokeObjectURL(image.url);
      void deleteImage(id).catch(() => undefined);
    },
  };
});

function reportImportFailure(reason: string, bytes: number): void {
  const megabytes = bytes / 1024 / 1024;
  sendSentryLog('warn', 'appearance.background_import_failed', {
    reason,
    size_bucket:
      megabytes < 2 ? 'lt_2mb' : megabytes < 8 ? '2_8mb' : megabytes < 20 ? '8_20mb' : 'gt_20mb',
  });
}
