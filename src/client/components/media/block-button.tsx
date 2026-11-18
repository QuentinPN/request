import type { MediaBlock, MediaSummary } from '@shared/media.ts';
import { Ban } from 'lucide-react';
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
import { useViewer } from '@/hooks/use-viewer';
import { blockLabel, useBlockTitle, useUnblockTitle } from '@/lib/blocklist';
import { errorMessage } from '@/lib/http';
import { StatusPill } from './status-pill';

/** Pastille « Bloqué » (teinte des refus) : la fiche n'a plus de bouton « Demander ». */
export function BlockedPill({ block, className }: { block: MediaBlock; className?: string }) {
  return <StatusPill status="declined" label={blockLabel(block)} className={className} />;
}

/**
 * « Bloquer ce titre » (avec confirmation) ou « Débloquer » de la fiche, pour qui gère les blocages. Un titre bloqué par
 * mot-clé se débloque dans Réglages › Blocages (le mot-clé y est retiré), pas ici.
 */
export function BlockTitleButton({ media, className }: { media: MediaSummary; className?: string }) {
  const viewer = useViewer();
  const [confirming, setConfirming] = useState(false);
  const block = useBlockTitle();
  const unblock = useUnblockTitle();
  if (!viewer?.capabilities.canManageBlocklist || media.blocked?.by === 'keyword') return null;
  const key = { type: media.type, tmdbId: media.tmdbId };

  if (media.blocked)
    return (
      <>
        <Button
          variant="secondary"
          size="lg"
          className={className}
          disabled={unblock.isPending}
          onClick={() => unblock.mutate(key)}
        >
          Débloquer
        </Button>
        {unblock.error && (
          <Notice tone="error" role="alert" className="basis-full">
            {errorMessage(unblock.error, 'Le titre n’a pas pu être débloqué.')}
          </Notice>
        )}
      </>
    );

  return (
    <Dialog
      open={confirming}
      onOpenChange={(open) => {
        if (block.isPending) return;
        setConfirming(open);
        if (!open) block.reset();
      }}
    >
      <Button variant="secondary" size="lg" className={className} onClick={() => setConfirming(true)}>
        <Ban data-icon="inline-start" />
        Bloquer ce titre
      </Button>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Bloquer « {media.title} » ?</DialogTitle>
          <DialogDescription>
            Il ne pourra plus être demandé, et les membres ne le verront plus dans Découvrir ni dans la recherche. Les
            demandes déjà en attente restent à traiter. Vous pourrez le débloquer ici ou dans Réglages › Blocages.
          </DialogDescription>
        </DialogHeader>
        {block.error && (
          <Notice tone="error" role="alert">
            {errorMessage(block.error, 'Le titre n’a pas pu être bloqué.')}
          </Notice>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={block.isPending}>
            Annuler
          </Button>
          <Button
            variant="destructive"
            disabled={block.isPending}
            onClick={() =>
              block.mutate({ mediaType: key.type, tmdbId: key.tmdbId }, { onSuccess: () => setConfirming(false) })
            }
          >
            Bloquer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
