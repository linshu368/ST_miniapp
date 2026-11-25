'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { PatchGenerationConfigRequest } from '@miniapp/shared';
import {
  useGenerationConfigQuery,
  usePatchGenerationConfigMutation,
} from '@/lib/api/generation-config';
import { useChatEnrichReady } from './chat-entry-readiness';
import { isInstructionSlotEnabled } from './chat-generation-settings-state';
import { claimReplyPreferenceGuide } from './reply-preference-display';
import { usePullDownToClose } from './use-pull-down-close';
export const MAX_CUSTOM_INSTRUCTIONS = 500;

type SlotKey = 'memory' | 'choice';
type PendingSlotValues = Partial<Record<SlotKey, boolean>>;

export const SLOT_CONFIG: ReadonlyArray<{
  key: SlotKey;
  label: string;
  preference: 'pref_show_memory' | 'pref_show_options';
}> = [
  { key: 'memory', label: '记忆栏', preference: 'pref_show_memory' },
  { key: 'choice', label: '可选项', preference: 'pref_show_options' },
];

function useReplyPreferenceState() {
  const [open, setOpen] = useState(false);
  const enrichReady = useChatEnrichReady();
  const query = useGenerationConfigQuery(enrichReady || open);
  const patch = usePatchGenerationConfigMutation({
    shouldOptimisticallyUpdate: () => true,
  });
  const config = query.data?.config;
  const styleOptions = query.data?.reply_style_options ?? [];
  const driveModes = query.data?.drive_modes;
  const wordCountTiers = query.data?.word_count_tiers;
  const lengthOptions = (wordCountTiers?.tiers ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [guideVisible, setGuideVisible] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [pendingWordCount, setPendingWordCount] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pendingSlotValues, setPendingSlotValues] = useState<PendingSlotValues>({});
  const [pendingStyleValues, setPendingStyleValues] = useState<Record<string, boolean>>({});
  const [failedStyleValues, setFailedStyleValues] = useState<Record<string, boolean>>({});
  const [pendingDriveMode, setPendingDriveMode] = useState<string | null>(null);
  const [driveModeFailed, setDriveModeFailed] = useState(false);
  const styleDescriptionId = useId();
  const activeWordCount =
    pendingWordCount ??
    (lengthOptions.some((tier) => tier.id === config?.pref_word_count)
      ? config?.pref_word_count
      : wordCountTiers?.default_tier_id);
  const saving =
    patch.isPending ||
    pendingWordCount !== null ||
    pendingDriveMode !== null ||
    Object.keys(pendingSlotValues).length > 0 ||
    Object.keys(pendingStyleValues).length > 0;
  const pointerStartY = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const guideClaimed = useRef(false);

  useEffect(() => {
    if (guideClaimed.current) return;
    guideClaimed.current = true;
    setGuideVisible(claimReplyPreferenceGuide());
  }, []);

  useEffect(() => {
    if (instructionsDirty) return;
    setInstructions(config?.pref_custom_instructions ?? '');
  }, [config?.pref_custom_instructions, instructionsDirty]);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) setGuideVisible(false);
  };
  // 内容已滚到顶时继续下拉，整个回复偏好收起。
  usePullDownToClose(scroller, () => changeOpen(false));

  return {
    open,
    query,
    patch,
    config,
    styleOptions,
    driveModes,
    wordCountTiers,
    lengthOptions,
    setScroller,
    guideVisible,
    instructions,
    setInstructions,
    setInstructionsDirty,
    pendingWordCount,
    setPendingWordCount,
    saveFailed,
    setSaveFailed,
    pendingSlotValues,
    setPendingSlotValues,
    pendingStyleValues,
    setPendingStyleValues,
    failedStyleValues,
    setFailedStyleValues,
    pendingDriveMode,
    setPendingDriveMode,
    driveModeFailed,
    setDriveModeFailed,
    styleDescriptionId,
    activeWordCount,
    saving,
    pointerStartY,
    suppressClick,
    changeOpen,
  };
}
function useReplyPreferenceWrites(state: ReturnType<typeof useReplyPreferenceState>) {
  const {
    config,
    patch,
    instructions,
    setInstructionsDirty,
    pendingWordCount,
    setPendingWordCount,
    activeWordCount,
    pendingDriveMode,
    setPendingDriveMode,
    setDriveModeFailed,
    pendingSlotValues,
    setPendingSlotValues,
    pendingStyleValues,
    setPendingStyleValues,
    setFailedStyleValues,
    setSaveFailed,
  } = state;
  const savePreference = async (request: PatchGenerationConfigRequest) => {
    setSaveFailed(false);
    try {
      await patch.mutateAsync(request);
      return true;
    } catch {
      setSaveFailed(true);
      return false;
    }
  };

  const changeWordCount = (id: string) => {
    if (!config || pendingWordCount !== null || id === activeWordCount) return;
    setPendingWordCount(id);
    void savePreference({ pref_word_count: id }).finally(() => setPendingWordCount(null));
  };

  const changeDriveMode = (id: string) => {
    if (!config || pendingDriveMode !== null || id === config.pref_drive_mode) return;
    setPendingDriveMode(id);
    setDriveModeFailed(false);
    void savePreference({ pref_drive_mode: id })
      .then((saved) => setDriveModeFailed(!saved))
      .finally(() => setPendingDriveMode(null));
  };

  const saveInstructions = () => {
    if (!config) return;
    const next = instructions.trim();
    setInstructionsDirty(false);
    if (next === (config.pref_custom_instructions ?? '')) return;
    void savePreference({ pref_custom_instructions: next.length > 0 ? next : null });
  };

  const toggleReplyStyle = (id: string) => {
    if (!config || Object.prototype.hasOwnProperty.call(pendingStyleValues, id)) return;
    const next = config.pref_reply_styles?.[id] !== true;
    setPendingStyleValues((current) => ({ ...current, [id]: next }));
    setFailedStyleValues((current) => ({ ...current, [id]: false }));
    void savePreference({ pref_reply_styles: { [id]: next } })
      .then((saved) => {
        if (!saved) setFailedStyleValues((current) => ({ ...current, [id]: true }));
      })
      .finally(() => {
        setPendingStyleValues((current) => {
          if (current[id] !== next) return current;
          const { [id]: _completed, ...remaining } = current;
          return remaining;
        });
      });
  };

  const toggleSlot = (slot: (typeof SLOT_CONFIG)[number]) => {
    if (!config || Object.prototype.hasOwnProperty.call(pendingSlotValues, slot.key)) return;

    const enabled =
      pendingSlotValues[slot.key] ?? isInstructionSlotEnabled(config[slot.preference]);
    const next = !enabled;
    setPendingSlotValues((current) => ({ ...current, [slot.key]: next }));

    // 每次请求独立清理，避免连续修改不同偏好时后一次调用替换前一次回调。
    void savePreference({ [slot.preference]: next }).finally(() => {
      setPendingSlotValues((current) => {
        if (current[slot.key] !== next) return current;
        const { [slot.key]: _completed, ...remaining } = current;
        return remaining;
      });
    });
  };

  return { changeWordCount, changeDriveMode, saveInstructions, toggleReplyStyle, toggleSlot };
}
export function useChatReplyPreferences() {
  const state = useReplyPreferenceState();
  const writes = useReplyPreferenceWrites(state);
  const { patch: _patch, ...view } = state;
  return { ...view, ...writes };
}
