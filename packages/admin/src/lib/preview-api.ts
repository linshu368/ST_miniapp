export interface AdminPreviewApiInput {
  configuredTestApiUrl: string;
  vercelEnv: string | undefined;
  pullRequestId: string | undefined;
}

export function resolveAdminPreviewApiUrl(input: AdminPreviewApiInput): string {
  const pullRequestId = input.pullRequestId?.trim() ?? '';
  if (input.vercelEnv === 'preview' && /^[1-9]\d*$/.test(pullRequestId)) {
    return `https://stminiapp-pr-${pullRequestId}.up.railway.app`;
  }
  return input.configuredTestApiUrl.trim();
}

export function assertAdminPreviewApiUrl(input: AdminPreviewApiInput): string {
  const apiUrl = resolveAdminPreviewApiUrl(input);
  if (!apiUrl) {
    throw new Error(
      'Admin Preview requires VITE_ADMIN_TEST_API_URL when VERCEL_GIT_PULL_REQUEST_ID is unavailable.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error('Admin Preview API URL must be an absolute HTTPS URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Admin Preview API URL must use HTTPS.');
  }
  return apiUrl;
}
