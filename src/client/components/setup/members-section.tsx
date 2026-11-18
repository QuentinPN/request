import type { Member } from '@shared/auth.ts';
import { type Capabilities, memberEditRefusal, roleLabels } from '@shared/roles.ts';
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
import { MemberDefaultsDialog } from './member-permissions';
import { MembersBulkDialog } from './members-bulk-dialog';
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

/** Case de sélection, dans une colonne de 44 px toujours présente : les avatars restent alignés. */
const selectCell = 'flex size-11 shrink-0 items-center justify-center';
const selectBox = 'size-[18px] accent-(--accent-play)';

/** Quotas et droits propres au membre, en clair, sous son rôle. */
function accessSummary({ quotaOverride, permissions }: Member): string[] {
  const quota = quotaOverride?.unlimited
    ? 'Sans quota'
    : quotaOverride?.movies || quotaOverride?.seasons
      ? 'Quotas propres'
      : null;
  return [quota, permissions ? 'Droits propres' : null].filter((part) => part !== null);
}

/** `actor` peut modifier ce membre (garde contre l'escalade, sans changement) : « Modifier » et case de sélection. */
const isEditable = (actor: Capabilities, member: Member) => memberEditRefusal(actor, member, member) === null;

function MemberRow({
  member,
  isSelf,
  editable,
  canSignOut,
  canSeeRequests,
  selected,
  onSelect,
  onEdit,
  onSignOut,
}: {
  member: Member;
  isSelf: boolean;
  editable: boolean;
  canSignOut: boolean;
  /** Demandes d'un autre membre : droit « Gérer les demandes » (sinon la page ne montre que les siennes). */
  canSeeRequests: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onEdit: () => void;
  onSignOut: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow items-center gap-3">
        <span className={selectCell}>
          {editable && (
            <input
              type="checkbox"
              className={selectBox}
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
              aria-label={`Sélectionner : ${member.name}`}
            />
          )}
        </span>
        <Avatar viewer={member} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold break-words">{member.name}</span>
            {isSelf && <Badge variant="secondary">Vous</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">
            {[roleLabels[member.role], ...accessSummary(member)].join(' · ')} ·{' '}
            {member.lastLoginAt ? `Dernière connexion : ${formatDateTime(member.lastLoginAt)}` : 'Jamais connecté'}
          </span>
        </div>
      </div>
      {!isSelf && (
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
          {editable && (
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
          {canSeeRequests && (
            <Link
              to="/demandes"
              search={{ membre: member.id }}
              className={cn(buttonVariants({ variant: 'secondary' }), rowAction)}
              aria-label={`Voir ses demandes : ${member.name}`}
            >
              Voir ses demandes
            </Link>
          )}
          {canSignOut && (
            <Button
              type="button"
              variant="secondary"
              className={rowAction}
              aria-label={`Déconnecter partout : ${member.name}`}
              onClick={onSignOut}
            >
              Déconnecter partout
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Membres de l'appli (propriétaire, ou droit « Gérer les membres ») : rôle, droits et quotas de chacun, modification de
 * plusieurs membres d'un coup (cases à cocher) et ses demandes (page Mes demandes). Pour le propriétaire seulement :
 * « Droits par défaut » des nouveaux membres et « Déconnecter partout », qui ferme toutes les sessions d'un membre, par
 * exemple après un appareil perdu. Pas un réglage : rien à tester ni à enregistrer.
 */
export function MembersSection(frame: SectionFrameProps) {
  const query = useQuery(membersQuery);
  const viewer = useViewer();
  const [editing, setEditing] = useState<Member | null>(null);
  const [signingOut, setSigningOut] = useState<Member | null>(null);
  const [signedOut, setSignedOut] = useState<Member | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const actor = viewer?.capabilities;
  const isOwner = actor?.isOwner === true;

  return (
    <LoadedSection {...frame} query={query} rows={3} errorMessage="Les membres n’ont pas pu se charger.">
      {(members) => {
        const editable = (m: Member) => !!actor && m.id !== viewer?.id && isEditable(actor, m);
        const selectable = members.filter(editable);
        // La sélection ne garde que des membres encore présents et modifiables (liste relue après un changement).
        const chosen = selectable.filter((m) => selected.has(m.id));
        const toggle = (id: string, on: boolean) =>
          setSelected((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          });
        return (
          <SectionFrame {...frame} status="done" doneLabel={plural(members.length, 'membre', 'membres')}>
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Modifier change son rôle, ses droits et ses quotas ; cochez plusieurs membres pour leur appliquer un
                rôle ou des droits d’un coup.
                {isOwner &&
                  ' Déconnecter partout ferme toutes les sessions du membre sur tous ses appareils ; il devra se reconnecter.'}
              </p>
              {isOwner && (
                <div>
                  <Button type="button" variant="secondary" className={rowAction} onClick={() => setDefaultsOpen(true)}>
                    Droits par défaut
                  </Button>
                </div>
              )}
              {signedOut && (
                <Notice tone="ok" role="status">
                  {signedOut.name} est déconnecté de tous ses appareils.
                </Notice>
              )}
              {selectable.length > 1 && (
                <label className="-mb-2 flex min-h-11 items-center gap-3 text-sm">
                  <span className={selectCell}>
                    <input
                      type="checkbox"
                      className={selectBox}
                      checked={chosen.length === selectable.length}
                      onChange={(e) => setSelected(new Set(e.target.checked ? selectable.map((m) => m.id) : []))}
                    />
                  </span>
                  Tout sélectionner
                </label>
              )}
              <ul className="divide-y divide-border border-y border-border">
                {members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    isSelf={member.id === viewer?.id}
                    editable={editable(member)}
                    canSignOut={isOwner}
                    canSeeRequests={actor?.canManageRequests === true}
                    selected={selected.has(member.id)}
                    onSelect={(on) => toggle(member.id, on)}
                    onEdit={() => setEditing(member)}
                    onSignOut={() => {
                      setSignedOut(null);
                      setSigningOut(member);
                    }}
                  />
                ))}
              </ul>
              {chosen.length > 0 && (
                // Barre de l'édition en masse : collée en bas de l'écran tant que la liste défile (au-dessus de la barre
                // d'onglets sur mobile : 20 px + 64 px + marge).
                <section
                  aria-label="Membres sélectionnés"
                  className="glass sticky bottom-[calc(96px+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[16px] px-4 py-3 lg:bottom-4"
                >
                  <span className="grow basis-full text-sm font-semibold sm:basis-auto">
                    {plural(chosen.length, 'membre sélectionné', 'membres sélectionnés')}
                  </span>
                  <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>
                    Désélectionner
                  </Button>
                  <Button type="button" onClick={() => setBulkOpen(true)}>
                    Modifier la sélection
                  </Button>
                </section>
              )}
            </div>
            {editing && actor && <MemberEditDialog member={editing} actor={actor} onClose={() => setEditing(null)} />}
            {bulkOpen && actor && (
              <MembersBulkDialog
                members={chosen}
                actor={actor}
                onClose={() => setBulkOpen(false)}
                onDone={() => setSelected(new Set())}
              />
            )}
            {defaultsOpen && actor && <MemberDefaultsDialog actor={actor} onClose={() => setDefaultsOpen(false)} />}
            {signingOut && (
              <SignOutDialog member={signingOut} onClose={() => setSigningOut(null)} onDone={setSignedOut} />
            )}
          </SectionFrame>
        );
      }}
    </LoadedSection>
  );
}
