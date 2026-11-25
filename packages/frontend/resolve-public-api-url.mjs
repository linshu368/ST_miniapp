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

  // A deployment from the stable `dev` branch can retain the PR id that
  // originally triggered it (for example after a merge/redeploy). The branch
  // and custom environment are authoritative in that case.
  if (gitRef === 'dev') {
    return DEVELOPMENT_API_URL;
  }

  if (prId) {
    return `https://stminiapp-pr-${prId}.up.railway.app`;
  }

  if (vercelEnv === 'preview' || gitRef === 'dev' || env.VERCEL_TARGET_ENV === 'dev') {
    return DEVELOPMENT_API_URL;
  }

  return configured || DEVELOPMENT_API_URL;
}

// A production build can reference a test image. Both deployment and source must opt in.
export function isTestImageBuild(env = process.env) {
  if (env.VERCEL_TARGET_ENV === 'production' || env.VERCEL_GIT_COMMIT_REF === 'main') return false;
  const preview = env.VERCEL_ENV === 'preview' || env.VERCEL_ENV === 'development';
  const localDev = !env.VERCEL_ENV && env.NODE_ENV === 'development';
  if (!preview && !localDev) return false;
  const api = resolvePublicApiUrl(env);
  return (
    api === DEVELOPMENT_API_URL ||
    /^https:\/\/stminiapp-pr-\d+\.up\.railway\.app$/.test(api) ||
    (localDev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api))
  );
}

function parsePrNumber(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const named = /^pr-(\d+)$/i.exec(trimmed);
  return named ? named[1] : null;
}
