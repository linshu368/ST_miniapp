'use client';

import { markPageFailed } from '@/lib/perf/page-tracker';
import { toRouteTemplate } from '@/lib/perf/route-template';
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    markPageFailed(toRouteTemplate(window.location.pathname), window.location.pathname);
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="zh">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <main className="w-full max-w-sm text-center">
          <h1 className="text-xl font-semibold">这一页卡住了</h1>
          <p className="mt-3 text-sm text-muted-foreground">问题已经记下来了，刷新一下再试试。</p>
          <button
            type="button"
            className="mt-6 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </main>
      </body>
    </html>
  );
}
