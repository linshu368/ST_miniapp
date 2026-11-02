import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { EARLY_STARTUP_SCRIPT } from '@/lib/perf/early-startup';

export const metadata: Metadata = {
  title: 'MiniApp',
  description: 'AI Role-playing MiniApp',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  let apiOrigin: string | undefined;
  try {
    // next.config resolves this public URL for production, preview and local builds.
    const apiUrl = new URL(process.env.NEXT_PUBLIC_API_URL ?? '');
    if (apiUrl.protocol === 'https:' || apiUrl.protocol === 'http:') apiOrigin = apiUrl.origin;
  } catch {
    // A relative API URL already uses this page's connection; it needs no hint.
  }
  return (
    <html lang="zh" className="dark">
      <head>
        {apiOrigin ? <link rel="preconnect" href={apiOrigin} crossOrigin="anonymous" /> : null}
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
        <script id="miniapp-startup" dangerouslySetInnerHTML={{ __html: EARLY_STARTUP_SCRIPT }} />
      </body>
    </html>
  );
}
