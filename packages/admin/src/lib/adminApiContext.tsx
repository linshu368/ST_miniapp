import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminEnvironment } from '@miniapp/admin-client';
import { getAdminApiUrl } from './environment';

/**
 * 当前环境的后端调用入口。深层组件（如畅聊配置页的筛选按钮）直接从这里拿，
 * 不用把 client / 环境一层层穿过通用配置编辑器。
 */
export interface AdminApi {
  client: SupabaseClient;
  environment: AdminEnvironment;
  apiUrl: () => string;
}

const AdminApiContext = createContext<AdminApi | null>(null);

export function AdminApiProvider(props: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  children: ReactNode;
}) {
  const { client, environment } = props;
  const value = useMemo<AdminApi>(
    () => ({ client, environment, apiUrl: () => getAdminApiUrl(environment) }),
    [client, environment]
  );
  return <AdminApiContext.Provider value={value}>{props.children}</AdminApiContext.Provider>;
}

/** 不在 Provider 里（单测、预览）时为 null，调用方要能降级。 */
export function useAdminApi(): AdminApi | null {
  return useContext(AdminApiContext);
}
