import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function previewTestApiUrl(): string {
  const pullRequestId = process.env.VERCEL_GIT_PULL_REQUEST_ID?.trim() ?? '';
  if (process.env.VERCEL_ENV !== 'preview' || !/^[1-9]\d*$/.test(pullRequestId)) return '';
  return `https://stminiapp-pr-${pullRequestId}.up.railway.app`;
}

export default defineConfig({
  plugins: [react()],
  // Vite only exposes VITE_* variables to browser code. Preserve the configured TEST API for
  // local/development builds, but bind each Vercel PR Preview to its isolated Railway backend.
  define: {
    'import.meta.env.VITE_ADMIN_PREVIEW_TEST_API_URL': JSON.stringify(previewTestApiUrl()),
  },
});
