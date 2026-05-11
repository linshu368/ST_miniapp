import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';

import './globals.css';
import { Providers } from './providers';

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
  return (
    <html lang="zh" className={`dark ${GeistSans.variable}`}>
      <body className="min-h-screen bg-black font-sans text-foreground antialiased">
        <div className="relative mx-auto min-h-screen w-full max-w-[390px] overflow-x-hidden bg-background">
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
