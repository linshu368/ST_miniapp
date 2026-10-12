import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { assertAdminPreviewApiUrl, resolveAdminPreviewApiUrl } from './src/lib/preview-api';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const previewInput = {
    configuredTestApiUrl: env.VITE_ADMIN_TEST_API_URL ?? '',
    vercelEnv: process.env.VERCEL_ENV,
    pullRequestId: process.env.VERCEL_GIT_PULL_REQUEST_ID,
    gitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  };

  // Preview values are compiled into the SPA. Fail during the deployment build instead of
  // releasing a login page that can only report the unhelpful browser-level fetch failure.
  const previewApiUrl =
    previewInput.vercelEnv === 'preview'
      ? assertAdminPreviewApiUrl(previewInput)
      : resolveAdminPreviewApiUrl(previewInput);

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_ADMIN_PREVIEW_TEST_API_URL': JSON.stringify(previewApiUrl),
    },
  };
});
