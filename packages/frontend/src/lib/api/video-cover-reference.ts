'use client';

import type { QueryClient } from '@tanstack/react-query';
import type {
  GetImagePlazaWorkData,
  ImagePlazaArtifact,
  ImagePlazaConversation,
  UploadImagePlazaReferenceData,
  UploadImagePlazaReferenceRequest,
} from '@miniapp/shared';
import { apiClient } from './client';
import { imagePlazaKeys } from './image-plaza-keys';
import { fileToImagePlazaPayload } from './image-plaza';

export function latestConversationCover(conversation: ImagePlazaConversation): string | null {
  for (let index = conversation.messages.length - 1; index >= 0; index--) {
    const message = conversation.messages[index]!;
    if (message.video_attempt?.status === 'ready' && message.video_attempt.artifact?.poster_url)
      return message.video_attempt.artifact.poster_url;
    if (message.attempt?.status === 'ready' && message.attempt.artifacts[0])
      return message.attempt.artifacts[0].image_url;
  }
  return null;
}

/** Resolve only API-authorized assets from this conversation, never an arbitrary global image. */
export async function createVideoCoverReference(
  client: QueryClient,
  conversation: ImagePlazaConversation | undefined,
  retryCoverUrl: string | null,
  upload: (body: UploadImagePlazaReferenceRequest) => Promise<UploadImagePlazaReferenceData>
): Promise<ImagePlazaArtifact> {
  if (!conversation) throw new Error('请先添加参考图后再生成');
  let cover = retryCoverUrl;
  if (!cover && conversation.source_work_id) {
    const id = conversation.source_work_id;
    const { work } = await client.fetchQuery({
      queryKey: imagePlazaKeys.work(id),
      queryFn: ({ signal }) =>
        apiClient<GetImagePlazaWorkData>(`/api/image-plaza/works/${id}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      staleTime: 60_000,
      retry: false,
    });
    cover = work.media_type === 'video' ? work.poster_url : work.image_url;
  }
  cover ??= latestConversationCover(conversation);
  if (!cover) throw new Error('当前没有可用封面，请先添加参考图');
  const payload = await downloadCoverPayload(cover).catch(() => {
    // Native fetch/URL errors can include a signed address; keep UI and telemetry errors fixed.
    throw new Error('封面读取失败，请手动添加参考图');
  });
  return (await upload(payload)).artifact;
}

async function downloadCoverPayload(url: string): Promise<UploadImagePlazaReferenceRequest> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password)
    throw new Error('封面地址不可用，请手动添加参考图');
  const response = await fetch(target, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok || !response.body) throw new Error('封面读取失败，请手动添加参考图');
  const maxBytes = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw new Error('封面超过20MB，请手动添加参考图');
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('封面超过20MB，请手动添加参考图');
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  return fileToImagePlazaPayload(new File(chunks, 'video-cover', { type }));
}
