'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="zh">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <main className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold">页面暂时无法正常显示</h1>
          <p className="mt-3 text-sm text-muted-foreground">问题信息已记录，请稍后重试。</p>
          <button
            type="button"
            className="mt-6 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={reset}
          >
            重新加载
          </button>
        </main>
      </body>
    </html>
  );
}
