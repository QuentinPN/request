import { imageUrl } from '@shared/media.ts';
import { DECLINE_REASON_MAX, declineRequestSchema, type RequestView } from '@shared/requests.ts';
import { cn } from 'cn';
import { Film } from 'lucide-react';
import { useId } from 'react';
import { Avatar } from '@/components/shell/avatar';
import { FieldHint, Label, Textarea } from '@/components/ui/field';

/** Bouton « Approuver » vert des maquettes (request.css, .btn-ok). */
export const approveClass =
  'border-(--tint-ok-border) bg-(--tint-ok-bg) text-(--text-ok) hover:bg-(--tint-ok-bg-strong) font-semibold';

const thumbSize = { xs: 'w-9', sm: 'w-24', lg: 'w-40' } as const;

/** Affiche 2:3 (décorative : le titre est dit à côté). */
export function RequestPoster({
  media,
  size,
  className,
}: {
  media: RequestView['media'];
  size: keyof typeof thumbSize;
  className?: string;
}) {
  const src = imageUrl(media?.posterPath, 'poster');
  return (
    <div
      aria-hidden
      className={cn(
        'grid aspect-2/3 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-(--media-base) text-(--on-media-2)/40 ring-1 ring-border',
        thumbSize[size],
        className,
      )}
    >
      {src ? <img src={src} alt="" loading="lazy" className="size-full object-cover" /> : <Film className="size-5" />}
    </div>
  );
}

export function Requester({ person }: { person: RequestView['requester'] }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar viewer={person} className="size-7 text-[11px]" />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

/** Motif de refus validé par le schéma du serveur (une seule règle) ; `error` en français sinon. */
export function parseReason(
  value: string,
): { reason: string; error?: undefined } | { reason?: undefined; error: string } {
  const parsed = declineRequestSchema.safeParse({ reason: value });
  return parsed.success
    ? { reason: parsed.data.reason }
    : { error: parsed.error.issues[0]?.message ?? 'Motif invalide' };
}

/** Zone de saisie du motif, commune au panneau, à la feuille de refus et au refus groupé. */
export function ReasonField({
  value,
  onChange,
  error,
  hint,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>Motif si refus</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={DECLINE_REASON_MAX}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        placeholder={hint}
      />
      <FieldHint id={`${id}-hint`} className={cn(error && 'text-(--text-danger)')}>
        {error ?? 'Le motif est envoyé au membre.'}
      </FieldHint>
    </div>
  );
}
