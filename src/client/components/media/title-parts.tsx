import { cn } from 'cn';
import { Plus } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { imageUrl, type MediaSummary } from '../../../shared/media.ts';
import { useRequestAction } from '../requests/request-sheet.tsx';
import { Button } from '../ui/button.tsx';

// Pièces communes au hero de Découvrir et à la fiche titre (maquettes R-Decouvrir et R-Fiche).

/** Fond TMDB plein cadre avec ses voiles (gauche sur ordinateur, bas partout, haut sous l'en-tête mobile). */
export function Backdrop({ path, className }: { path: string | null; className?: string }) {
  const src = imageUrl(path, 'backdrop');
  return (
    <div aria-hidden className={cn('absolute inset-x-0 top-0 overflow-hidden bg-(--media-base)', className)}>
      {src && (
        <img
          src={src}
          alt=""
          width={1280}
          height={720}
          fetchPriority="high"
          className="size-full object-cover object-[center_20%]"
        />
      )}
      <div className="absolute inset-0 lg:veil-l" />
      <div className="absolute inset-0 veil-b" />
      <div className="absolute inset-x-0 top-0 h-24 veil-t lg:hidden" />
    </div>
  );
}

/** Année, type, durée… séparés par un point (« meta » des maquettes). */
export function MetaLine({ parts, className }: { parts: string[]; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground', className)}>
      {parts.map((part, i) => (
        <Fragment key={part}>
          {i > 0 && <span aria-hidden className="size-[3px] rounded-full bg-current" />}
          <span>{part}</span>
        </Fragment>
      ))}
    </p>
  );
}

/** Pilule de verre (genres de la fiche). */
export function GlassPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[30px] items-center rounded-pill border border-border bg-secondary px-3 text-[13px] [backdrop-filter:var(--blur)]">
      {children}
    </span>
  );
}

/** « Demander » du hero et de la fiche : ouvre la feuille de demande (rien si le titre n'est pas demandable). */
export function RequestButton({ media, className }: { media: MediaSummary; className?: string }) {
  const onRequest = useRequestAction(media);
  if (!onRequest) return null;
  return (
    <Button size="lg" onClick={onRequest} className={className}>
      <Plus data-icon="inline-start" />
      Demander
    </Button>
  );
}

/** Pilules défilantes au doigt sur mobile, sur plusieurs lignes sur ordinateur. */
export const chipRow =
  '-mx-(--space-page) flex gap-2 overflow-x-auto px-(--space-page) py-1 [scrollbar-width:none] lg:flex-wrap';

/** Groupe de filtres en pilules, nommé pour les lecteurs d'écran. */
export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    // min-w-0 : un fieldset garde sinon la largeur de ses pilules et déborde de l'écran au lieu de défiler.
    <fieldset className={cn(chipRow, 'min-w-0')}>
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

/** Filtre en pilule (« fp » des maquettes) : genres, type de média. */
export function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="inline-flex h-9 shrink-0 items-center rounded-pill border border-border bg-card px-3.5 text-sm font-medium whitespace-nowrap transition-colors duration-(--dur) outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring aria-pressed:border-transparent aria-pressed:bg-(--fill-selected) aria-pressed:text-(--text-inverse)"
    >
      {children}
    </button>
  );
}
