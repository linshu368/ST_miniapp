import type { Metadata, Viewport } from 'next';
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
    <html lang="zh" className="light" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var m=localStorage.getItem('st_miniapp_appearance_mode');m=m==='dark'?'dark':'light';document.documentElement.classList.remove('dark','light');document.documentElement.classList.add(m);document.documentElement.dataset.appearance=m}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
