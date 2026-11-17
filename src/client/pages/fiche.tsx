import { useQuery } from '@tanstack/react-query';
import { useCanGoBack, useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { cn } from 'cn';
import { ChevronLeft, Film, Play, User, X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { MediaRail, Rail, SectionHeading } from '@/components/media/rail';
import { DownloadBar, StatusPill } from '@/components/media/status-pill';
import { Backdrop, GlassPill, MetaLine, RequestButton } from '@/components/media/title-parts';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { RequestTracking } from '@/components/requests/request-timeline';
import { roundButton } from '@/components/shell/nav-items';
import { Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { detailsMeta, mediaQuery, regularSeasons, seasonMeta, seasonTitle } from '@/lib/catalogue';
import { typeIdParamsSchema } from '../../shared/catalogue.ts';
import {
  type CastMember,
  imageUrl,
  type MediaDetails,
  type MediaType,
  type WatchProvider,
} from '../../shared/media.ts';
import { IntrouvablePage } from './introuvable.tsx';

function BackButton() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Retour"
      className={roundButton}
      onClick={() => (canGoBack ? router.history.back() : void navigate({ to: '/' }))}
    >
      <ChevronLeft aria-hidden className="size-5" />
    </button>
  );
}

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

function CastCard({ person }: { person: CastMember }) {
  const src = imageUrl(person.profilePath, 'profile');
  return (
    <figure className="w-24 shrink-0 text-center lg:w-32">
      <div className="mx-auto grid size-20 place-items-center overflow-hidden rounded-full bg-muted ring-1 ring-border lg:size-28">
        {src ? (
          <img src={src} alt="" width={185} height={278} loading="lazy" className="size-full object-cover" />
        ) : (
          <User aria-hidden className="size-8 text-muted-foreground" strokeWidth={1.5} />
        )}
      </div>
      <figcaption className="mt-2">
        <span className="line-clamp-2 block text-[13px] font-semibold">{person.name}</span>
        {person.character && (
          <span className="line-clamp-2 block text-xs text-muted-foreground">{person.character}</span>
        )}
      </figcaption>
    </figure>
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
              {season.status && <StatusPill status={season.status} className="shrink-0" />}
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
        {media.status && <StatusPill status={media.status} />}
        {media.overview && <p className="text-muted-foreground lg:text-[17px]">{media.overview}</p>}
        <div className="flex flex-wrap gap-3 pt-2">
          <RequestButton media={media} className="grow sm:grow-0" />
          {isYoutubeKey(media.trailerKey) && <TrailerButton title={media.title} trailerKey={media.trailerKey} />}
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
        {media.cast.length > 0 && (
          <Rail title="Distribution" focusable>
            {media.cast.map((person) => (
              <CastCard key={`${person.id}:${person.character}`} person={person} />
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
