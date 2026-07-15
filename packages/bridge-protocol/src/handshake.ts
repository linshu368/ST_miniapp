import { z } from 'zod';

export type HandshakePhase = 'handshake' | 'ready';

export const HandshakePhaseSchema = z.enum(['handshake', 'ready']);

/** Only present when phase = 'handshake' */
export type HandshakeMeta = {
  stCommit: string;
  extensionBuildId: string;
  supportedActions: string[];
  supportedEvents: string[];
  boundUserId: string | null;
};

export const HandshakeMetaSchema = z.object({
  stCommit: z.string(),
  extensionBuildId: z.string(),
  supportedActions: z.array(z.string()),
  supportedEvents: z.array(z.string()),
  boundUserId: z.string().nullable(),
});

export const HANDSHAKE_ACTION_TIMEOUT = 30_000 as const;
export const HANDSHAKE_TOTAL_TIMEOUT = 60_000 as const;
export const HANDSHAKE_BUFFER_LIMIT = 32 as const;

export type ActionRequiredPhase = HandshakePhase;
