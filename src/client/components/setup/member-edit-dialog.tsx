import type { Member } from '@shared/auth.ts';
import {
  type AssignableRole,
  assignableRoles,
  type Capabilities,
  capabilitiesOf,
  effectivePermissions,
  memberEditRefusal,
  permissionOverridesOf,
  type QuotaOverride,
  quotaEditRefusal,
  type Role,
  roleLabels,
  rolePermissions,
} from '@shared/roles.ts';
import { settingSchemas } from '@shared/settings.ts';
import { plural } from '@shared/text.ts';
import { useQuery } from '@tanstack/react-query';
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
import { errorMessage } from '@/lib/http';
import { useUpdateMember } from '@/lib/requests';
import { ChoiceRowWithHint, PermissionFields, RoleChoices } from './member-permissions';
import { settingQuery } from './queries';
import { type QuotaDraft, QuotaFields, type QuotaKey, quotaDraftOf, quotaRulesOf } from './quota-fields';

type QuotaMode = 'default' | 'custom' | 'unlimited';

const quotaModes: { mode: QuotaMode; label: string; hint?: string }[] = [
  { mode: 'default', label: 'Quotas par défaut' },
  { mode: 'custom', label: 'Quotas propres à ce membre', hint: 'Remplacent les quotas par défaut, pour lui seul.' },
  { mode: 'unlimited', label: 'Sans quota', hint: 'Il peut demander autant qu’il veut, sans changer de rôle.' },
];

const modeOf = (override: QuotaOverride | null): QuotaMode =>
  override?.unlimited ? 'unlimited' : override?.movies || override?.seasons ? 'custom' : 'default';

const isAssignable = (role: Role): role is AssignableRole => (assignableRoles as readonly Role[]).includes(role);

/**
 * Rôle, droits et quotas d'un membre (droit « Gérer les membres »). Le rôle est un préréglage des droits
 * (approbation automatique, gestion) ; « Avancé » les ajuste un par un, seul l'écart au rôle est enregistré. Le quota
 * est celui par défaut, un quota propre ou aucun. Les règles contre l'escalade (`memberEditRefusal`) sont vérifiées
 * avant l'envoi, comme le fera le serveur.
 */
export function MemberEditDialog({
  member,
  actor,
  onClose,
  onDelete,
}: {
  member: Member;
  actor: Capabilities;
  onClose: () => void;
  /** Absent quand le serveur refuserait la suppression (`memberDeleteRefusal`) : l'action n'est alors pas proposée. */
  onDelete?: () => void;
}) {
  const id = useId();
  // Les quotas par défaut sont un réglage du propriétaire : les autres voient ceux d'origine.
  const rules = useQuery({ ...settingQuery('rules'), enabled: actor.isOwner });
  const defaults = rules.data?.defaultQuota ?? settingSchemas.rules.parse({}).defaultQuota;
  const current = isAssignable(member.role) ? member.role : 'member';
  const [role, setRole] = useState<AssignableRole>(current);
  const granted = effectivePermissions(member);
  const [permissions, setPermissions] = useState(granted);
  const [mode, setMode] = useState<QuotaMode>(modeOf(member.quotaOverride));
  const [draft, setDraft] = useState<QuotaDraft>(() => ({
    movies: quotaDraftOf(member.quotaOverride?.movies ?? defaults.movies),
    seasons: quotaDraftOf(member.quotaOverride?.seasons ?? defaults.seasons),
  }));
  const save = useUpdateMember();
  const overrides = permissionOverridesOf(role, permissions);
  const exempt = capabilitiesOf({ role, permissions: overrides }).quotaExempt;
  const quotaRefusal = quotaEditRefusal(actor);
  const quotaLocked = exempt || quotaRefusal !== null;
  const refusal = memberEditRefusal(actor, member, { role, permissions: overrides });
  const quotaRules = quotaRulesOf(draft);
  const invalid = !quotaLocked && mode === 'custom' && !(quotaRules.movies.success && quotaRules.seasons.success);

  const change = (apply: () => void) => {
    apply();
    save.reset();
  };
  const edit = (key: QuotaKey, field: 'limit' | 'days', value: string) =>
    change(() => setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } })));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid || refusal) return;
    // Hors quotas par son rôle, ou quotas fermés à `actor` : les quotas enregistrés restent tels quels (ils reviennent si le rôle change).
    const quotaOverride: QuotaOverride | null | undefined = quotaLocked
      ? undefined
      : mode === 'default'
        ? null
        : mode === 'unlimited'
          ? { movies: null, seasons: null, unlimited: true }
          : quotaRules.movies.success && quotaRules.seasons.success
            ? { movies: quotaRules.movies.data, seasons: quotaRules.seasons.data }
            : undefined;
    save.mutate({ id: member.id, update: { role, permissions: overrides, quotaOverride } }, { onSuccess: onClose });
  };

  const defaultHint = `Actuellement : ${plural(defaults.movies.limit, 'film', 'films')} sur ${plural(defaults.movies.days, 'jour', 'jours')}, ${plural(defaults.seasons.limit, 'saison', 'saisons')} sur ${plural(defaults.seasons.days, 'jour', 'jours')}.`;

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Modifier {member.name}</DialogTitle>
          <DialogDescription>
            Son rôle, ses droits et ses quotas de demandes. Le changement vaut dès sa prochaine action.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-col gap-5">
          {/* Seul le contenu défile : Enregistrer reste visible sans faire défiler. */}
          <div className="-mx-1 grid min-h-0 gap-5 overflow-y-auto px-1 py-1">
            <RoleChoices
              name={`${id}-role`}
              value={role}
              current={current}
              actor={actor}
              onChange={(r) =>
                change(() => {
                  // Un rôle est un préréglage : le choisir remet ses droits.
                  setRole(r);
                  setPermissions(rolePermissions(r));
                })
              }
            />
            <fieldset className="grid gap-2" disabled={quotaLocked}>
              <legend className="mb-2 text-[13px] font-semibold">Quotas</legend>
              {quotaRefusal && <p className="text-sm text-muted-foreground">{quotaRefusal}.</p>}
              {!quotaRefusal && exempt && (
                <p className="text-sm text-muted-foreground">
                  Le rôle {roleLabels[role]} est hors quotas : rien à régler ici.
                </p>
              )}
              {quotaModes.map(({ mode: m, label, hint }) => (
                <ChoiceRowWithHint
                  key={m}
                  name={`${id}-quota`}
                  checked={!quotaLocked && mode === m}
                  disabled={quotaLocked}
                  onSelect={() => change(() => setMode(m))}
                  label={label}
                  hint={m === 'default' ? (actor.isOwner ? defaultHint : undefined) : hint}
                />
              ))}
              {!quotaLocked && mode === 'custom' && (
                <QuotaFields id={id} draft={draft} onChange={edit} className="mt-2 sm:grid-cols-1" />
              )}
            </fieldset>
            <PermissionFields
              role={role}
              value={permissions}
              granted={granted}
              actor={actor}
              onChange={(next) => change(() => setPermissions(next))}
            />
          </div>
          {/* Hors de la zone qui défile : le refus reste visible à côté d'Enregistrer. */}
          {(refusal || save.isError) && (
            <Notice tone="error" role="alert">
              {refusal ?? errorMessage(save.error, 'Le membre n’a pas pu être modifié.')}
            </Notice>
          )}
          <DialogFooter>
            {onDelete && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive sm:mr-auto"
                onClick={onDelete}
                disabled={save.isPending}
              >
                Supprimer ce membre
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || invalid || refusal !== null}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
