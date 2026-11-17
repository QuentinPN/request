import { cn } from 'cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MediaSummary } from '../../../shared/media.ts';
import { mediaKey } from '../../lib/catalogue.ts';
import { Button } from '../ui/button.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { MediaPoster, PosterSkeleton } from './poster.tsx';

/** Titre de section (« rowh » des maquettes) : seule définition, pour les rangées comme pour les blocs de la fiche. */
export function SectionHeading({ id, children, aside }: { id?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 id={id} className="text-lg font-bold tracking-tight lg:text-(length:--fs-h2)">
        {children}
      </h2>
      {aside}
    </div>
  );
}

function SectionHeadingSkeleton() {
  return <Skeleton className="mb-4 h-6 w-44 lg:h-7" />;
}

const scroller =
  '-mx-(--space-page) flex gap-3 overflow-x-auto px-(--space-page) pt-3 pb-6 [scrollbar-width:none] motion-safe:scroll-smooth lg:gap-5';

/**
 * Rangée horizontale : défilement au doigt, flèches à la souris (cachées au toucher), ← → entre les liens au clavier.
 * Une rangée sans lien (`focusable`) devient elle-même une zone focalisable pour défiler au clavier.
 */
export function Rail({
  title,
  children,
  focusable = false,
  className,
}: {
  title: string;
  children: ReactNode;
  focusable?: boolean;
  className?: string;
}) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const updateEdges = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft <= 1;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    // Même état : on rend l'objet précédent, React n'a rien à redessiner à chaque évènement de défilement.
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    updateEdges();
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateEdges]);

  const page = (direction: 1 | -1) => {
    const el = ref.current;
    el?.scrollBy({ left: direction * el.clientWidth * 0.8 });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const links = [...(ref.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    const next = links[index + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const arrow = 'hidden lg:inline-flex pointer-coarse:hidden';
  return (
    <section aria-labelledby={headingId} className={className}>
      <SectionHeading
        id={headingId}
        aside={
          !(edges.start && edges.end) && (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="icon-sm"
                className={arrow}
                tabIndex={-1}
                disabled={edges.start}
                onClick={() => page(-1)}
                aria-label={`${title} : précédents`}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                className={arrow}
                tabIndex={-1}
                disabled={edges.end}
                onClick={() => page(1)}
                aria-label={`${title} : suivants`}
              >
                <ChevronRight />
              </Button>
            </div>
          )
        }
      >
        {title}
      </SectionHeading>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: ← → délèguent le focus aux liens de la rangée */}
      <div
        ref={ref}
        onScroll={updateEdges}
        onKeyDown={onKeyDown}
        className={cn(scroller, focusable && 'rounded-card outline-none focus-visible:ring-3 focus-visible:ring-ring')}
        tabIndex={focusable ? 0 : undefined}
      >
        {children}
      </div>
    </section>
  );
}

/** Squelette d'une rangée : titre et éléments aux dimensions finales. */
export function RailSkeleton({ item, count = 8 }: { item: ReactNode; count?: number }) {
  return (
    <div aria-hidden>
      <SectionHeadingSkeleton />
      <div className={cn(scroller, 'overflow-hidden')}>
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: liste fixe de squelettes identiques
          <div key={i} className="contents">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Rangée d'affiches du catalogue (rien si la liste est vide : une rangée vide n'apporte rien). */
export function MediaRail({ title, items }: { title: string; items: MediaSummary[] }) {
  if (items.length === 0) return null;
  return (
    <Rail title={title}>
      {items.map((media) => (
        <MediaPoster key={mediaKey(media)} media={media} />
      ))}
    </Rail>
  );
}

export const MediaRailSkeleton = () => <RailSkeleton item={<PosterSkeleton />} />;
