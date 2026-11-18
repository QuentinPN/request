import type { Member } from '@shared/auth.ts';
import { roleLabels } from '@shared/roles.ts';
import { plural } from '@shared/text.ts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { useState } from 'react';
import { Notice } from '@/components/notice';
import { Avatar } from '@/components/shell/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useViewer } from '@/hooks/use-viewer';
import { formatDateTime, membersQuery, signOutMemberEverywhere } from '@/lib/requests';
import { MemberEditDialog } from './member-edit-dialog';
import { LoadedSection, SectionFrame, type SectionFrameProps } from './section-frame';

function SignOutDialog({
  member,
  onClose,
  onDone,
}: {
  member: Member;
  onClose: () => void;
  onDone: (member: Member) => void;
}) {
  const signOut = useMutation({
    mutationFn: () => signOutMemberEverywhere(member.id),
    onSuccess: () => {
      onDone(member);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !signOut.isPending && onClose()}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0">
        <DialogHeader>
          <DialogTitle>Déconnecter {member.name} partout ?</DialogTitle>
          <DialogDescription>
            Toutes ses sessions sont fermées, sur tous ses appareils. Il devra se reconnecter.
          </DialogDescription>
        </DialogHeader>
        {signOut.isError && <Notice tone="error">{signOut.error.message}</Notice>}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={signOut.isPending}>
            Annuler
          </Button>
          <Button variant="destructive" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            {signOut.isPending ? 'Déconnexion…' : 'Déconnecter'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Bouton secondaire à contour, commun aux actions d'une ligne. */
const rowAction = 'border-input';

/** Quotas propres au membre, en clair, sous son rôle. */
function quotaSummary({ quotaOverride }: Member): string | null {
  if (quotaOverride?.unlimited) return 'Sans quota';
  return quotaOverride?.movies || quotaOverride?.seasons ? 'Quotas propres' : null;
}

function MemberRow({
  member,
  isSelf,
  onEdit,
  onSignOut,
}: {
  member: Member;
  isSelf: boolean;
  onEdit: () => void;
  onSignOut: () => void;
}) {
  const quota = quotaSummary(member);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow items-center gap-3">
        <Avatar viewer={member} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold break-words">{member.name}</span>
            {isSelf && <Badge variant="secondary">Vous</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">
            {roleLabels[member.role]}
            {quota && ` · ${quota}`} ·{' '}
            {member.lastLoginAt ? `Dernière connexion : ${formatDateTime(member.lastLoginAt)}` : 'Jamais connecté'}
          </span>
        </div>
      </div>
      {!isSelf && (
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
          {member.role !== 'owner' && (
            <Button
              type="button"
              variant="secondary"
              className={rowAction}
              aria-label={`Modifier : ${member.name}`}
              onClick={onEdit}
            >
              Modifier
            </Button>
          )}
          <Link
            to="/demandes"
            search={{ membre: member.id }}
            className={cn(buttonVariants({ variant: 'secondary' }), rowAction)}
            aria-label={`Voir ses demandes : ${member.name}`}
          >
            Voir ses demandes
          </Link>
          <Button
            type="button"
            variant="secondary"
            className={rowAction}
            aria-label={`Déconnecter partout : ${member.name}`}
            onClick={onSignOut}
          >
            Déconnecter partout
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Membres de l'appli (propriétaire) : rôle et quotas de chacun, ses demandes (page Mes demandes), et « Déconnecter
 * partout », qui ferme toutes les sessions d'un membre, par exemple après un appareil perdu. Pas un réglage : rien à tester ni à enregistrer.
 */
export function MembersSection(frame: SectionFrameProps) {
  const query = useQuery(membersQuery);
  const viewer = useViewer();
  const [editing, setEditing] = useState<Member | null>(null);
  const [signingOut, setSigningOut] = useState<Member | null>(null);
  const [signedOut, setSignedOut] = useState<Member | null>(null);

  return (
    <LoadedSection {...frame} query={query} rows={3} errorMessage="Les membres n’ont pas pu se charger.">
      {(members) => (
        <SectionFrame {...frame} status="done" doneLabel={plural(members.length, 'membre', 'membres')}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Modifier change son rôle (approbation automatique, gestionnaire) et ses quotas. Déconnecter partout ferme
              toutes les sessions du membre sur tous ses appareils ; il devra se reconnecter.
            </p>
            {signedOut && (
              <Notice tone="ok" role="status">
                {signedOut.name} est déconnecté de tous ses appareils.
              </Notice>
            )}
            <ul className="divide-y divide-border border-y border-border">
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  isSelf={member.id === viewer?.id}
                  onEdit={() => setEditing(member)}
                  onSignOut={() => {
                    setSignedOut(null);
                    setSigningOut(member);
                  }}
                />
              ))}
            </ul>
          </div>
          {editing && <MemberEditDialog member={editing} onClose={() => setEditing(null)} />}
          {signingOut && (
            <SignOutDialog member={signingOut} onClose={() => setSigningOut(null)} onDone={setSignedOut} />
          )}
        </SectionFrame>
      )}
    </LoadedSection>
  );
}
