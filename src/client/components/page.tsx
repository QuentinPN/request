import { cn } from 'cn';
import type { ReactNode } from 'react';
import { BackButton, type BackTarget } from './back-button';

/**
 * `hideTitle` : le titre reste lu par les lecteurs d'écran quand un visuel plein cadre ouvre la page.
 * `back` : page ouverte depuis une autre (Compte…) ; le bouton « Retour » y mène quand l'historique est vide.
 */
export function Page({
  title,
  hideTitle = false,
  back,
  children,
}: {
  title: string;
  hideTitle?: boolean;
  back?: BackTarget;
  children: ReactNode;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        {back && <BackButton fallback={back} text />}
        <h1 className={cn('text-3xl font-semibold tracking-tight', hideTitle && 'sr-only')}>{title}</h1>
      </div>
      {children}
    </div>
  );
}
