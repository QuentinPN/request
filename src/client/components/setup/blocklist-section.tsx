import type { BlockedKeyword, BlockedTitle } from '@shared/blocklist.ts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { blocklistQuery, keywordSearchQuery, useSetBlockedKeywords, useUnblockTitle } from '@/lib/blocklist';
import { mediaTypeLabel } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { formatDay } from '@/lib/requests';
import { SectionFrame, type SectionFrameProps } from './section-frame';

const SEARCH_DELAY_MS = 300;
const subheading = 'mb-2 text-[13px] font-semibold';

function TitleRow({ title }: { title: BlockedTitle }) {
  const unblock = useUnblockTitle();
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <Link
          to="/titre/$type/$id"
          params={{ type: title.mediaType, id: String(title.tmdbId) }}
          className="truncate font-semibold outline-none hover:underline focus-visible:underline"
        >
          {title.title}
        </Link>
        <span className="text-xs text-muted-foreground">
          {mediaTypeLabel[title.mediaType]} · bloqué le {formatDay(title.createdAt)}
          {title.blockedBy && ` par ${title.blockedBy}`}
        </span>
        {unblock.error && (
          <span role="alert" className="text-xs text-(--text-danger)">
            {errorMessage(unblock.error, 'Le titre n’a pas pu être débloqué.')}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        className="border-input sm:shrink-0"
        aria-label={`Débloquer ${title.title}`}
        disabled={unblock.isPending}
        onClick={() => unblock.mutate({ type: title.mediaType, tmdbId: title.tmdbId })}
      >
        Débloquer
      </Button>
    </li>
  );
}

/** Mots-clés bloqués (pilules retirables) et recherche de mots-clés TMDB à ajouter. */
function Keywords({ keywords }: { keywords: BlockedKeyword[] }) {
  const id = useId();
  const save = useSetBlockedKeywords();
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search.trim(), SEARCH_DELAY_MS);
  const found = useQuery(keywordSearchQuery(term));
  const blocked = new Set(keywords.map((k) => k.id));
  const results = term ? (found.data ?? []) : [];

  return (
    <div>
      <h3 className={subheading}>Mots-clés bloqués</h3>
      {keywords.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun mot-clé bloqué.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {keywords.map((keyword) => (
            <li key={keyword.id}>
              <span className="inline-flex h-9 items-center gap-1 rounded-pill border border-border bg-secondary pr-1 pl-3.5 text-sm">
                {keyword.name}
                <button
                  type="button"
                  aria-label={`Retirer le mot-clé ${keyword.name}`}
                  disabled={save.isPending}
                  onClick={() => save.mutate(keywords.filter((k) => k.id !== keyword.id))}
                  className="grid size-7 place-items-center rounded-full text-muted-foreground outline-none hover:bg-(--surface-3) hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Label htmlFor={`${id}-search`}>Ajouter un mot-clé TMDB</Label>
        <Input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          placeholder="horreur, anime, superhero…"
          aria-describedby={`${id}-hint`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <FieldHint id={`${id}-hint`}>
          Mots-clés de TMDB, souvent en anglais. Ils retirent les titres des pages de genre et de plateforme pour les
          membres et bloquent la demande depuis la fiche.
        </FieldHint>
      </div>
      {found.isError && term && (
        <Notice tone="error" role="alert" className="mt-3">
          {errorMessage(found.error, 'La recherche de mots-clés a échoué.')}
        </Notice>
      )}
      {term && found.data && results.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">Aucun mot-clé TMDB ne correspond à « {term} ».</p>
      )}
      {results.length > 0 && (
        <ul aria-label="Mots-clés trouvés" className="mt-3 divide-y divide-border border-y border-border">
          {results.map((keyword) => (
            <li key={keyword.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-sm">{keyword.name}</span>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0 border-input"
                aria-label={`Bloquer le mot-clé ${keyword.name}`}
                disabled={blocked.has(keyword.id) || save.isPending}
                onClick={() => save.mutate([...keywords, keyword])}
              >
                {blocked.has(keyword.id) ? (
                  'Bloqué'
                ) : (
                  <>
                    <Plus data-icon="inline-start" />
                    Bloquer
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {save.error && (
        <Notice tone="error" role="alert" className="mt-3">
          {errorMessage(save.error, 'Les mots-clés n’ont pas pu être enregistrés.')}
        </Notice>
      )}
    </div>
  );
}

/**
 * Blocages (droit « Gérer les blocages ») : titres bloqués depuis leur fiche, à débloquer, et mots-clés TMDB. Les
 * demandes déjà faites ne sont pas touchées : celles en attente restent à traiter dans Approbations.
 */
export function BlocklistSection(frame: SectionFrameProps) {
  const query = useQuery(blocklistQuery);

  if (query.isPending)
    return (
      <SectionFrame {...frame} status="todo">
        <div role="status" className="space-y-4">
          <span className="sr-only">Chargement…</span>
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
          <Skeleton className="h-12 w-full rounded-(--r-button)" />
        </div>
      </SectionFrame>
    );
  if (query.isError)
    return (
      <SectionFrame {...frame} status="error">
        <ErrorState message="Les blocages n’ont pas pu se charger." onRetry={() => void query.refetch()} />
      </SectionFrame>
    );

  const { titles, keywords } = query.data;
  const count = titles.length + keywords.length;
  return (
    <SectionFrame
      {...frame}
      status={count > 0 ? 'done' : 'todo'}
      todoLabel="Aucun"
      doneLabel={`${count} ${count > 1 ? 'blocages' : 'blocage'}`}
    >
      <div className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          Un titre bloqué ne peut plus être demandé, et les membres ne le voient plus dans Découvrir ni dans la
          recherche. Les demandes déjà en attente restent à traiter.
        </p>
        <div>
          <h3 className={subheading}>Titres bloqués</h3>
          {titles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun titre bloqué. « Bloquer ce titre » se trouve sur la fiche d’un film ou d’une série.
            </p>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {titles.map((title) => (
                <TitleRow key={`${title.mediaType}:${title.tmdbId}`} title={title} />
              ))}
            </ul>
          )}
        </div>
        <Keywords keywords={keywords} />
      </div>
    </SectionFrame>
  );
}
