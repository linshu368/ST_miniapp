'use client';

import { createContext, useContext } from 'react';
import { useEntryEnrichReady } from '@/lib/entry-phase';

// Derived from the current session, not a second global readiness state.
const ChatSecondaryReady = createContext(true);
export const ChatSecondaryReadyProvider = ChatSecondaryReady.Provider;

export function useChatEnrichReady(): boolean {
  const currentChatReady = useContext(ChatSecondaryReady);
  const documentReady = useEntryEnrichReady();
  return currentChatReady && documentReady;
}
