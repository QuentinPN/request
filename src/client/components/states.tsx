import { cn } from 'cn';
import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

// États partagés de chaque page et de chaque liste (DESIGN.md, « Règles »).

export function LoadingState({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-9 w-56" />
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe de squelettes identiques
          <Skeleton key={i} className="h-(--poster-h) w-(--poster-w) shrink-0 rounded-poster" />
        ))}
      </div>
    </div>
  );
}

/** Squelette sur mesure annoncé aux lecteurs d'écran (rangées, grilles, fiche, résultats). */
export function Loading({
  label = 'Chargement…',
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

type EmptyStateProps = { title: string; description?: string; action?: ReactNode; className?: string };

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-card border border-dashed border-(--border-dashed) px-6 py-12 text-center',
        className,
      )}
    >
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-card border border-(--tint-danger-border) bg-(--tint-danger-bg) px-6 py-12 text-center"
    >
      <p className="text-base font-semibold text-(--text-danger)">{message}</p>
      <Button variant="secondary" onClick={onRetry}>
        <RotateCw data-icon="inline-start" />
        Réessayer
      </Button>
    </div>
  );
}
