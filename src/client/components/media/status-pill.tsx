import { cn } from 'cn';
import { type MediaStatus, mediaStatusLabel, mediaStatusShortLabel } from '../../../shared/status.ts';

const dot: Record<MediaStatus, string> = {
  available: 'bg-ok',
  partial: 'bg-ok/50 ring-1 ring-ok',
  downloading: 'bg-warn',
  requested: 'bg-brand',
  pending: 'bg-unknown',
  declined: 'bg-danger',
};

/** Pastille de statut. `onMedia` : posée sur une image (verre sombre identique dans les deux thèmes, libellé court). */
export function StatusPill({
  status,
  onMedia = false,
  className,
}: {
  status: MediaStatus;
  onMedia?: boolean;
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
      <span aria-hidden className={cn('size-1.5 rounded-full', dot[status])} />
      {onMedia ? mediaStatusShortLabel[status] : mediaStatusLabel[status]}
    </span>
  );
}
