/**
 * 把请求路径归一成路由模板，作为指标维度。
 * 指标 attributes 必须低基数：带 id/query 会让维度爆炸，也可能泄漏用户标识。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_TOKEN = /^[0-9a-z_-]{20,}$/i;

/** 已登记页面才进入工程聚合；未知短路径也可能含用户名，不能直接当标签。 */
export const ENGINEERING_PAGE_ROUTES = new Set([
  '/',
  '/characters',
  '/chats',
  '/chat/:id',
  '/chat/:id/voice/:id',
  '/create',
  '/create/studio/:id',
  '/create/work/:id',
  '/dramas',
  '/dramas/:id',
  '/vip',
  '/profile',
  '/profile/recharge',
  '/profile/recharge/:id',
  '/profile/orders',
  '/profile/spending',
  '/profile/messages',
  '/profile/messages/:id',
  '/profile/invite',
  '/profile/support',
]);

export function engineeringRoute(route: string): string {
  return ENGINEERING_PAGE_ROUTES.has(route) ? route : 'other';
}

export function toRouteTemplate(pathWithQuery: string): string {
  const path = pathWithQuery.split(/[?#]/, 1)[0] ?? '';
  return path
    .split('/')
    .map((segment) =>
      UUID.test(segment) || NUMERIC.test(segment) || LONG_TOKEN.test(segment) ? ':id' : segment
    )
    .join('/');
}
