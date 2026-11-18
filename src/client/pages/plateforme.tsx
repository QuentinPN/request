import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { homeBack } from '@/components/back-button';
import { PosterGrid } from '@/components/media/poster-grid';
import { ChipGroup, FilterChip } from '@/components/media/title-parts';
import { Page } from '@/components/page';
import { discoverListQuery, mediaTypeNone, mediaTypePlural, providersQuery } from '@/lib/catalogue';
import { typeIdParamsSchema } from '../../shared/catalogue.ts';
import { type MediaType, mediaTypeSchema } from '../../shared/media.ts';
import { IntrouvablePage } from './introuvable.tsx';

function ProviderListing({ type, id }: { type: MediaType; id: number }) {
  const navigate = useNavigate();
  const provider = useQuery(providersQuery(type)).data?.providers.find((p) => p.id === id);
  const listing = useInfiniteQuery(discoverListQuery('provider', type, id));

  return (
    <Page title={provider?.name ?? 'Plateforme'} back={homeBack}>
      <div className="space-y-8">
        <ChipGroup label="Type">
          {mediaTypeSchema.options.map((t) => (
            <FilterChip
              key={t}
              pressed={t === type}
              onClick={() =>
                void navigate({ to: '/plateforme/$type/$id', params: { type: t, id: String(id) }, replace: true })
              }
            >
              {mediaTypePlural[t]}
            </FilterChip>
          ))}
        </ChipGroup>
        <PosterGrid query={listing} empty={{ title: `${mediaTypeNone[type]} sur cette plateforme pour l’instant` }} />
      </div>
    </Page>
  );
}

/** Titres disponibles sur une plateforme de streaming (TMDB, France), par type. */
export function PlateformePage() {
  const params = typeIdParamsSchema.safeParse(useParams({ strict: false }));
  if (!params.success) return <IntrouvablePage />;
  return <ProviderListing type={params.data.type} id={params.data.id} />;
}
