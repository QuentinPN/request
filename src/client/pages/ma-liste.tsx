import { useInfiniteQuery } from '@tanstack/react-query';
import { Upload, X } from 'lucide-react';
import { useState } from 'react';
import { PosterGrid } from '@/components/media/poster-grid';
import { Notice } from '@/components/notice';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { ImportDialog } from '@/components/watchlist/import-dialog';
import { plural } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { useSetInWatchlist, watchlistQuery } from '@/lib/watchlist';
import type { MediaSummary } from '../../shared/media.ts';

/** « Retirer de ma liste », sous l'affiche (la pastille de statut et « Demander » occupent déjà l'image). */
function RemoveButton({ media, onError }: { media: MediaSummary; onError: (message: string) => void }) {
  const remove = useSetInWatchlist({ type: media.type, tmdbId: media.tmdbId });
  return (
    <Button
      variant="ghost"
      size="sm"
      className="mt-1 -ml-2 text-muted-foreground"
      aria-label={`Retirer ${media.title} de ma liste`}
      disabled={remove.isPending}
      onClick={() =>
        remove.mutate(false, { onError: (error) => onError(errorMessage(error, 'Ce titre n’a pas pu être retiré.')) })
      }
    >
      <X data-icon="inline-start" />
      Retirer
    </Button>
  );
}

/** Ma liste : les titres que le membre veut voir, avec leur statut ; la fiche, un clic plus loin, permet de les demander. */
export function MaListePage() {
  const query = useInfiniteQuery(watchlistQuery());
  const [importing, setImporting] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const total = query.data?.pages[0]?.total;

  return (
    <Page title="Ma liste">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground">
          {total === undefined ? '' : total === 0 ? 'Aucun titre pour l’instant' : plural(total, 'titre', 'titres')}
        </p>
        <Button variant="secondary" size="lg" onClick={() => setImporting(true)}>
          <Upload data-icon="inline-start" />
          Importer une liste
        </Button>
      </div>
      {removeError && (
        <Notice tone="error" role="alert">
          {removeError}
        </Notice>
      )}
      <PosterGrid
        query={query}
        empty={{
          title: 'Votre liste est vide',
          description:
            'Ajoutez un film ou une série depuis sa fiche avec « Ajouter à ma liste », ou importez votre liste Trakt ou Letterboxd.',
        }}
        footer={(media) => <RemoveButton media={media} onError={setRemoveError} />}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </Page>
  );
}
