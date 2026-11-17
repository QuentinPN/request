import { cn } from 'cn';
import type { ReactNode } from 'react';
import { Logo } from './logo';

/** Page hors navigation (connexion, assistant) : colonne centrée, nom de l'appli puis titre, comme R-Assistant. */
export function BarePage({
  title,
  intro,
  className,
  children,
}: {
  title: string;
  intro?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={cn('mx-auto flex w-full flex-col gap-4 px-(--space-page) py-8 lg:py-12', className)}>
      <header className="mb-2 flex flex-col gap-1.5">
        <Logo className="self-start text-lg" />
        <h1 className="text-[26px] font-extrabold tracking-[-0.02em] lg:text-[32px]">{title}</h1>
        {intro && <p className="text-muted-foreground">{intro}</p>}
      </header>
      {children}
    </main>
  );
}
