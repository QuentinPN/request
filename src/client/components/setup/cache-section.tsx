import { plural } from '@shared/text.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { clearImageCache, imageCacheQuery, invalidateMaintenance } from '@/lib/maintenance';
import { formatCount } from '@/lib/stats';
import { formatBytes } from './config';
import {
  actionClass,
  LoadedSection,
  SectionActions,
  SectionFrame,
  type SectionFrameProps,
  sectionStatus,
} from './section-frame';

function ClearDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: clearImageCache,
    onSuccess: async () => {
      await invalidateMaintenance(queryClient);
      onDone();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !clear.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Vider le cache d’images ?</DialogTitle>
          <DialogDescription>
            Toutes les affiches et tous les fonds enregistrés sont supprimés. Ils sont retéléchargés depuis TMDB au fur
            et à mesure des visites : les pages s’affichent un peu plus lentement au début.
          </DialogDescription>
        </DialogHeader>
        {clear.isError && <Notice tone="error">{clear.error.message}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={clear.isPending}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={() => clear.mutate()} disabled={clear.isPending}>
            {clear.isPending ? 'Suppression…' : 'Vider le cache'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cache disque des images TMDB (propriétaire) : combien il pèse, et vidage après confirmation. */
export function CacheSection(frame: SectionFrameProps) {
  const query = useQuery(imageCacheQuery);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const status = sectionStatus({ saved: true, open: frame.open, failed: false, testing: false });

  return (
    <LoadedSection {...frame} query={query} rows={1} errorMessage="Le cache d’images n’a pas pu se charger.">
      {({ files, bytes, maxBytes }) => (
        <SectionFrame {...frame} status={status} doneLabel={formatBytes(bytes)}>
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 sm:max-w-md">
              <div className="rounded-(--r-button) bg-muted px-4 py-3">
                <dt className="text-[13px] text-muted-foreground">Images</dt>
                <dd className="text-xl font-semibold">{formatCount(files)}</dd>
              </div>
              <div className="rounded-(--r-button) bg-muted px-4 py-3">
                <dt className="text-[13px] text-muted-foreground">Poids total</dt>
                <dd className="text-xl font-semibold">{formatBytes(bytes)}</dd>
              </div>
            </dl>
            <p className="text-sm text-muted-foreground">
              Le cache garde les images les plus récemment consultées, jusqu’à {formatBytes(maxBytes)} (variable{' '}
              <code className="text-[13px] text-foreground">IMAGE_CACHE_MAX_MB</code>).
            </p>
            <div role="status" className="empty:hidden">
              {cleared && <Notice tone="ok">Cache vidé.</Notice>}
            </div>
            <SectionActions>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className={actionClass}
                disabled={files === 0}
                onClick={() => {
                  setCleared(false);
                  setConfirming(true);
                }}
              >
                Vider le cache ({plural(files, 'image', 'images')})
              </Button>
            </SectionActions>
          </div>
          {confirming && (
            <ClearDialog
              onClose={() => setConfirming(false)}
              onDone={() => {
                setConfirming(false);
                setCleared(true);
              }}
            />
          )}
        </SectionFrame>
      )}
    </LoadedSection>
  );
}
