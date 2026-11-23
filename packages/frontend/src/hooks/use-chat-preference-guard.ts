'use client';

import { useCallback } from 'react';
import { useIsMutating, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { modelCatalogKeys } from '@/lib/api/models';
import { generationConfigKeys } from '@/lib/api/generation-config';

export const CHAT_PREFERENCES_SAVING = '模型或设置正在保存，请稍后再发送';

export function hasPendingChatPreferences(client: QueryClient): boolean {
  return (
    client.isMutating({ mutationKey: modelCatalogKeys.select }) > 0 ||
    client.isMutating({ mutationKey: generationConfigKeys.patch }) > 0
  );
}

type TurnInput = { mode: 'send' | 'regenerate'; content?: string };

/** Drafts and delayed reads never block chat; only an actual preference write does. */
export function useChatPreferenceGuard(dispatch: (input: TurnInput) => Promise<void>) {
  const client = useQueryClient();
  const modelWrites = useIsMutating({ mutationKey: modelCatalogKeys.select });
  const settingWrites = useIsMutating({ mutationKey: generationConfigKeys.patch });
  const canDispatch = useCallback(() => {
    // Check the cache synchronously too: a blur-triggered save can precede the next render.
    return !hasPendingChatPreferences(client);
  }, [client]);
  const runTurn = useCallback(
    async (input: TurnInput) => {
      if (canDispatch()) await dispatch(input);
    },
    [canDispatch, dispatch]
  );
  return { saving: modelWrites + settingWrites > 0, canDispatch, runTurn };
}
