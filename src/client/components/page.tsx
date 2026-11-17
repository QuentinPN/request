import type { ReactNode } from 'react';

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
