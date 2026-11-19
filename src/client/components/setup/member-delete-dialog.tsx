import type { Member } from '@shared/auth.ts';
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
import { errorMessage } from '@/lib/http';
import { useDeleteMember } from '@/lib/requests';

/**
 * Confirmation de la suppression d'un membre (voir `memberDeleteRefusal` pour qui peut l'être) : ce qui disparaît, ce
 * qui reste, et ce qui se passe s'il se reconnecte.
 */
export function MemberDeleteDialog({
  member,
  onClose,
  onDone,
}: {
  member: Member;
  onClose: () => void;
  onDone: (member: Member) => void;
}) {
  const remove = useDeleteMember();

  return (
    <Dialog open onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle className="pr-8">Supprimer {member.name} ?</DialogTitle>
          <DialogDescription>
            Ses demandes, ses signalements, ses notifications, sa liste, ses clés d’API et ses appareils abonnés sont
            supprimés, et il est déconnecté. Les titres déjà envoyés restent dans Radarr et Sonarr. S’il se reconnecte
            via le serveur multimédia, il revient comme un nouveau membre, avec les droits par défaut.
          </DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <Notice tone="error" role="alert">
            {errorMessage(remove.error, 'Le membre n’a pas pu être supprimé.')}
          </Notice>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Annuler
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(member.id, {
                onSuccess: () => {
                  onDone(member);
                  onClose();
                },
              })
            }
          >
            {remove.isPending ? 'Suppression…' : 'Supprimer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
