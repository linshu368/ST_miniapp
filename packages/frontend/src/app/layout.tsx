import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MiniApp',
  description: 'AI Role-playing MiniApp',
  viewport: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <body className="bg-black text-white min-h-screen">
        {children}
      </body>
    </html>
  );
}