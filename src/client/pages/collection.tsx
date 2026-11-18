import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { BackButton, homeBack } from '@/components/back-button';
import { PosterGridSkeleton, PosterList } from '@/components/media/poster-grid';
import { Backdrop, MetaLine } from '@/components/media/title-parts';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { useRequestAction } from '@/components/requests/request-sheet';
import { Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { collectionQuery } from '@/lib/catalogue';
import { idParamsSchema } from '../../shared/catalogue.ts';
import type { CollectionDetails, MediaSummary } from '../../shared/media.ts';
import { isoDay, isRequestable } from '../../shared/requests.ts';
import { plural } from '../../shared/text.ts';
import { IntrouvablePage } from './introuvable.tsx';

const backdropHeight = 'h-[260px] sm:h-[340px] lg:h-[420px]';

const isMissing = (film: MediaSummary) => !film.blocked && isRequestable(film, isoDay());

/**
 * « Demander le prochain film manquant » : ouvre la feuille de demande habituelle (quotas, blocages et droits vérifiés par le
 * serveur comme partout) pour le premier film encore demandable ; une fois envoyée, le bouton propose le suivant.
 */
function RequestMissingButton({ parts }: { parts: MediaSummary[] }) {
  const missing = parts.filter(isMissing);
  const onRequest = useRequestAction(missing[0]);
  if (!onRequest) return null;
  return (
    <Button size="lg" onClick={onRequest}>
      <Plus data-icon="inline-start" />
      Demander le prochain film manquant
      <span className="font-normal opacity-80">· {missing.length} manquants</span>
    </Button>
  );
}

function CollectionFrame({ backdrop, children }: { backdrop?: string | null; children: ReactNode }) {
  return (
    <div className="bleed relative">
      <Backdrop path={backdrop ?? null} className={backdropHeight} />
      <div className="relative px-(--space-page) pt-(--main-pt)">
        <BackButton />
        <div className="mt-16 max-w-[640px] space-y-4 sm:mt-28">{children}</div>
      </div>
    </div>
  );
}

function CollectionView({ collection }: { collection: CollectionDetails }) {
  const available = collection.parts.filter((film) => film.status === 'available').length;
  return (
    <article>
      <CollectionFrame backdrop={collection.backdropPath}>
        <h1 className="text-[2rem] leading-none font-extrabold tracking-[-0.03em] text-balance lg:text-[clamp(3rem,4.5vw,4rem)]">
          {collection.name}
        </h1>
        <MetaLine
          parts={[plural(collection.parts.length, 'film', 'films'), plural(available, 'disponible', 'disponibles')]}
        />
        {collection.overview && <p className="text-muted-foreground lg:text-[17px]">{collection.overview}</p>}
        <div className="flex flex-wrap gap-3 pt-2">
          <RequestMissingButton parts={collection.parts} />
        </div>
      </CollectionFrame>
      <div className="mt-12 lg:mt-16">
        <PosterList items={collection.parts} />
      </div>
    </article>
  );
}

function CollectionSkeleton() {
  return (
    <Loading>
      <CollectionFrame>
        <div aria-hidden className="space-y-4">
          <Skeleton className="h-12 w-3/4 lg:h-16" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-12 w-64 rounded-pill" />
        </div>
      </CollectionFrame>
      <div className="mt-12 lg:mt-16">
        <PosterGridSkeleton count={6} />
      </div>
    </Loading>
  );
}

function CollectionDetailsView({ id }: { id: number }) {
  const query = useQuery(collectionQuery(id));
  if (query.data) return <CollectionView collection={query.data} />;
  if (query.isPending) return <CollectionSkeleton />;
  return (
    <Page title="Saga" back={homeBack}>
      <QueryState
        query={query}
        skeleton={null}
        errorMessage="Cette saga n’a pas pu se charger."
        notFound={{
          title: 'Saga introuvable',
          description: 'TMDB ne connaît pas cette saga.',
        }}
      >
        {() => null}
      </QueryState>
    </Page>
  );
}

/** Saga (collection TMDB) et ses films : `/collection/10`. */
export function CollectionPage() {
  const params = idParamsSchema.safeParse(useParams({ strict: false }));
  if (!params.success) return <IntrouvablePage />;
  return <CollectionDetailsView key={params.data.id} id={params.data.id} />;
}
