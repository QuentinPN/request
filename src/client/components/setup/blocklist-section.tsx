import type { BlockedKeyword, BlockedTitle } from '@shared/blocklist.ts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { blocklistQuery, useSetBlockedKeywords, useUnblockTitle } from '@/lib/blocklist';
import { mediaTypeLabel, titleLink } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { formatDay } from '@/lib/requests';
import { KeywordPicker } from './keyword-picker';
import { LoadedSection, SectionFrame, type SectionFrameProps } from './section-frame';

const subheading = 'mb-2 text-[13px] font-semibold';

function TitleRow({ title }: { title: BlockedTitle }) {
  const unblock = useUnblockTitle();
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <Link
          {...titleLink({ type: title.mediaType, tmdbId: title.tmdbId })}
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

/** Mots-clés bloqués et recherche de mots-clés TMDB à ajouter (`KeywordPicker`). */
function Keywords({ keywords }: { keywords: BlockedKeyword[] }) {
  const save = useSetBlockedKeywords();
  return (
    <div>
      <KeywordPicker
        heading={<h3 className={subheading}>Mots-clés bloqués</h3>}
        emptyText="Aucun mot-clé bloqué."
        keywords={keywords}
        onChange={(next) => save.mutate(next)}
        disabled={save.isPending}
        verbs={{ add: 'Bloquer', added: 'Bloqué' }}
        hint="Mots-clés de TMDB, souvent en anglais. Ils retirent les titres des pages de genre et de plateforme pour les membres et bloquent la demande depuis la fiche."
      />
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

  return (
    <LoadedSection {...frame} query={query} errorMessage="Les blocages n’ont pas pu se charger.">
      {({ titles, keywords }) => {
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
      }}
    </LoadedSection>
  );
}
