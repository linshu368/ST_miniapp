import type { ReactNode } from 'react';

export default function CreationLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-[100svh] bg-background">{children}</div>;
}
