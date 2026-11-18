import type { Member } from '@shared/auth.ts';
import {
  assignableRoles,
  capabilitiesOf,
  type QuotaOverride,
  type Role,
  roleDescriptions,
  roleLabels,
} from '@shared/roles.ts';
import { settingSchemas } from '@shared/settings.ts';
import { plural } from '@shared/text.ts';
import { useQuery } from '@tanstack/react-query';
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
import { errorMessage } from '@/lib/http';
import { useUpdateMember } from '@/lib/requests';
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

const isAssignable = (role: Role): role is (typeof assignableRoles)[number] =>
  (assignableRoles as readonly Role[]).includes(role);

/** Choix unique avec son explication (rôle, quotas). */
function ChoiceRowWithHint({
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
 * Rôle et quotas d'un membre (propriétaire). Le rôle donne l'approbation automatique (« Approbation auto ») ou
 * l'administration (« Gestionnaire », hors quotas) ; le quota est celui par défaut, un quota propre ou aucun.
 */
export function MemberEditDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const id = useId();
  const defaults = useQuery(settingQuery('rules')).data?.defaultQuota ?? settingSchemas.rules.parse({}).defaultQuota;
  const [role, setRole] = useState<(typeof assignableRoles)[number]>(
    isAssignable(member.role) ? member.role : 'member',
  );
  const [mode, setMode] = useState<QuotaMode>(modeOf(member.quotaOverride));
  const [draft, setDraft] = useState<QuotaDraft>(() => ({
    movies: quotaDraftOf(member.quotaOverride?.movies ?? defaults.movies),
    seasons: quotaDraftOf(member.quotaOverride?.seasons ?? defaults.seasons),
  }));
  const save = useUpdateMember();
  const exempt = capabilitiesOf(role).quotaExempt;
  const rules = quotaRulesOf(draft);
  const invalid = !exempt && mode === 'custom' && !(rules.movies.success && rules.seasons.success);

  const change = (apply: () => void) => {
    apply();
    save.reset();
  };
  const edit = (key: QuotaKey, field: 'limit' | 'days', value: string) =>
    change(() => setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } })));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    // Hors quotas par son rôle : les quotas enregistrés restent tels quels (ils reviennent si le rôle change).
    const quotaOverride: QuotaOverride | null | undefined = exempt
      ? undefined
      : mode === 'default'
        ? null
        : mode === 'unlimited'
          ? { movies: null, seasons: null, unlimited: true }
          : rules.movies.success && rules.seasons.success
            ? { movies: rules.movies.data, seasons: rules.seasons.data }
            : undefined;
    save.mutate({ id: member.id, update: { role, quotaOverride } }, { onSuccess: onClose });
  };

  const defaultHint = `Actuellement : ${plural(defaults.movies.limit, 'film', 'films')} sur ${plural(defaults.movies.days, 'jour', 'jours')}, ${plural(defaults.seasons.limit, 'saison', 'saisons')} sur ${plural(defaults.seasons.days, 'jour', 'jours')}.`;

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Modifier {member.name}</DialogTitle>
          <DialogDescription>
            Son rôle et ses quotas de demandes. Le changement vaut dès sa prochaine action.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-col gap-5">
          {/* Seul le contenu défile : Enregistrer reste visible sans faire défiler. */}
          <div className="-mx-1 grid min-h-0 gap-5 overflow-y-auto px-1 py-1">
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[13px] font-semibold">Rôle</legend>
              {assignableRoles.map((r) => (
                <ChoiceRowWithHint
                  key={r}
                  name={`${id}-role`}
                  checked={role === r}
                  onSelect={() => change(() => setRole(r))}
                  label={roleLabels[r]}
                  hint={roleDescriptions[r]}
                />
              ))}
            </fieldset>
            <fieldset className="grid gap-2" disabled={exempt}>
              <legend className="mb-2 text-[13px] font-semibold">Quotas</legend>
              {exempt && (
                <p className="text-sm text-muted-foreground">
                  Le rôle {roleLabels[role]} est hors quotas : rien à régler ici.
                </p>
              )}
              {quotaModes.map(({ mode: m, label, hint }) => (
                <ChoiceRowWithHint
                  key={m}
                  name={`${id}-quota`}
                  checked={!exempt && mode === m}
                  disabled={exempt}
                  onSelect={() => change(() => setMode(m))}
                  label={label}
                  hint={m === 'default' ? defaultHint : hint}
                />
              ))}
              {!exempt && mode === 'custom' && (
                <QuotaFields id={id} draft={draft} onChange={edit} className="mt-2 sm:grid-cols-1" />
              )}
            </fieldset>
            {save.isError && (
              <Notice tone="error" role="alert">
                {errorMessage(save.error, 'Le membre n’a pas pu être modifié.')}
              </Notice>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={save.isPending || invalid}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
