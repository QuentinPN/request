import { cn } from 'cn';
import {
  type Availability,
  type MediaStatus,
  mediaStatusLabel,
  mediaStatusShortLabel,
} from '../../../shared/status.ts';
import { downloadPercent } from '../../lib/status.ts';

const dot: Record<MediaStatus, string> = {
  available: 'bg-ok',
  partial: 'bg-warn',
  downloading: 'bg-downloading',
  requested: 'bg-brand',
  pending: 'bg-unknown',
  declined: 'bg-danger',
};

/** Libellé court : le pourcentage quand la progression est connue (« 42 % »). */
const shortLabel = (status: MediaStatus, progress: Availability['progress']) => {
  const percent = downloadPercent({ status, progress });
  return percent === undefined ? mediaStatusShortLabel[status] : `${percent} %`;
};

/** Pastille de statut. `onMedia` : posée sur une image (verre sombre identique dans les deux thèmes, libellé court). */
export function StatusPill({
  status,
  onMedia = false,
  progress,
  className,
}: {
  status: MediaStatus;
  onMedia?: boolean;
  progress?: Availability['progress'];
  className?: string;
}) {
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-pill px-2.5 text-xs font-medium whitespace-nowrap',
        onMedia
          ? 'bg-(--media-chip) text-(--on-media) [backdrop-filter:var(--blur)]'
          : 'bg-secondary text-foreground ring-1 ring-border',
        className,
      )}
    >
      <span aria-hidden className={cn('size-2 rounded-full', dot[status])} />
      {onMedia ? shortLabel(status, progress) : mediaStatusLabel[status]}
    </span>
  );
}

/**
 * Barre de progression du téléchargement (rien sans statut `downloading` ni progression) ; `className` la place
 * (bas d'une affiche, carte de saison). `label` nomme la barre pour les lecteurs d'écran.
 */
export function DownloadBar({
  label,
  className,
  ...availability
}: Availability & { label: string; className?: string }) {
  const percent = downloadPercent(availability);
  if (percent === undefined) return null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent} %`}
      className={cn('h-1 overflow-hidden bg-(--track)', className)}
    >
      <div className="h-full bg-brand" style={{ width: `${percent}%` }} />
    </div>
  );
}
