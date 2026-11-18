import type { UseQueryResult } from '@tanstack/react-query';
import { cn } from 'cn';
import type { ReactNode } from 'react';
import { ErrorState, Loading } from '@/components/states';
import { Skeleton } from '@/components/ui/skeleton';
import { type SectionId, sectionText, settingsSectionOrder } from './config';

export type SectionStatus = 'done' | 'todo' | 'active' | 'error';

// Pastille et numéro de la maquette R-Assistant : vert testé, gris à faire, beige en cours, rouge en erreur.
const statusStyle: Record<SectionStatus, { label: string; dot: string; number: string }> = {
  done: { label: 'Testé', dot: 'bg-ok', number: 'bg-(--tint-ok-bg) text-(--text-ok)' },
  todo: { label: 'À faire', dot: 'bg-unknown', number: 'bg-(--surface-2) text-muted-foreground' },
  active: { label: 'En cours', dot: 'bg-brand', number: 'bg-(--tint-accent-bg) text-foreground' },
  error: { label: 'Erreur', dot: 'bg-danger', number: 'bg-(--tint-danger-bg) text-(--text-danger)' },
};

/** Statut d'une section : erreur et test en cours priment, puis enregistrée, puis ouverte. */
export function sectionStatus({
  saved,
  open,
  failed,
  testing,
}: {
  saved: boolean;
  open: boolean;
  failed: boolean;
  testing: boolean;
}): SectionStatus {
  if (failed) return 'error';
  if (testing) return 'active';
  if (saved) return 'done';
  return open ? 'active' : 'todo';
}

export type SectionFrameProps<S extends SectionId = SectionId> = {
  section: S;
  open: boolean;
  onToggle: () => void;
  /** Section inaccessible pour l'instant (amorçage : serveur multimédia seul tant qu'aucun propriétaire n'existe). */
  disabled?: boolean;
  /** Libellé de « Testé » pour une section sans test (règles). */
  doneLabel?: string;
  /** Libellé de « À faire » pour une section facultative (Seerr, Discord : « Désactivé »). */
  todoLabel?: string;
  /** Numéro affiché, à la place du rang dans les réglages (section seule sur la page d'un gestionnaire). */
  number?: number;
};

/** Élément d'accordéon de l'assistant et des réglages : en-tête numéroté, pastille de statut, contenu replié. */
export function SectionFrame({
  section,
  open,
  onToggle,
  disabled = false,
  doneLabel,
  todoLabel,
  number,
  status,
  children,
}: SectionFrameProps & { status: SectionStatus; children: ReactNode }) {
  const { title, description } = sectionText[section];
  const style = statusStyle[status];
  const headerId = `section-${section}`;
  const panelId = `${headerId}-contenu`;
  const statusLabel = (status === 'done' && doneLabel) || (status === 'todo' && todoLabel) || style.label;
  return (
    <div
      className={cn(
        'rounded-poster border bg-card transition-colors duration-(--dur)',
        open ? 'border-ring' : 'border-border',
        disabled && 'opacity-60',
      )}
    >
      <h2>
        <button
          type="button"
          id={headerId}
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={`${headerId}-description`}
          disabled={disabled}
          onClick={onToggle}
          className="flex w-full items-center gap-4 rounded-poster px-4 py-4 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed sm:px-[22px] sm:py-[18px]"
        >
          <span
            aria-hidden
            className={cn('grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-bold', style.number)}
          >
            {number ?? settingsSectionOrder.indexOf(section) + 1}
          </span>
          <span className="flex min-w-0 grow flex-col gap-0.5">
            <span className="font-semibold">{title}</span>
            <span id={`${headerId}-description`} className="hidden text-xs text-muted-foreground sm:block">
              {description}
            </span>
          </span>
          <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-pill bg-(--surface-2) pr-2.5 pl-2 text-xs font-semibold whitespace-nowrap">
            <span aria-hidden className={cn('size-2 rounded-full', style.dot)} />
            {statusLabel}
          </span>
        </button>
      </h2>
      <section
        id={panelId}
        aria-labelledby={headerId}
        hidden={!open}
        className="px-4 pb-5 sm:pr-[22px] sm:pb-[22px] sm:pl-[66px]"
      >
        {children}
      </section>
    </div>
  );
}

/** Section dont la lecture a échoué : message et « Réessayer ». */
export function SectionLoadError({
  query,
  message,
  ...frame
}: SectionFrameProps & { query: Pick<UseQueryResult, 'refetch'>; message: string }) {
  return (
    <SectionFrame {...frame} status="error">
      <ErrorState message={message} onRetry={() => void query.refetch()} />
    </SectionFrame>
  );
}

/** Section qui lit ses données : squelette (`rows` lignes), erreur à réessayer, puis le contenu. */
export function LoadedSection<T>({
  query,
  rows = 2,
  errorMessage = 'Ces réglages n’ont pas pu se charger.',
  children,
  ...frame
}: SectionFrameProps & {
  query: UseQueryResult<T>;
  rows?: number;
  errorMessage?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending)
    return (
      <SectionFrame {...frame} status="todo">
        <Loading className="space-y-4">
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe de squelettes identiques
            <Skeleton key={i} className="h-12 w-full rounded-(--r-button)" />
          ))}
        </Loading>
      </SectionFrame>
    );
  if (query.isError) return <SectionLoadError {...frame} query={query} message={errorMessage} />;
  return children(query.data);
}

/** Boutons d'une section : à droite sur ordinateur, pleine largeur et empilés sur mobile. */
export function SectionActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}

export const actionClass = 'text-[15px]';
