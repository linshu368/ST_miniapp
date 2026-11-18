import { getDomainDb } from '../../lib/supabase.js';
import { bindBusinessContext } from '../../platform/observability/context.js';

/** Access is granted by the existing owner or a live shared work, including attempt-less seeds. */
export async function getAccessibleVideoArtifact(artifactId: string, userId: string) {
  const db = getDomainDb('media_plaza');
  const artifact = await db
    .from('video_artifacts')
    .select('id,attempt_id,stream_uid,poster_path')
    .eq('id', artifactId)
    .maybeSingle();
  if (artifact.error) throw new Error('video_artifact_read_failed', { cause: artifact.error });
  if (!artifact.data) return null;
  const row = artifact.data;
  const [owner, work] = await Promise.all([
    row.attempt_id
      ? db
          .from('video_attempts')
          .select('id,conversation_id')
          .eq('id', row.attempt_id)
          .eq('user_id', userId)
          .eq('status', 'ready')
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from('image_plaza_works')
      .select('id')
      .eq('video_artifact_id', artifactId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle(),
  ]);
  if (owner.error || work.error)
    throw new Error('video_artifact_access_failed', { cause: owner.error ?? work.error });
  if (!owner.data && !work.data) return null;
  if (typeof row.stream_uid !== 'string') throw new Error('video_stream_provider_unavailable');
  bindBusinessContext({
    business_module: 'image',
    user_id: userId,
    artifact_id: artifactId,
    ...(owner.data
      ? {
          attempt_id: String(owner.data.id),
          image_conversation_id: String(owner.data.conversation_id),
        }
      : {}),
    ...(work.data ? { work_id: String(work.data.id) } : {}),
  });
  return {
    id: String(row.id),
    streamUid: row.stream_uid,
    posterPath: row.poster_path ? String(row.poster_path) : null,
  };
}
