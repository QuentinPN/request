import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import { Film, Search, User } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useEffect, useId, useState } from 'react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { mediaKey, searchQuery, summaryMeta, titleLink } from '@/lib/catalogue';
import { imageUrl, type MediaSummary, type PersonSummary } from '../../../shared/media.ts';
import { StatusPill } from '../media/status-pill.tsx';
import { QueryState } from '../query-state.tsx';
import { EmptyState, Loading } from '../states.tsx';
import { Skeleton } from '../ui/skeleton.tsx';

const SEARCH_DELAY_MS = 250;
const thumb = 'grid h-[60px] w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-(--media-base)';

function Thumbnail({ src, round = false }: { src: string | null; round?: boolean }) {
  const Icon = round ? User : Film;
  return (
    <span aria-hidden className={cn(thumb, round && 'h-10 rounded-full')}>
      {src ? (
        <img src={src} alt="" width={40} height={60} loading="lazy" className="size-full object-cover" />
      ) : (
        <Icon className="size-4 text-muted-foreground" />
      )}
    </span>
  );
}

function SectionTitle({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="px-3 pt-3 pb-1.5 text-[13px] font-semibold text-muted-foreground">
      {children}
    </h3>
  );
}

function ResultsSkeleton() {
  return (
    <Loading label="Recherche…" className="space-y-1 p-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} aria-hidden className="flex items-center gap-3 px-3 py-2">
          <Skeleton className={thumb} />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </Loading>
  );
}

const optionId = (base: string, media: MediaSummary) => `${base}-${mediaKey(media).replace(':', '-')}`;

/**
 * Corps du dialogue Ctrl+K : champ, puis « Films et séries » (↑ ↓ et Entrée ouvrent la fiche) et « Personnes ».
 * Monté à l'ouverture : la recherche repart de zéro à chaque fois.
 */
export function SearchPanel({
  inputRef,
  onNavigate,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onNavigate: () => void;
}) {
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const query = useQuery(searchQuery(q));
  const media = q ? (query.data?.results ?? []) : [];
  // Le choix vaut pour une liste de résultats : de nouveaux résultats rendent le premier actif (Entrée ouvre le meilleur).
  const [choice, setChoice] = useState({ results: media, index: 0 });
  const active = choice.results === media ? choice.index : 0;
  const setActive = (index: number) => setChoice({ results: media, index });
  const navigate = useNavigate();
  const baseId = useId();
  const listboxId = `${baseId}-medias`;
  const activeMedia = media[active];

  useEffect(() => {
    if (activeMedia) document.getElementById(optionId(baseId, activeMedia))?.scrollIntoView({ block: 'nearest' });
  }, [activeMedia, baseId]);

  const open = (item: MediaSummary) => {
    onNavigate();
    void navigate(titleLink(item));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (media.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + media.length) % media.length);
    } else if (e.key === 'Enter' && activeMedia) {
      e.preventDefault();
      open(activeMedia);
    }
  };

  return (
    <>
      <label className="flex items-center gap-3 border-b border-border py-4 pr-14 pl-5 focus-within:border-ring">
        <Search aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="sr-only">Rechercher un film, une série ou une personne</span>
        <input
          ref={inputRef}
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-controls={media.length > 0 ? listboxId : undefined}
          aria-activedescendant={activeMedia ? optionId(baseId, activeMedia) : undefined}
          autoComplete="off"
          placeholder="Titre, acteur, réalisateur…"
          className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
        />
      </label>
      <div className="max-h-[min(60vh,560px)] overflow-y-auto">
        {!q ? (
          <EmptyState
            className="m-4 border-0"
            title="Cherchez un film, une série ou une personne"
            description="Tapez quelques lettres : ↑ ↓ pour choisir, Entrée pour ouvrir la fiche."
          />
        ) : (
          <QueryState
            query={query}
            skeleton={<ResultsSkeleton />}
            errorMessage="La recherche n’a pas abouti."
            empty={{ title: `Rien pour « ${q} »`, description: 'Vérifiez l’orthographe ou essayez le titre original.' }}
            isEmpty={(data) => data.results.length === 0 && data.people.length === 0}
          >
            {(data) => (
              <div className="p-2" aria-busy={query.isFetching}>
                {data.results.length > 0 && (
                  <section>
                    <SectionTitle id={`${baseId}-medias-titre`}>Films et séries</SectionTitle>
                    <div id={listboxId} role="listbox" aria-labelledby={`${baseId}-medias-titre`}>
                      {data.results.map((item, i) => (
                        <Link
                          key={mediaKey(item)}
                          id={optionId(baseId, item)}
                          role="option"
                          aria-selected={i === active}
                          tabIndex={-1}
                          {...titleLink(item)}
                          onClick={onNavigate}
                          onMouseMove={() => setActive(i)}
                          className="flex items-center gap-3 rounded-xl px-3 py-2 outline-none aria-selected:bg-accent"
                        >
                          <Thumbnail src={imageUrl(item.posterPath, 'profile')} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{item.title}</span>
                            <span className="block text-xs text-muted-foreground">{summaryMeta(item).join(' · ')}</span>
                          </span>
                          {item.status && <StatusPill status={item.status} className="shrink-0" />}
                        </Link>
                      ))}
                    </div>
                  </section>
                )}
                {data.people.length > 0 && (
                  <section aria-labelledby={`${baseId}-personnes`}>
                    <SectionTitle id={`${baseId}-personnes`}>Personnes</SectionTitle>
                    <ul>
                      {data.people.map((person) => (
                        <PersonRow key={person.id} person={person} />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </QueryState>
        )}
      </div>
    </>
  );
}

function PersonRow({ person }: { person: PersonSummary }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Thumbnail src={imageUrl(person.profilePath, 'profile')} round />
      <span className="min-w-0">
        <span className="block truncate font-medium">{person.name}</span>
        {person.knownFor.length > 0 && (
          <span className="block truncate text-xs text-muted-foreground">Connu pour {person.knownFor.join(', ')}</span>
        )}
      </span>
    </li>
  );
}
