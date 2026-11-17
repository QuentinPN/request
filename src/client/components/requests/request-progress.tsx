import { cn } from 'cn';
import { Film } from 'lucide-react';
import { imageUrl } from '../../../shared/media.ts';
import { type RequestProgress, requestSteps, type StepState } from '../../lib/requests.ts';
import { StatusPill } from '../media/status-pill.tsx';

const segment: Record<StepState, string> = {
  done: 'bg-ok',
  current: 'bg-brand',
  failed: 'bg-danger',
  todo: 'bg-(--track)',
};

const stateText: Record<StepState, string> = {
  done: 'fait',
  current: 'en cours',
  failed: 'en échec',
  todo: 'à venir',
};

/**
 * Barre en quatre étapes (Demandé, Approuvé, Téléchargé, Dans Emby) : une liste lue étape par étape aux lecteurs
 * d'écran. L'étape « Téléchargé » en cours se remplit selon l'avancement. `labels` : noms visibles sous la barre sur ordinateur.
 */
export function RequestStepBar({
  progress,
  labels = false,
  className,
}: {
  progress: RequestProgress;
  labels?: boolean;
  className?: string;
}) {
  return (
    <ol aria-label="Progression de la demande" className={cn('grid grid-cols-4 gap-1', className)}>
      {requestSteps.map((name, i) => {
        const state = progress.steps[i] ?? 'todo';
        const partial = state === 'current' && i === 2 && progress.percent !== undefined;
        return (
          <li key={name} className="relative min-w-0">
            <span
              aria-hidden
              className={cn('block h-1 overflow-hidden rounded-full', segment[partial ? 'todo' : state])}
            >
              {partial && <span className="block h-full bg-brand" style={{ width: `${progress.percent}%` }} />}
            </span>
            <span className={labels ? 'mt-1.5 block truncate text-xs text-muted-foreground max-lg:sr-only' : 'sr-only'}>
              {name}
              <span className="sr-only">
                {' '}
                : {stateText[state]}
                {partial && `, ${progress.percent} %`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function RequestStatusPill({ progress, className }: { progress: RequestProgress; className?: string }) {
  return <StatusPill status={progress.tone} label={progress.label} className={className} />;
}

/** Petite affiche décorative (feuille de demande, liste, cartes). */
export function RequestThumb({ posterPath, className }: { posterPath: string | null | undefined; className?: string }) {
  const src = imageUrl(posterPath, 'poster');
  return (
    <div
      className={cn(
        'relative aspect-2/3 shrink-0 overflow-hidden rounded-[10px] bg-(--media-base) ring-1 ring-border',
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" width={342} height={513} className="size-full object-cover" />
      ) : (
        <Film aria-hidden className="absolute inset-0 m-auto size-5 text-(--on-media-2)/40" strokeWidth={1.5} />
      )}
    </div>
  );
}
