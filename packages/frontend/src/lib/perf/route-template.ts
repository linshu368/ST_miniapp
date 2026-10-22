/**
 * 把请求路径归一成路由模板，作为指标维度。
 * 指标 attributes 必须低基数：带 id/query 会让维度爆炸，也可能泄漏用户标识。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const LONG_TOKEN = /^[0-9a-z_-]{20,}$/i;

export function toRouteTemplate(pathWithQuery: string): string {
  const path = pathWithQuery.split(/[?#]/, 1)[0] ?? '';
  return path
    .split('/')
    .map((segment) =>
      UUID.test(segment) || NUMERIC.test(segment) || LONG_TOKEN.test(segment) ? ':id' : segment
    )
    .join('/');
}
