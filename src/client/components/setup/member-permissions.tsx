import {
  type AssignableRole,
  assignableRoles,
  type Capabilities,
  canAssignManager,
  canGrant,
  effectivePermissions,
  MANAGER_ASSIGN_REFUSAL,
  type Permission,
  permissionGroups,
  permissionOverridesOf,
  roleDescriptions,
  roleLabels,
  rolePermissions,
} from '@shared/roles.ts';
import type { Setting } from '@shared/settings.ts';
import { plural } from '@shared/text.ts';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { type ComponentProps, type FormEvent, type ReactNode, useId, useState } from 'react';
import { ChoiceRow } from '@/components/choice-row';
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
import { CheckboxRow } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/http';
import { memberDefaultsQuery, useSaveMemberDefaults } from '@/lib/requests';

/** Choix unique avec son explication (rôle, quotas). */
export function ChoiceRowWithHint({
  label,
  hint,
  ...props
}: Omit<ComponentProps<typeof ChoiceRow>, 'children' | 'className'> & { label: string; hint?: ReactNode }) {
  return (
    <ChoiceRow className="items-start py-2.5 [&>input]:mt-0.5" {...props}>
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
    </ChoiceRow>
  );
}

/**
 * Choix du rôle (préréglage des droits). « Gestionnaire » n'est proposé qu'à qui a tous ses droits (`canAssignManager`),
 * et qui est hors quota, sauf s'il est déjà celui du membre.
 */
export function RoleChoices({
  name,
  value,
  current,
  actor,
  onChange,
}: {
  name: string;
  value: AssignableRole;
  current?: AssignableRole;
  actor: Capabilities;
  onChange: (role: AssignableRole) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-[13px] font-semibold">Rôle</legend>
      {assignableRoles.map((r) => {
        const locked = r === 'manager' && current !== 'manager' && !canAssignManager(actor);
        return (
          <ChoiceRowWithHint
            key={r}
            name={name}
            checked={value === r}
            disabled={locked}
            onSelect={() => onChange(r)}
            label={roleLabels[r]}
            hint={locked ? MANAGER_ASSIGN_REFUSAL : roleDescriptions[r]}
          />
        );
      })}
    </fieldset>
  );
}

/**
 * Section « Avancé » : chaque droit en case à cocher, d'après les droits effectifs (`value`). Une case que `actor` ne peut
 * pas accorder reste désactivée tant qu'elle n'était pas cochée (`granted`) : retirer reste permis. « Revenir au rôle »
 * remet le préréglage de `role`.
 */
export function PermissionFields({
  role,
  value,
  granted,
  actor,
  onChange,
}: {
  role: AssignableRole;
  value: Record<Permission, boolean>;
  /** Droits qu'il a déjà : une case cochée au départ peut toujours être recochée. */
  granted: Record<Permission, boolean>;
  actor: Capabilities;
  onChange: (value: Record<Permission, boolean>) => void;
}) {
  const preset = rolePermissions(role);
  const custom = (Object.keys(preset) as Permission[]).filter((key) => preset[key] !== value[key]).length;
  // Ouvert d'emblée s'il a des droits propres ; ensuite, le membre qui modifie décide (pas de fermeture en cours d'édition).
  const [initiallyOpen] = useState(custom > 0);
  return (
    <details className="group" open={initiallyOpen}>
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[12px] text-[13px] font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring">
        <span>
          Avancé
          <span className="ml-2 font-normal text-muted-foreground">
            {custom > 0 ? plural(custom, 'droit propre', 'droits propres') : 'droits du rôle'}
          </span>
        </span>
        <ChevronDown aria-hidden className="size-[18px] text-muted-foreground group-open:rotate-180" />
      </summary>
      <div className="mt-3 grid gap-4">
        {!actor.isOwner && (
          <p className="text-sm text-muted-foreground">
            Les droits grisés sont ceux que vous n’avez pas : vous ne pouvez pas les accorder, seulement les retirer.
          </p>
        )}
        {permissionGroups.map((group) => (
          <fieldset key={group.label} className="grid gap-2">
            <legend className="mb-2 text-[13px] font-semibold text-muted-foreground">{group.label}</legend>
            {group.permissions.map(({ key, label, hint }) => (
              <CheckboxRow
                key={key}
                checked={value[key]}
                disabled={!canGrant(actor, key) && !granted[key]}
                onChange={(checked) => onChange({ ...value, [key]: checked })}
                label={label}
                hint={hint}
              />
            ))}
          </fieldset>
        ))}
        <div>
          <Button
            type="button"
            variant="secondary"
            className="border-input"
            disabled={custom === 0}
            onClick={() => onChange(preset)}
          >
            Revenir au rôle
          </Button>
        </div>
      </div>
    </details>
  );
}

/**
 * « Droits par défaut » (propriétaire) : rôle et droits donnés à un membre à sa création (première connexion, import
 * depuis le serveur multimédia). Seul l'écart au rôle est enregistré ; un membre existant n'est pas touché.
 */
export function MemberDefaultsDialog({ actor, onClose }: { actor: Capabilities; onClose: () => void }) {
  const query = useQuery(memberDefaultsQuery);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Droits par défaut</DialogTitle>
          <DialogDescription>
            Donnés à chaque nouveau membre, à sa première connexion ou à son import. Les membres existants gardent les
            leurs.
          </DialogDescription>
        </DialogHeader>
        {query.isError ? (
          <Notice tone="error">Les droits par défaut n’ont pas pu se charger.</Notice>
        ) : query.data ? (
          <MemberDefaultsForm stored={query.data} actor={actor} onClose={onClose} />
        ) : (
          <Skeleton className="h-40" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberDefaultsForm({
  stored,
  actor,
  onClose,
}: {
  stored: Setting<'memberDefaults'>;
  actor: Capabilities;
  onClose: () => void;
}) {
  const id = useId();
  const initial = effectivePermissions(stored);
  const [role, setRole] = useState<AssignableRole>(stored.role);
  const [permissions, setPermissions] = useState(initial);
  const save = useSaveMemberDefaults();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ role, permissions: permissionOverridesOf(role, permissions) }, { onSuccess: onClose });
  };

  return (
    <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-col gap-5">
      {/* Seul le contenu défile : Enregistrer reste visible sans faire défiler. */}
      <div className="-mx-1 grid min-h-0 gap-5 overflow-y-auto px-1 py-1">
        <RoleChoices
          name={`${id}-role`}
          value={role}
          actor={actor}
          onChange={(r) => {
            setRole(r);
            setPermissions(rolePermissions(r));
            save.reset();
          }}
        />
        <PermissionFields
          role={role}
          value={permissions}
          granted={initial}
          actor={actor}
          onChange={(next) => {
            setPermissions(next);
            save.reset();
          }}
        />
        {save.isError && (
          <Notice tone="error" role="alert">
            {errorMessage(save.error, 'Les droits par défaut n’ont pas pu être enregistrés.')}
          </Notice>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
          Annuler
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
      </DialogFooter>
    </form>
  );
}
