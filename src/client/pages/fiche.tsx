import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { cn } from 'cn';
import { ChevronRight, Film, Play, User, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { BackButton } from '@/components/back-button';
import { ReportIssueButton } from '@/components/issues/report-sheet';
import { BlockedPill, BlockTitleButton } from '@/components/media/block-button';
import { MediaRail, Rail, SectionHeading } from '@/components/media/rail';
import { DownloadBar, FourKPill, StatusPill } from '@/components/media/status-pill';
import {
  Backdrop,
  GlassPill,
  MetaLine,
  Request4kButton,
  RequestButton,
  WatchlistButton,
} from '@/components/media/title-parts';
import { WatchLink } from '@/components/media/watch-link';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { RequestTracking } from '@/components/requests/request-timeline';
import { roundButton } from '@/components/shell/nav-items';
import { Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  collectionLink,
  crewJobLabel,
  detailsMeta,
  episodesLabel,
  mediaQuery,
  personLink,
  regularSeasons,
  seasonMeta,
  seasonTitle,
} from '@/lib/catalogue';
import { typeIdParamsSchema } from '../../shared/catalogue.ts';
import {
  type CastMember,
  type CollectionRef,
  imageUrl,
  type MediaDetails,
  type MediaType,
  type WatchProvider,
} from '../../shared/media.ts';
import { IntrouvablePage } from './introuvable.tsx';

const posterBox = 'hidden w-[200px] shrink-0 md:block lg:w-[260px]';

/** Gabarit de la fiche (maquette R-Fiche) : fond sur ~70 % de l'écran, retour, affiche et titre posés sur le bas du fond. */
function FicheFrame({ backdrop, poster, children }: { backdrop?: ReactNode; poster: ReactNode; children: ReactNode }) {
  return (
    <div className="bleed relative">
      {backdrop}
      <div className="relative px-(--space-page) pt-(--main-pt)">
        <BackButton />
        <div className="mt-16 flex items-end gap-8 sm:mt-28 lg:mt-32">
          <div className={posterBox}>{poster}</div>
          <div className="min-w-0 max-w-[640px] flex-1 space-y-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

const backdropHeight = 'h-[300px] sm:h-[420px] lg:h-[min(735px,80vh)]';

function FicheSkeleton() {
  return (
    <Loading>
      <FicheFrame
        backdrop={<Skeleton aria-hidden className={`absolute inset-x-0 top-0 rounded-none ${backdropHeight}`} />}
        poster={<Skeleton aria-hidden className="aspect-2/3 rounded-card" />}
      >
        <div aria-hidden className="space-y-4">
          <Skeleton className="h-[30px] w-48 rounded-pill" />
          <Skeleton className="h-12 w-3/4 lg:h-16" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-12 w-40 rounded-pill" />
        </div>
      </FicheFrame>
    </Loading>
  );
}

/** Clé de vidéo YouTube (11 caractères) : rien d'autre n'entre dans l'adresse du lecteur. */
const isYoutubeKey = (key: string | null): key is string => !!key && /^[\w-]{11}$/.test(key);

function TrailerButton({ title, trailerKey }: { title: string; trailerKey: string }) {
  // Le focus va sur « Fermer », pas dans le lecteur : une iframe garderait Échap pour elle.
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" size="lg" className="border-input" />}>
        <Play data-icon="inline-start" />
        Bande-annonce
      </DialogTrigger>
      <DialogContent initialFocus={closeRef} showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">Bande-annonce de {title}</DialogTitle>
        <DialogClose ref={closeRef} aria-label="Fermer" className={cn(roundButton, 'absolute top-3 right-3 z-10')}>
          <X aria-hidden className="size-5" />
        </DialogClose>
        <iframe
          className="aspect-video w-full"
          src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&rel=0`}
          title={`Bande-annonce de ${title}`}
          allow="autoplay; encrypted-media"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </DialogContent>
    </Dialog>
  );
}

/** Carte d'une personne (distribution, équipe) : mène à sa page ; `detail` = personnage ou métier. */
function PersonCard({ person, detail }: { person: Pick<CastMember, 'id' | 'name' | 'profilePath'>; detail: string }) {
  const src = imageUrl(person.profilePath, 'profile');
  return (
    <Link
      {...personLink(person)}
      className="block w-24 shrink-0 rounded-card text-center outline-none focus-visible:ring-3 focus-visible:ring-ring lg:w-32"
    >
      <figure>
        <div className="mx-auto grid size-20 place-items-center overflow-hidden rounded-full bg-muted ring-1 ring-border lg:size-28">
          {src ? (
            <img src={src} alt="" width={185} height={278} loading="lazy" className="size-full object-cover" />
          ) : (
            <User aria-hidden className="size-8 text-muted-foreground" strokeWidth={1.5} />
          )}
        </div>
        <figcaption className="mt-2">
          <span className="line-clamp-2 block text-[13px] font-semibold">{person.name}</span>
          {detail && <span className="line-clamp-2 block text-xs text-muted-foreground">{detail}</span>}
        </figcaption>
      </figure>
    </Link>
  );
}

/** « Fait partie de la saga X » : mène à la page de la saga. */
function CollectionCard({ collection }: { collection: CollectionRef }) {
  const poster = imageUrl(collection.posterPath, 'profile');
  return (
    <Link
      {...collectionLink(collection)}
      className="flex items-center gap-4 rounded-card border border-border bg-card p-4 outline-none transition-colors duration-(--dur) hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="grid h-[72px] w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-(--media-base)"
      >
        {poster ? (
          <img src={poster} alt="" width={185} height={278} loading="lazy" className="size-full object-cover" />
        ) : (
          <Film className="size-5 text-(--on-media-2)/40" strokeWidth={1.5} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-muted-foreground">Fait partie de la saga</span>
        <span className="block font-semibold">{collection.name}</span>
      </span>
      <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

const providerGroups = [
  ['flatrate', 'Abonnement'],
  ['rent', 'Location'],
  ['buy', 'Achat'],
] as const;

function ProviderChip({ provider }: { provider: WatchProvider }) {
  const logo = imageUrl(provider.logoPath, 'profile');
  return (
    <li className="inline-flex h-10 items-center gap-2 rounded-pill border border-border bg-card pr-3.5 pl-1.5 text-sm">
      {logo ? (
        <img src={logo} alt="" width={28} height={28} loading="lazy" className="size-7 rounded-full" />
      ) : (
        <span aria-hidden className="size-7 rounded-full bg-muted" />
      )}
      {provider.name}
    </li>
  );
}

function WhereToWatch({ providers }: { providers: MediaDetails['watchProviders'] }) {
  const groups = providerGroups.filter(([key]) => providers[key].length > 0);
  return (
    <section aria-labelledby="ou-regarder">
      <SectionHeading id="ou-regarder">Où regarder</SectionHeading>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Ce titre n’est proposé par aucune plateforme en France pour l’instant.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(([key, label]) => (
            <div key={key} className="space-y-2">
              <h3 className="text-[13px] font-semibold text-muted-foreground">{label}</h3>
              <ul className="flex flex-wrap gap-2">
                {providers[key].map((provider) => (
                  <ProviderChip key={provider.id} provider={provider} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Seasons({ media }: { media: MediaDetails }) {
  if (media.seasons.length === 0) return null;
  const episodes = regularSeasons(media.seasons).reduce((sum, s) => sum + s.episodeCount, 0);
  return (
    <section aria-labelledby="saisons" className="min-w-0 flex-1">
      <SectionHeading
        id="saisons"
        aside={episodes > 0 && <span className="text-[13px] text-muted-foreground">{episodes} épisodes au total</span>}
      >
        Saisons
      </SectionHeading>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {media.seasons.map((season) => (
          <li key={season.seasonNumber} className="space-y-3 rounded-card border border-border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block font-semibold">{seasonTitle(season)}</span>
                <span className="block text-[13px] text-muted-foreground">{seasonMeta(season)}</span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {season.status && <StatusPill status={season.status} />}
                {season.episodes && (
                  <span className="text-[13px] text-muted-foreground tabular-nums">
                    {episodesLabel(season.episodes)}
                  </span>
                )}
                {season.fourK?.status && <FourKPill status={season.fourK.status} />}
              </div>
            </div>
            <DownloadBar
              status={season.status}
              progress={season.progress}
              label={`Téléchargement de ${seasonTitle(season)}`}
              className="rounded-pill"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Fiche({ media }: { media: MediaDetails }) {
  const poster = imageUrl(media.posterPath, 'poster');
  const crew = media.crew ?? [];
  return (
    <article>
      <FicheFrame
        backdrop={<Backdrop path={media.backdropPath} className={backdropHeight} />}
        poster={
          <div className="relative aspect-2/3 overflow-hidden rounded-card bg-(--media-base) shadow-(--shadow-card) ring-1 ring-border">
            {poster ? (
              <img
                src={poster}
                alt={`Affiche de ${media.title}`}
                width={342}
                height={513}
                className="size-full object-cover"
              />
            ) : (
              <Film aria-hidden className="absolute inset-0 m-auto size-10 text-(--on-media-2)/40" strokeWidth={1.5} />
            )}
          </div>
        }
      >
        {media.genres.length > 0 && (
          <ul aria-label="Genres" className="flex flex-wrap gap-2">
            {media.genres.map((genre) => (
              <li key={genre.id}>
                <GlassPill>{genre.name}</GlassPill>
              </li>
            ))}
          </ul>
        )}
        <h1 className="text-[2rem] leading-none font-extrabold tracking-[-0.03em] text-balance lg:text-[clamp(3rem,4.5vw,4rem)]">
          {media.title}
        </h1>
        <MetaLine parts={detailsMeta(media)} />
        {(media.status || media.fourK?.status || media.blocked) && (
          <div className="flex flex-wrap gap-2">
            {media.blocked && <BlockedPill block={media.blocked} />}
            {media.status && <StatusPill status={media.status} />}
            {media.fourK?.status && <FourKPill status={media.fourK.status} />}
          </div>
        )}
        {media.overview && <p className="text-muted-foreground lg:text-[17px]">{media.overview}</p>}
        <div className="flex flex-wrap gap-3 pt-2">
          <RequestButton media={media} className="grow sm:grow-0" />
          <Request4kButton media={media} className="grow sm:grow-0" />
          <WatchLink media={media} className="grow sm:grow-0" />
          <WatchlistButton media={media} className="grow sm:grow-0" />
          {isYoutubeKey(media.trailerKey) && <TrailerButton title={media.title} trailerKey={media.trailerKey} />}
          <ReportIssueButton media={media} className="grow sm:grow-0" />
          <BlockTitleButton media={media} className="grow sm:grow-0" />
        </div>
      </FicheFrame>

      <div className="mt-12 space-y-10 lg:mt-16 lg:space-y-12">
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-6">
          <Seasons media={media} />
          <div className={cn('space-y-10', media.seasons.length > 0 && 'lg:w-[420px] lg:shrink-0')}>
            <RequestTracking media={media} />
            <WhereToWatch providers={media.watchProviders} />
          </div>
        </div>
        {media.collection && <CollectionCard collection={media.collection} />}
        {media.cast.length > 0 && (
          <Rail title="Distribution">
            {media.cast.map((person) => (
              <PersonCard key={`${person.id}:${person.character}`} person={person} detail={person.character} />
            ))}
          </Rail>
        )}
        {crew.length > 0 && (
          <Rail title="Équipe">
            {crew.map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                detail={person.jobs.map((job) => crewJobLabel[job]).join(', ')}
              />
            ))}
          </Rail>
        )}
        <MediaRail title="Recommandations" items={media.recommendations} />
        <MediaRail title="Titres similaires" items={media.similar} />
      </div>
    </article>
  );
}

function TitleDetails({ type, id }: { type: MediaType; id: number }) {
  const query = useQuery(mediaQuery(type, id));
  if (query.data) return <Fiche media={query.data} />;
  if (query.isPending) return <FicheSkeleton />;
  return (
    <div className="space-y-6">
      <BackButton />
      <Page title="Fiche titre">
        <QueryState
          query={query}
          skeleton={null}
          errorMessage="Cette fiche n’a pas pu se charger."
          notFound={{ title: 'Titre introuvable', description: 'TMDB ne connaît pas ce titre, ou il a été retiré.' }}
        >
          {() => null}
        </QueryState>
      </Page>
    </div>
  );
}

/** Fiche d'un film ou d'une série : `/titre/movie/603`, `/titre/tv/1399`. */
export function FichePage() {
  const params = typeIdParamsSchema.safeParse(useParams({ strict: false }));
  if (!params.success) return <IntrouvablePage />;
  return <TitleDetails key={`${params.data.type}:${params.data.id}`} type={params.data.type} id={params.data.id} />;
}
