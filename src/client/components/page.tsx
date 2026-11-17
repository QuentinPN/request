import { cn } from 'cn';
import type { ReactNode } from 'react';

/** `hideTitle` : le titre reste lu par les lecteurs d'écran quand un visuel plein cadre ouvre la page. */
export function Page({
  title,
  hideTitle = false,
  children,
}: {
  title: string;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-8">
      <h1 className={cn('text-3xl font-semibold tracking-tight', hideTitle && 'sr-only')}>{title}</h1>
      {children}
    </div>
  );
}
