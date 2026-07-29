import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  SimulationChatStatusParamsSchema,
  SimulationChatRequestSchema,
  fail,
  ok,
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  type SimulationChatAcceptedData,
  type SimulationChatData,
  type SimulationChatRequest,
  type SimulationChatStatusData,
  type SimulationEffectiveConfig,
  type SimulationNameConflictResponse,
} from '@miniapp/shared';
import { getSupabaseClient } from '../lib/supabase.js';
import { config } from '../platform/config.js';
import { fetchModelCatalogSnapshot } from '../platform/model-tiers.js';

interface CharacterRecord {
  id: string;
  name: string;
  card_hash: string;
}

interface ConversationRecord {
  id: string;
  character_id: string;
  card_hash: string;
  st_handle: string;
  st_chat_id: string | null;
  requested_model_id: string | null;
  effective_model_id: string | null;
  preset_id: string | null;
  status: string;
}

interface WorkerResponse {
  assistantReply: string;
  stChatId: string;
  effectiveConfig: SimulationChatData['effective_config'];
}

async function requireSimulationServiceKey(request: FastifyRequest, reply: FastifyReply) {
  const configured = config.simulation.serviceKey;
  const provided = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!configured || !safeEqual(configured, provided)) {
    return reply.status(401).send(fail('UNAUTHORIZED', 'Invalid simulation service key'));
  }
}

function safeEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export default async function simulationRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.post(
    '/api/platform/simulation/chat',
    { preHandler: [requireSimulationServiceKey] },
    async (request, reply) => {
      const parsed = SimulationChatRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(
            fail('INVALID_ARGUMENT', parsed.error.issues.map((issue) => issue.message).join('; '))
          );
      }
      const input = parsed.data;
      const characterResult = await resolveTestCharacter(input.card_hash, input.name);
      if (characterResult.kind === 'not_found') {
        return reply.status(404).send(fail('NOT_FOUND', 'Test character not found'));
      }
      if (characterResult.kind === 'ambiguous') {
        const response: SimulationNameConflictResponse = {
          success: false,
          error: {
            code: 'AMBIGUOUS_CHARACTER_NAME',
            message: `Multiple test characters are named "${input.name}"`,
            candidates: characterResult.candidates,
          },
        };
        return reply.status(409).send(response);
      }
      const character = characterResult.character;
      if (input.preset_id) {
        try {
          if (!(await isEnabledPreset(input.preset_id))) {
            return reply.status(400).send(fail('INVALID_PRESET', 'preset_id is not enabled'));
          }
        } catch (error) {
          return reply.status(500).send(fail('INTERNAL_ERROR', String(error)));
        }
      }

      let conversation: ConversationRecord;
      try {
        conversation = input.conversation_id
          ? await loadConversation(input.conversation_id, character.id)
          : await createConversation(character, input.model_id ?? null, input.preset_id ?? null);
      } catch (error) {
        return reply.status(409).send(fail('CONVERSATION_CONFLICT', String(error)));
      }

      if (input.preset_id && conversation.preset_id && input.preset_id !== conversation.preset_id) {
        return reply
          .status(409)
          .send(fail('CONVERSATION_CONFLICT', 'preset_id cannot change within a conversation'));
      }
      let effectiveModelId: string;
      try {
        effectiveModelId = await resolveModelId(
          input.model_id ?? conversation.effective_model_id ?? null
        );
      } catch (error) {
        return reply.status(400).send(fail('INVALID_MODEL', String(error)));
      }

      const turnId = randomUUID();
      const simulationDb = getSupabaseClient().schema('miniapp_simulation' as 'public');
      const { data: claimedConversation, error: busyError } = await simulationDb
        .from('conversations')
        .update({
          requested_model_id: input.model_id ?? conversation.requested_model_id,
          effective_model_id: effectiveModelId,
          current_turn_id: turnId,
          current_turn_metadata: input.metadata,
          status: 'busy',
          updated_at: new Date().toISOString(),
          last_active_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)
        .in('status', ['starting', 'ready', 'failed'])
        .select('id')
        .maybeSingle();
      if (busyError) {
        return reply.status(500).send(fail('INTERNAL_ERROR', busyError.message));
      }
      if (!claimedConversation) {
        return reply.status(409).send(fail('CONVERSATION_BUSY', 'Another turn is already running'));
      }

      const runTurn = () =>
        executeWorkerTurn({
          conversation,
          character,
          input,
          effectiveModelId,
          turnId,
          log: request.log,
        });

      if (input.response_mode === 'async') {
        void runTurn().catch(() => {
          // executeWorkerTurn persists and logs failures before rejecting.
        });
        return reply.status(202).send(
          ok<SimulationChatAcceptedData>({
            status: 'accepted',
            conversation_id: conversation.id,
            turn_id: turnId,
            status_url: `/api/platform/simulation/chat/${turnId}`,
          })
        );
      }

      try {
        return reply.send(ok<SimulationChatData>(await runTurn()));
      } catch (error) {
        return reply.status(502).send(fail('SIMULATION_WORKER_ERROR', String(error)));
      }
    }
  );

  // @frontend-ready: true
  app.get(
    '/api/platform/simulation/chat/:turnId',
    { preHandler: [requireSimulationServiceKey] },
    async (request, reply) => {
      const parsed = SimulationChatStatusParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send(fail('INVALID_ARGUMENT', 'turnId must be a UUID'));
      }

      try {
        const status = await loadTurnStatus(parsed.data.turnId);
        if (!status) {
          return reply.status(404).send(fail('NOT_FOUND', 'Simulation turn not found'));
        }
        return reply.send(ok<SimulationChatStatusData>(status));
      } catch (error) {
        request.log.error(
          { err: String(error), turnId: parsed.data.turnId },
          '[simulation] failed to load turn status'
        );
        return reply.status(500).send(fail('INTERNAL_ERROR', String(error)));
      }
    }
  );
}

