import type {
  AdvanceCsSessionRequest,
  CreateCsPersonaRequest,
  CsTelegramReachabilityData,
  CsPersonaDataResponse,
  DeleteCsPersonaData,
  GetCsAppChatData,
  GetCsMessagesData,
  GetCsPersonaUsersData,
  GetCsPersonasData,
  GetCsSessionData,
  RefreshCsPersonaData,
  SendCsMessageData,
  SendCsMessageRequest,
  SkipCsSessionRequest,
  SnoozeCsSessionRequest,
  UpdateCsPersonaRequest,
  ApiResponse,
  GetCsSupportConversationsData,
  GetCsSupportMessagesData,
  SendCsSupportMessageRequest,
  SendSupportMessageData,
} from '@miniapp/shared';

const API_URL = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? 'https://stminiapp-production.up.railway.app' : 'http://localhost:3001')
).replace(/\/$/, '');
const TOKEN_KEY = 'cs_admin_token';
const OPERATOR_KEY = 'cs_operator_id';
const SUPPORT_ENV_KEY = 'cs_support_env';

/**
 * 客服工作台可以单独切后端环境：回访链路固定跑在 VITE_API_URL 上（线上客服在用，不能动），
 * 而工作台需要能指到还没发布到生产的测试后端去验证。
 */
export type CsSupportEnv = 'test' | 'production';

const SUPPORT_API_URLS: Record<CsSupportEnv, string> = {
  test: (
    import.meta.env.VITE_CS_TEST_API_URL || 'https://stminiapp-development.up.railway.app'
  ).replace(/\/$/, ''),
  production: (
    import.meta.env.VITE_CS_PROD_API_URL || 'https://stminiapp-production.up.railway.app'
  ).replace(/\/$/, ''),
};

export function getSupportEnv(): CsSupportEnv {
  return localStorage.getItem(SUPPORT_ENV_KEY) === 'production' ? 'production' : 'test';
}

export function setSupportEnv(env: CsSupportEnv) {
  localStorage.setItem(SUPPORT_ENV_KEY, env);
}

export function getSupportApiUrl(env: CsSupportEnv): string {
  return SUPPORT_API_URLS[env];
}

export function getCsAdminToken() {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setCsAdminToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getCsOperatorId() {
  return localStorage.getItem(OPERATOR_KEY) ?? 'cs-operator';
}

export function setCsOperatorId(operatorId: string) {
  localStorage.setItem(OPERATOR_KEY, operatorId);
}

async function apiClient<T>(path: string, options?: RequestInit, baseUrl = API_URL): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = getCsAdminToken();
  if (token) headers.set('X-CS-Admin-Token', token);
  headers.set('X-CS-Operator-Id', getCsOperatorId());
  if (options?.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const json = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!response.ok) {
    if (json && !json.success) throw new Error(json.error.message);
    throw new Error(`API error: ${response.status}`);
  }
  if (!json) throw new Error('API response is empty');
  if (!json.success) throw new Error(json.error.message);
  return json.data;
}

export const csApi = {
  personas: () => apiClient<GetCsPersonasData>('/api/cs/personas'),
  createPersona: (body: CreateCsPersonaRequest) =>
    apiClient<CsPersonaDataResponse>('/api/cs/personas', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updatePersona: (id: string, body: UpdateCsPersonaRequest) =>
    apiClient<CsPersonaDataResponse>(`/api/cs/personas/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deletePersona: (id: string) =>
    apiClient<DeleteCsPersonaData>(`/api/cs/personas/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  refreshPersona: (id: string) =>
    apiClient<RefreshCsPersonaData>(`/api/cs/personas/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
    }),
  users: (id: string) =>
    apiClient<GetCsPersonaUsersData>(`/api/cs/personas/${encodeURIComponent(id)}/users`),
  telegramReachability: (personaId: string, userId: string) =>
    apiClient<CsTelegramReachabilityData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/telegram-reachability`
    ),
  session: (personaId: string, userId: string) =>
    apiClient<GetCsSessionData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/session`
    ),
  messages: (personaId: string, userId: string) =>
    apiClient<GetCsMessagesData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/messages`
    ),
  appChat: (personaId: string, userId: string) =>
    apiClient<GetCsAppChatData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/app-chat`
    ),
  sendMessage: (personaId: string, userId: string, body: SendCsMessageRequest) =>
    apiClient<SendCsMessageData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  retryMessage: (personaId: string, userId: string, messageId: string) =>
    apiClient<SendCsMessageData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/retry`,
      { method: 'POST' }
    ),
  advance: (personaId: string, userId: string, body: AdvanceCsSessionRequest) =>
    apiClient<GetCsSessionData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/session/advance`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  snooze: (personaId: string, userId: string, body: SnoozeCsSessionRequest) =>
    apiClient<GetCsSessionData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/session/snooze`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  skip: (personaId: string, userId: string, body: SkipCsSessionRequest) =>
    apiClient<GetCsSessionData>(
      `/api/cs/personas/${encodeURIComponent(personaId)}/users/${encodeURIComponent(userId)}/session/skip`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  // MiniApp 内的客服会话，与上面基于 Telegram 的回访链路互不共用数据。
  // 这三个接口按 env 走各自的后端，回访接口不受影响。
  supportConversations: (env: CsSupportEnv) =>
    apiClient<GetCsSupportConversationsData>(
      '/api/cs/support/conversations',
      undefined,
      getSupportApiUrl(env)
    ),
  supportMessages: (env: CsSupportEnv, conversationId: string) =>
    apiClient<GetCsSupportMessagesData>(
      `/api/cs/support/conversations/${encodeURIComponent(conversationId)}/messages`,
      undefined,
      getSupportApiUrl(env)
    ),
  sendSupportMessage: (
    env: CsSupportEnv,
    conversationId: string,
    body: SendCsSupportMessageRequest
  ) =>
    apiClient<SendSupportMessageData>(
      `/api/cs/support/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'POST', body: JSON.stringify(body) },
      getSupportApiUrl(env)
    ),
  exportPersona: async (personaId: string, personaName: string) => {
    const headers = new Headers();
    const token = getCsAdminToken();
    if (token) headers.set('X-CS-Admin-Token', token);
    headers.set('X-CS-Operator-Id', getCsOperatorId());
    const response = await fetch(
      `${API_URL}/api/cs/personas/${encodeURIComponent(personaId)}/export`,
      {
        headers,
      }
    );
    if (!response.ok) throw new Error(`导出失败：${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${personaName}_回访数据.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
};
