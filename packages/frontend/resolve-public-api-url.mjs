export const PRODUCTION_API_URL = 'https://stminiapp-production.up.railway.app';
export const DEVELOPMENT_API_URL = 'https://stminiapp-development.up.railway.app';

/**
 * Vercel Preview 的 NEXT_PUBLIC_API_URL 是项目级共享变量，上一轮 PR 的值会留在那里。
 * Feature PR 必须按 PR 号 1:1 指向 Railway `pr-{n}`，不能再读这份残留配置。
 */
export function resolvePublicApiUrl(env = process.env) {
  const configured =
    typeof env.NEXT_PUBLIC_API_URL === 'string' ? env.NEXT_PUBLIC_API_URL.trim() : '';
  const vercelEnv = env.VERCEL_ENV;
  const gitRef = env.VERCEL_GIT_COMMIT_REF;
  const prId =
    parsePrNumber(env.VERCEL_GIT_PULL_REQUEST_ID) ?? parsePrNumber(env.VERCEL_TARGET_ENV);

  if (vercelEnv === 'production') {
    return configured || PRODUCTION_API_URL;
  }

  if (prId) {
    return `https://stminiapp-pr-${prId}.up.railway.app`;
  }

  if (vercelEnv === 'preview' || gitRef === 'dev' || env.VERCEL_TARGET_ENV === 'dev') {
    return DEVELOPMENT_API_URL;
  }

  return configured || DEVELOPMENT_API_URL;
}

function parsePrNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const named = /^pr-(\d+)$/i.exec(trimmed);
  return named ? named[1] : null;
}