async function executeWorkerTurn({
  conversation,
  character,
  input,
  effectiveModelId,
  turnId,
  log,
}: {
  conversation: ConversationRecord;
  character: CharacterRecord;
  input: SimulationChatRequest;
  effectiveModelId: string;
  turnId: string;
  log: FastifyBaseLogger;
}): Promise<SimulationChatData> {
  const simulationDb = getSupabaseClient().schema('miniapp_simulation' as 'public');
  let workerResponse: WorkerResponse;
  try {
    const worker = await fetch(`${config.stProvisionUrl}/simulation/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        stHandle: conversation.st_handle,
        characterId: character.id,
        stChatId: conversation.st_chat_id,
        userMessage: input.user_message,
        turnId,
        metadata: input.metadata,
        requestedModelId: effectiveModelId,
        requestedPresetId: input.preset_id ?? conversation.preset_id,
      }),
      signal: AbortSignal.timeout(config.simulation.workerTimeoutMs),
    });
    if (!worker.ok) {
      throw new Error(`simulation worker failed (${worker.status}): ${await worker.text()}`);
    }
    workerResponse = (await worker.json()) as WorkerResponse;
  } catch (error) {
    await simulationDb
      .from('conversations')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', conversation.id)
      .eq('current_turn_id', turnId);
    log.error(
      { err: String(error), conversationId: conversation.id, turnId },
      '[simulation] worker failed'
    );
    throw error;
  }

  const { error: readyError } = await simulationDb
    .from('conversations')
    .update({
      st_chat_id: workerResponse.stChatId,
      effective_model_id: workerResponse.effectiveConfig.model_id,
      preset_id: workerResponse.effectiveConfig.preset_id,
      status: 'ready',
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
    .eq('current_turn_id', turnId);
  if (readyError) {
    log.error(
      { err: readyError.message, conversationId: conversation.id, turnId },
      '[simulation] failed to persist ready state'
    );
  }

  return {
    conversation_id: conversation.id,
    chat_log_id: turnId,
    character_id: character.id,
    card_hash: character.card_hash,
    character_name: character.name,
    assistant_reply: workerResponse.assistantReply,
    effective_config: workerResponse.effectiveConfig,
  };
}

async function loadTurnStatus(turnId: string): Promise<SimulationChatStatusData | null> {
  const supabase = getSupabaseClient();
  const simulationDb = supabase.schema('miniapp_simulation' as 'public');
  const { data: chatLog, error: chatLogError } = await simulationDb
    .from('chat_log')
    .select('id,conversation_id,assistant_reply,status,effective_config')
    .eq('id', turnId)
    .maybeSingle();
  if (chatLogError) throw new Error(chatLogError.message);

  let conversationQuery = simulationDb
    .from('conversations')
    .select('id,character_id,card_hash,current_turn_id,status');
  conversationQuery = chatLog?.conversation_id
    ? conversationQuery.eq('id', chatLog.conversation_id)
    : conversationQuery.eq('current_turn_id', turnId);
  const { data: conversation, error: conversationError } = await conversationQuery.maybeSingle();
  if (conversationError) throw new Error(conversationError.message);
  if (!conversation) return null;

  if (
    chatLog &&
    typeof chatLog.assistant_reply === 'string' &&
    chatLog.assistant_reply.length > 0 &&
    isEffectiveConfig(chatLog.effective_config)
  ) {
    const { data: character, error: characterError } = await supabase
      .schema('miniapp' as 'public')
      .from('characters')
      .select('name')
      .eq('id', conversation.character_id)
      .single();
    if (characterError || !character) {
      throw new Error(characterError?.message ?? 'character not found');
    }
    return {
      status: 'completed',
      conversation_id: conversation.id,
      turn_id: turnId,
      result: {
        conversation_id: conversation.id,
        chat_log_id: turnId,
        character_id: conversation.character_id,
        card_hash: conversation.card_hash,
        character_name: character.name,
        assistant_reply: chatLog.assistant_reply,
        effective_config: chatLog.effective_config,
      },
    };
  }

  if (conversation.status === 'failed' || chatLog?.status === 'failed') {
    return {
      status: 'failed',
      conversation_id: conversation.id,
      turn_id: turnId,
      error: 'Simulation worker failed; retry this conversation with a new turn',
    };
  }

  return {
    status: 'pending',
    conversation_id: conversation.id,
    turn_id: turnId,
  };
}

function isEffectiveConfig(value: unknown): value is SimulationEffectiveConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const configValue = value as Record<string, unknown>;
  return (
    typeof configValue.model_id === 'string' &&
    typeof configValue.model_name === 'string' &&
    (configValue.preset_id === null || typeof configValue.preset_id === 'string') &&
    (configValue.preset_version === null ||
      typeof configValue.preset_version === 'string' ||
      typeof configValue.preset_version === 'number') &&
    Boolean(configValue.sampling) &&
    typeof configValue.sampling === 'object' &&
    !Array.isArray(configValue.sampling)
  );
}

async function resolveTestCharacter(
  cardHash?: string,
  name?: string
): Promise<
  | { kind: 'found'; character: CharacterRecord }
  | { kind: 'not_found' }
  | {
      kind: 'ambiguous';
      candidates: Array<{ character_id: string; card_hash: string }>;
    }
> {
  const db = getSupabaseClient().schema('miniapp' as 'public');
  let query = db
    .from('characters')
    .select('id,name,card_hash')
    .eq('is_test', true)
    .eq('enabled', false);
  query = cardHash ? query.eq('card_hash', cardHash) : query.eq('name', name ?? '');
  const { data, error } = await query.limit(1000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as CharacterRecord[];
  if (rows.length === 0) return { kind: 'not_found' };
  if (!cardHash && rows.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: rows.map((row) => ({
        character_id: row.id,
        card_hash: row.card_hash,
      })),
    };
  }
  return { kind: 'found', character: rows[0]! };
}

async function resolveModelId(requestedModelId: string | null): Promise<string> {
  const snapshot = await fetchModelCatalogSnapshot();
  const effectiveId = resolveEffectiveSelectedModelId(snapshot.catalog, requestedModelId);
  return resolveEnabledCatalogModel(snapshot.catalog, effectiveId).id;
}

async function isEnabledPreset(presetId: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient()
    .schema('st_platform' as 'public')
    .from('platform_presets')
    .select('id')
    .eq('id', presetId)
    .eq('enabled', true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}

async function createConversation(
  character: CharacterRecord,
  requestedModelId: string | null,
  presetId: string | null
): Promise<ConversationRecord> {
  const id = randomUUID();
  const effectiveModelId = await resolveModelId(requestedModelId);
  const stHandle = `sim-${id.replaceAll('-', '')}`;
  const { data, error } = await getSupabaseClient()
    .schema('miniapp_simulation' as 'public')
    .from('conversations')
    .insert({
      id,
      character_id: character.id,
      card_hash: character.card_hash,
      st_handle: stHandle,
      requested_model_id: requestedModelId,
      effective_model_id: effectiveModelId,
      preset_id: presetId,
      status: 'starting',
    })
    .select(
      'id,character_id,card_hash,st_handle,st_chat_id,requested_model_id,effective_model_id,preset_id,status'
    )
    .single();
  if (error || !data) throw new Error(error?.message ?? 'failed to create conversation');
  return data as ConversationRecord;
}

async function loadConversation(
  conversationId: string,
  characterId: string
): Promise<ConversationRecord> {
  const { data, error } = await getSupabaseClient()
    .schema('miniapp_simulation' as 'public')
    .from('conversations')
    .select(
      'id,character_id,card_hash,st_handle,st_chat_id,requested_model_id,effective_model_id,preset_id,status'
    )
    .eq('id', conversationId)
    .single();
  if (error || !data) throw new Error('conversation not found');
  const conversation = data as ConversationRecord;
  if (conversation.character_id !== characterId) {
    throw new Error('conversation is bound to a different character');
  }
  return conversation;
}
