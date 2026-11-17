import { cn } from 'cn';
import { Plus } from 'lucide-react';
import { Fragment, type ReactNode, useId } from 'react';
import { imageUrl } from '../../../shared/media.ts';
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

/** « Demander » en attente du parcours de demande (tâche 4.1) : visible, désactivé, raison lue au lecteur d'écran. */
export function RequestButton({ className }: { className?: string }) {
  const reason = useId();
  return (
    <>
      <Button
        size="lg"
        disabled
        focusableWhenDisabled
        aria-describedby={reason}
        className={cn('aria-disabled:cursor-not-allowed aria-disabled:opacity-50', className)}
      >
        <Plus data-icon="inline-start" />
        Demander
      </Button>
      <span id={reason} className="sr-only">
        Disponible bientôt
      </span>
    </>
  );
}

/** Pilules défilantes au doigt sur mobile, sur plusieurs lignes sur ordinateur. */
export const chipRow =
  '-mx-(--space-page) flex gap-2 overflow-x-auto px-(--space-page) py-1 [scrollbar-width:none] lg:flex-wrap';

/** Groupe de filtres en pilules, nommé pour les lecteurs d'écran. */
export function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className={chipRow}>
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
