import type { Member } from '@shared/auth.ts';
import {
  type AssignableRole,
  assignableRoles,
  type Capabilities,
  canAssignManager,
  canGrant,
  MANAGER_ASSIGN_REFUSAL,
  type Permission,
  type PermissionOverrides,
  permissionGroups,
  roleLabels,
} from '@shared/roles.ts';
import { plural } from '@shared/text.ts';
import { type FormEvent, useId, useState } from 'react';
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
import { Label, NativeSelect } from '@/components/ui/field';
import { errorMessage } from '@/lib/http';
import { useBulkUpdateMembers } from '@/lib/requests';

/** Valeur d'un droit dans l'édition en masse : inchangé (`''`), accordé ou retiré. */
type Change = '' | 'grant' | 'revoke';

/**
 * Édition en masse (Réglages › Membres) : un rôle et des droits accordés ou retirés pour tous les membres choisis, en
 * une transaction côté serveur. Un rôle remet d'abord son préréglage, les droits changés s'appliquent ensuite. Le serveur
 * refuse tout si l'un des membres ne peut pas être modifié ainsi (garde contre l'escalade) et nomme le membre.
 */
export function MembersBulkDialog({
  members,
  actor,
  onClose,
  onDone,
}: {
  members: Member[];
  actor: Capabilities;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [role, setRole] = useState<AssignableRole | ''>('');
  const [changes, setChanges] = useState<Partial<Record<Permission, Change>>>({});
  const save = useBulkUpdateMembers();
  const permissions: PermissionOverrides = Object.fromEntries(
    Object.entries(changes).flatMap(([key, change]) => (change ? [[key, change === 'grant']] : [])),
  );
  const empty = role === '' && Object.keys(permissions).length === 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (empty) return;
    save.mutate(
      { ids: members.map((m) => m.id), ...(role && { role }), permissions },
      {
        onSuccess: () => {
          onDone();
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Modifier {plural(members.length, 'membre', 'membres')}</DialogTitle>
          <DialogDescription>
            {members.map((m) => m.name).join(', ')}. Un rôle différent remet son préréglage, puis les droits choisis
            s’appliquent.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-col gap-5">
          {/* Seul le contenu défile : Appliquer reste visible sans faire défiler. */}
          <div className="-mx-1 grid min-h-0 gap-5 overflow-y-auto px-1 py-1">
            <div>
              <Label htmlFor={`${id}-role`}>Rôle</Label>
              <NativeSelect
                id={`${id}-role`}
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as AssignableRole | '');
                  save.reset();
                }}
              >
                <option value="">Ne pas changer</option>
                {assignableRoles.map((r) => (
                  <option
                    key={r}
                    value={r}
                    disabled={r === 'manager' && !canAssignManager(actor)}
                    title={r === 'manager' && !canAssignManager(actor) ? MANAGER_ASSIGN_REFUSAL : undefined}
                  >
                    {roleLabels[r]}
                  </option>
                ))}
              </NativeSelect>
              {role !== '' && members.some((m) => m.role !== role) && (
                <Notice tone="info" className="mt-2">
                  Changer de rôle remplace les droits personnalisés des membres choisis.
                </Notice>
              )}
            </div>
            {permissionGroups.map((group) => (
              <fieldset key={group.label} className="grid gap-3">
                <legend className="mb-1 text-[13px] font-semibold">{group.label}</legend>
                {group.permissions.map(({ key, label }) => (
                  <div key={key} className="grid gap-1.5 sm:grid-cols-[1fr_11rem] sm:items-center sm:gap-3">
                    <label htmlFor={`${id}-${key}`} className="text-sm">
                      {label}
                    </label>
                    <NativeSelect
                      id={`${id}-${key}`}
                      className="h-11"
                      value={changes[key] ?? ''}
                      onChange={(e) => {
                        setChanges((c) => ({ ...c, [key]: e.target.value as Change }));
                        save.reset();
                      }}
                    >
                      <option value="">Inchangé</option>
                      <option value="grant" disabled={!canGrant(actor, key)}>
                        Accordé
                      </option>
                      <option value="revoke">Retiré</option>
                    </NativeSelect>
                  </div>
                ))}
              </fieldset>
            ))}
          </div>
          {/* Hors de la zone qui défile : le refus reste visible à côté d'Appliquer. */}
          {save.isError && (
            <Notice tone="error" role="alert">
              {errorMessage(save.error, 'Les membres n’ont pas pu être modifiés.')}
            </Notice>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || empty}>
              {save.isPending ? 'Enregistrement…' : 'Appliquer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
