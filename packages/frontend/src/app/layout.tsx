import type { Metadata, Viewport } from 'next';
import { Noto_Sans_SC } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const notoSansSc = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-noto-sc',
  display: 'swap',
});

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
    <html lang="zh" className={`dark ${notoSansSc.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
