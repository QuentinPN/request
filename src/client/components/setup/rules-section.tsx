import { type QuotaRule, quotaRuleSchema } from '@shared/roles.ts';
import type { MaskedSetting } from '@shared/settings.ts';
import { type FormEvent, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { useSaveSetting } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

const quotas = [
  { key: 'movies', legend: 'Films', unit: 'films' },
  { key: 'seasons', legend: 'Saisons de séries', unit: 'saisons' },
] as const;
type QuotaKey = (typeof quotas)[number]['key'];
type Draft = Record<QuotaKey, { limit: string; days: string }>;

const draftOf = (rule: QuotaRule) => ({ limit: String(rule.limit), days: String(rule.days) });
const ruleOf = (d: { limit: string; days: string }) =>
  // Champ vide : NaN, refusé (et non 0).
  quotaRuleSchema.safeParse({ limit: Number(d.limit || Number.NaN), days: Number(d.days || Number.NaN) });

type Props = SectionFrameProps & {
  stored: MaskedSetting<'rules'>;
  saved: boolean;
  wizard: boolean;
  onSaved: () => void;
};

/** Quotas par défaut des membres, sur une fenêtre glissante (le rôle décide de l'approbation automatique). */
export function RulesSection({ stored, saved, wizard, onSaved, ...frame }: Props) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => ({
    movies: draftOf(stored.defaultQuota.movies),
    seasons: draftOf(stored.defaultQuota.seasons),
  }));
  const save = useSaveSetting('rules', onSaved);
  const parsed = { movies: ruleOf(draft.movies), seasons: ruleOf(draft.seasons) };
  const invalid = !parsed.movies.success || !parsed.seasons.success;

  const update = (key: QuotaKey, field: 'limit' | 'days', value: string) => {
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));
    save.reset();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.movies.success && parsed.seasons.success)
      save.mutate({ defaultQuota: { movies: parsed.movies.data, seasons: parsed.seasons.data } });
  };

  const status = sectionStatus({ saved, open: frame.open, failed: save.isError, testing: save.isPending });

  return (
    <SectionFrame {...frame} status={status} doneLabel="Enregistré">
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {quotas.map(({ key, legend, unit }) => (
            <fieldset key={key} className="grid grid-cols-2 gap-3">
              <legend className="mb-2 text-[13px] font-semibold">{legend}</legend>
              <div>
                <Label htmlFor={`${id}-${key}-limit`} className="font-normal text-muted-foreground">
                  Nombre de {unit}
                </Label>
                <Input
                  id={`${id}-${key}-limit`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={draft[key].limit}
                  aria-invalid={!parsed[key].success || undefined}
                  onChange={(e) => update(key, 'limit', e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor={`${id}-${key}-days`} className="font-normal text-muted-foreground">
                  Sur (jours)
                </Label>
                <Input
                  id={`${id}-${key}-days`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft[key].days}
                  aria-invalid={!parsed[key].success || undefined}
                  onChange={(e) => update(key, 'days', e.target.value)}
                />
              </div>
            </fieldset>
          ))}
        </div>
        <FieldHint className="-mt-2">
          Par membre, sur une fenêtre glissante. Un quota propre à un membre pourra remplacer ces valeurs.
        </FieldHint>
        <div role="status" className="empty:-mt-4">
          {invalid ? (
            <Notice tone="error">Nombres entiers attendus : au moins 0 demande, sur au moins 1 jour.</Notice>
          ) : save.isError ? (
            <Notice tone="error">{save.error.message}</Notice>
          ) : save.isSuccess && !wizard ? (
            <Notice tone="ok">Règles enregistrées</Notice>
          ) : null}
        </div>
        <SectionActions>
          <Button type="submit" size="lg" className={actionClass} disabled={invalid || save.isPending}>
            {wizard ? 'Enregistrer et continuer' : 'Enregistrer'}
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}
