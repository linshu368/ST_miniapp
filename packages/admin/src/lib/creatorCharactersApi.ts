import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ApiResponse,
  GetCreatorCharacterData,
  ListCreatorReviewsData,
  CreatorReviewStatus,
  ReviewCreatorCharacterRequest,
} from '@miniapp/shared';
import { ReviewCreatorCharacterSchema } from '@miniapp/shared';
import { getAdminApiUrl, type AdminEnvironment } from './environment';
import { readAdminAccessToken } from './textPostprocessApi';

export function createCreatorCharactersApi(client: SupabaseClient, environment: AdminEnvironment) {
  async function request<T>(path: string, body?: ReviewCreatorCharacterRequest): Promise<T> {
    const token = await readAdminAccessToken(client);
    if (!token) throw new Error('登录已失效，请重新登录当前环境');
    const response = await fetch(
      `${getAdminApiUrl(environment)}/api/admin/creator-characters${path}`,
      {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(ReviewCreatorCharacterSchema.parse(body)) : undefined,
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (response.status === 401) throw new Error('登录已失效，请重新登录当前环境');
    if (response.status === 403) throw new Error('没有当前环境的审核权限');
    const result = (await response.json()) as ApiResponse<T>;
    if (!result.success) throw new Error(result.error.message);
    if (!response.ok) throw new Error('请求未完成，请刷新后重试');
    return result.data;
  }
  return {
    list: (status: CreatorReviewStatus) => request<ListCreatorReviewsData>(`?status=${status}`),
    get: (id: string) => request<GetCreatorCharacterData>(`/${encodeURIComponent(id)}`),
    review: (id: string, body: ReviewCreatorCharacterRequest) =>
      request<GetCreatorCharacterData>(`/${encodeURIComponent(id)}/review`, body),
  };
}
