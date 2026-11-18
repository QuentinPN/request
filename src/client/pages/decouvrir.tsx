import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Info } from 'lucide-react';
import { MediaRail, MediaRailSkeleton, Rail, RailSkeleton } from '@/components/media/rail';
import { StatusPill } from '@/components/media/status-pill';
import { Backdrop, MetaLine, RequestButton } from '@/components/media/title-parts';
import { WatchLink } from '@/components/media/watch-link';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { ActiveRequestsStrip } from '@/components/requests/active-requests';
import { Loading } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { discoverQuery, providersQuery, summaryMeta, titleLink } from '@/lib/catalogue';
import { type Brand, brandsOf } from '../../shared/brands.ts';
import { imageUrl, type MediaSummary, type MediaType, type WatchProvider } from '../../shared/media.ts';

/** Plateformes affichées : la liste TMDB pour la France est longue, les premières sont les plus regardées. */
const PROVIDER_COUNT = 10;

const heroHeight = 'h-[440px] lg:h-[min(700px,82vh)]';

function Hero({ media }: { media: MediaSummary }) {
  return (
    <section aria-label="À la une" className={`bleed relative ${heroHeight}`}>
      <Backdrop path={media.backdropPath} className="h-full" />
      <div className="absolute inset-x-(--space-page) bottom-6 flex flex-col gap-3 lg:bottom-[150px] lg:max-w-[560px] lg:gap-4">
        <p className="text-xs font-semibold text-(--accent-text) lg:text-sm">N° 1 des tendances cette semaine</p>
        <h2 className="text-[2rem] leading-none font-extrabold tracking-[-0.03em] text-balance lg:text-[clamp(3rem,5vw,4.5rem)] lg:leading-[0.98]">
          {media.title}
        </h2>
        <MetaLine parts={summaryMeta(media)} />
        {media.status && <StatusPill status={media.status} className="self-start" />}
        {media.overview && <p className="hidden text-[17px] text-muted-foreground sm:line-clamp-3">{media.overview}</p>}
        <div className="mt-2 flex flex-wrap gap-3">
          <RequestButton media={media} className="grow sm:grow-0" />
          <WatchLink media={media} className="grow sm:grow-0" />
          <Link
            {...titleLink(media)}
            className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'border-input' })}
          >
            <Info data-icon="inline-start" />
            Plus d’infos
          </Link>
        </div>
      </div>
    </section>
  );
}

/** Carte d'une rangée à logos (plateformes, studios, chaînes). */
const logoCard =
  'flex h-24 w-[200px] shrink-0 items-center justify-center gap-3 rounded-card border border-border bg-card px-4 text-[17px] font-bold transition-[transform,box-shadow] duration-(--dur) ease-request outline-none hover:scale-(--focus-scale) hover:shadow-(--shadow-lift) focus-visible:scale-(--focus-scale) focus-visible:ring-3 focus-visible:ring-ring max-lg:h-20 max-lg:w-40 max-lg:text-[15px]';

function ProviderCard({ provider }: { provider: WatchProvider }) {
  const logo = imageUrl(provider.logoPath, 'profile');
  return (
    <Link to="/plateforme/$type/$id" params={{ type: 'movie', id: String(provider.id) }} className={logoCard}>
      {logo && <img src={logo} alt="" width={40} height={40} loading="lazy" className="size-10 rounded-[10px]" />}
      <span className="line-clamp-2">{provider.name}</span>
    </Link>
  );
}

/** Logo d'un studio ou d'une chaîne, en aplat (les logos TMDB sont de couleurs variées) ; mène aux Films ou Séries filtrés. */
function BrandCard({ type, brand }: { type: MediaType; brand: Brand }) {
  const logo = (
    <img
      src={imageUrl(brand.logoPath, 'profile') ?? ''}
      alt={brand.name}
      width={140}
      height={40}
      loading="lazy"
      className="max-h-10 max-w-[140px] object-contain brightness-0 dark:invert"
    />
  );
  return type === 'movie' ? (
    <Link to="/films" search={{ company: brand.id }} className={logoCard}>
      {logo}
    </Link>
  ) : (
    <Link to="/series" search={{ network: brand.id }} className={logoCard}>
      {logo}
    </Link>
  );
}

const brandTitle: Record<MediaType, string> = { movie: 'Par studio', tv: 'Par chaîne' };

function Brands({ type }: { type: MediaType }) {
  return (
    <Rail title={brandTitle[type]}>
      {brandsOf[type].map((brand) => (
        <BrandCard key={brand.id} type={type} brand={brand} />
      ))}
    </Rail>
  );
}

const providerSkeleton = <Skeleton className="h-20 w-40 shrink-0 rounded-card lg:h-24 lg:w-[200px]" />;

function Providers() {
  const query = useQuery(providersQuery('movie'));
  // Rangée secondaire : en erreur ou vide, elle s'efface plutôt que de doubler l'état de la page.
  if (query.isPending) return <RailSkeleton item={providerSkeleton} count={6} />;
  const providers = query.data?.providers.slice(0, PROVIDER_COUNT) ?? [];
  if (providers.length === 0) return null;
  return (
    <Rail title="Par plateforme">
      {providers.map((provider) => (
        <ProviderCard key={provider.id} provider={provider} />
      ))}
    </Rail>
  );
}

function DiscoverSkeleton() {
  return (
    <Loading>
      <div className={`bleed ${heroHeight} relative`}>
        <Skeleton className="size-full rounded-none" />
      </div>
      <div className="relative mt-5 space-y-8 lg:-mt-[60px] lg:space-y-11">
        <MediaRailSkeleton />
        <MediaRailSkeleton />
      </div>
    </Loading>
  );
}

export function DecouvrirPage() {
  const query = useQuery(discoverQuery());
  const loaded = query.data !== undefined;
  return (
    <Page title="Découvrir" hideTitle={loaded || query.isPending}>
      <QueryState
        query={query}
        skeleton={<DiscoverSkeleton />}
        errorMessage="Les rangées de Découvrir n’ont pas pu se charger."
        empty={{ title: 'Rien à découvrir pour l’instant', description: 'TMDB n’a renvoyé aucune rangée.' }}
        isEmpty={(data) => data.rows.every((row) => row.items.length === 0)}
      >
        {({ rows }) => {
          // Le hero n'existe que si la rangée Tendances est là : son libellé « N° 1 » doit rester vrai.
          const hero = rows.find((row) => row.id === 'trending')?.items[0];
          return (
            <div>
              {hero && <Hero media={hero} />}
              <div className={cn('relative space-y-8 lg:space-y-11', hero && 'mt-5 lg:-mt-[60px]')}>
                <ActiveRequestsStrip />
                {rows.map((row) => (
                  <MediaRail key={row.id} title={row.title} items={row.items} />
                ))}
                <Providers />
                <Brands type="movie" />
                <Brands type="tv" />
              </div>
            </div>
          );
        }}
      </QueryState>
    </Page>
  );
}
