import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { User } from 'lucide-react';
import { useState } from 'react';
import { homeBack } from '@/components/back-button';
import { PosterGridSkeleton, PosterList } from '@/components/media/poster-grid';
import { SectionHeading } from '@/components/media/rail';
import { ChipGroup, FilterChip } from '@/components/media/title-parts';
import { Page } from '@/components/page';
import { QueryState } from '@/components/query-state';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { creditRoleLabel, mediaTypePlural, personFacts, personQuery } from '@/lib/catalogue';
import { idParamsSchema } from '../../shared/catalogue.ts';
import { type Credit, type CreditRole, creditRoleSchema, imageUrl, type PersonDetails } from '../../shared/media.ts';
import { IntrouvablePage } from './introuvable.tsx';

function Portrait({ path, name }: { path: string | null; name: string }) {
  const src = imageUrl(path, 'poster');
  return (
    <div className="grid aspect-2/3 w-36 shrink-0 place-items-center overflow-hidden rounded-card bg-muted shadow-(--shadow-card) ring-1 ring-border sm:w-48">
      {src ? (
        <img src={src} alt={name} width={342} height={513} className="size-full object-cover" />
      ) : (
        <User aria-hidden className="size-12 text-muted-foreground" strokeWidth={1.5} />
      )}
    </div>
  );
}

function Biography({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Au-delà de ce seuil le texte est replié (≈ 6 lignes) : une biographie TMDB dépasse souvent 2 000 caractères.
  const long = text.length > 600;
  return (
    <div className="space-y-2">
      <p className={`whitespace-pre-line text-muted-foreground ${long && !expanded ? 'line-clamp-6' : ''}`}>{text}</p>
      {long && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Réduire' : 'Lire la suite'}
        </Button>
      )}
    </div>
  );
}

function PersonHeader({ person }: { person: PersonDetails }) {
  const facts = personFacts(person);
  // Mobile : la biographie passe sous la photo, sur toute la largeur ; ordinateur : à droite, sous les faits.
  return (
    <div className="grid grid-cols-[auto_1fr] content-start gap-x-5 gap-y-6 sm:gap-x-8">
      <div className="sm:row-span-2">
        <Portrait path={person.profilePath} name={person.name} />
      </div>
      {facts.length > 0 && (
        <dl className="grid min-w-0 max-w-[720px] content-start gap-x-8 gap-y-3 text-sm lg:grid-cols-2">
          {facts.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-[13px] text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {person.biography && (
        <div className="col-span-2 max-w-[720px] sm:col-span-1 sm:col-start-2">
          <Biography text={person.biography} />
        </div>
      )}
    </div>
  );
}

const sections = [
  { id: 'films', type: 'movie', key: 'movies' },
  { id: 'series', type: 'tv', key: 'shows' },
] as const;

function Filmography({ person }: { person: PersonDetails }) {
  const [role, setRole] = useState<CreditRole | null>(null);
  const all = [...person.movies, ...person.shows];
  // Le filtre n'a de sens que pour qui a joué et travaillé en coulisses.
  const roles = creditRoleSchema.options.filter((r) => all.some((credit) => credit.roles.includes(r)));
  const keep = (credits: Credit[]) => (role ? credits.filter((credit) => credit.roles.includes(role)) : credits);
  if (all.length === 0)
    return (
      <EmptyState
        title="Aucun film ni série connu"
        description="TMDB ne liste aucune filmographie pour cette personne."
      />
    );
  return (
    <div className="space-y-8">
      {roles.length > 1 && (
        <ChipGroup label="Rôle">
          <FilterChip pressed={role === null} onClick={() => setRole(null)}>
            Tous
          </FilterChip>
          {roles.map((r) => (
            <FilterChip key={r} pressed={role === r} onClick={() => setRole(r)}>
              {creditRoleLabel[r]}
            </FilterChip>
          ))}
        </ChipGroup>
      )}
      {sections.map(({ id, type, key }) => {
        const credits = keep(person[key]);
        if (credits.length === 0) return null;
        return (
          <section key={id} aria-labelledby={id}>
            <SectionHeading id={id} aside={<span className="text-[13px] text-muted-foreground">{credits.length}</span>}>
              {mediaTypePlural[type]}
            </SectionHeading>
            <PosterList items={credits} />
          </section>
        );
      })}
    </div>
  );
}

function PersonSkeleton() {
  return (
    <div aria-hidden className="space-y-8">
      <div className="flex gap-5 sm:gap-8">
        <Skeleton className="aspect-2/3 w-36 rounded-card sm:w-48" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full max-w-[720px]" />
        </div>
      </div>
      <PosterGridSkeleton count={12} />
    </div>
  );
}

function PersonDetailsView({ id }: { id: number }) {
  const query = useQuery(personQuery(id));
  const person = query.data;
  return (
    <Page title={person?.name ?? 'Personne'} back={homeBack}>
      <QueryState
        query={query}
        skeleton={<PersonSkeleton />}
        errorMessage="Cette page n’a pas pu se charger."
        notFound={{ title: 'Personne introuvable', description: 'TMDB ne connaît pas cette personne.' }}
      >
        {(data) => (
          <div className="space-y-10">
            <PersonHeader person={data} />
            <Filmography person={data} />
          </div>
        )}
      </QueryState>
    </Page>
  );
}

/** Personne (distribution, équipe) et sa filmographie : `/personne/6384`. */
export function PersonnePage() {
  const params = idParamsSchema.safeParse(useParams({ strict: false }));
  if (!params.success) return <IntrouvablePage />;
  return <PersonDetailsView key={params.data.id} id={params.data.id} />;
}
