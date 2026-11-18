import { type ImagePlazaArtifact, type ImagePlazaConversation } from '@miniapp/shared';
import { ImagePlazaFeedRepository } from './repository-feed.js';
import {
  type ArtifactRow,
  type AttemptRow,
  type ConversationRow,
  type MessageRow,
  type VideoArtifactRow,
  type VideoConversationAttemptRow,
  mapAttemptRow,
  mapConversationRow,
  mapVideoConversationAttempt,
} from './repository-model.js';
import { signPlazaImagePath } from './storage.js';

export class ImagePlazaConversationRepository extends ImagePlazaFeedRepository {
  async listConversations(
    userId: string
  ): Promise<Array<Omit<ImagePlazaConversation, 'messages'>>> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error)
      throw new Error(`image plaza conversations read failed: ${error.message}`, { cause: error });
    return (data ?? []).map((row) => {
      const conversation = mapConversationRow(row as ConversationRow, []);
      const { messages: _messages, ...summary } = conversation;
      return summary;
    });
  }

  async getConversation(
    conversationId: string,
    userId: string
  ): Promise<ImagePlazaConversation | null> {
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_conversations')
      .select('*')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error)
      throw new Error(`image plaza conversation read failed: ${error.message}`, { cause: error });
    return data ? this.hydrateConversation(data as ConversationRow) : null;
  }

  protected async hydrateConversation(row: ConversationRow): Promise<ImagePlazaConversation> {
    const [
      { data: messages, error: messageError },
      { data: attempts, error: attemptError },
      videoResult,
    ] = await Promise.all([
      this.mediaPlaza
        .from('image_plaza_messages')
        .select('*')
        .eq('conversation_id', row.id)
        .order('created_at'),
      this.mediaPlaza.from('image_plaza_attempts').select('*').eq('conversation_id', row.id),
      this.mediaPlaza.from('video_attempts').select('*').eq('conversation_id', row.id),
    ]);
    const videoMissing = ['42P01', 'PGRST205'].includes(videoResult.error?.code ?? '');
    if (messageError || attemptError || (videoResult.error && !videoMissing))
      throw new Error('image_plaza_conversation_hydration_failed', {
        cause: messageError ?? attemptError ?? videoResult.error,
      });
    const attemptRows = (attempts ?? []) as AttemptRow[];
    const artifacts = await this.getArtifacts(attemptRows.map((attempt) => attempt.id));
    const byAssistantMessage = new Map(
      attemptRows.map((attempt) => [
        attempt.assistant_message_id,
        mapAttemptRow(attempt, artifacts.get(attempt.id) ?? []),
      ])
    );
    const videoRows = videoMissing
      ? []
      : ((videoResult.data ?? []) as VideoConversationAttemptRow[]);
    const videoArtifacts = await this.getVideoArtifacts(videoRows.map((attempt) => attempt.id));
    const videoByAssistantMessage = new Map(
      await Promise.all(
        videoRows.map(
          async (attempt) =>
            [
              attempt.assistant_message_id,
              await mapVideoConversationAttempt(attempt, videoArtifacts.get(attempt.id) ?? null),
            ] as const
        )
      )
    );
    return mapConversationRow(
      row,
      ((messages ?? []) as MessageRow[]).map((message) => ({
        ...message,
        attempt: byAssistantMessage.get(message.id) ?? null,
        videoAttempt: videoByAssistantMessage.get(message.id) ?? null,
      }))
    );
  }

  protected async getVideoArtifacts(attemptIds: string[]): Promise<Map<string, VideoArtifactRow>> {
    const result = new Map<string, VideoArtifactRow>();
    if (attemptIds.length === 0) return result;
    const { data, error } = await this.mediaPlaza
      .from('video_artifacts')
      .select('*')
      .in('attempt_id', attemptIds);
    if (error)
      throw new Error(`video plaza artifacts read failed: ${error.message}`, { cause: error });
    for (const row of (data ?? []) as VideoArtifactRow[]) result.set(String(row.attempt_id), row);
    return result;
  }

  protected async getArtifacts(attemptIds: string[]): Promise<Map<string, ImagePlazaArtifact[]>> {
    const result = new Map<string, ImagePlazaArtifact[]>();
    if (attemptIds.length === 0) return result;
    const { data, error } = await this.mediaPlaza
      .from('image_plaza_artifacts')
      .select('*')
      .in('attempt_id', attemptIds)
      .order('position');
    if (error)
      throw new Error(`image plaza artifacts read failed: ${error.message}`, { cause: error });
    await Promise.all(
      ((data ?? []) as ArtifactRow[]).map(async (row) => {
        const list = result.get(row.attempt_id) ?? [];
        list.push({
          id: row.id,
          image_url: await signPlazaImagePath(row.storage_path),
          width: row.width,
          height: row.height,
        });
        result.set(row.attempt_id, list);
      })
    );
    return result;
  }
}
