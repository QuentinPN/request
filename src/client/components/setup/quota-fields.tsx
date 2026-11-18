import { type QuotaRule, quotaRuleSchema } from '@shared/roles.ts';
import { cn } from 'cn';
import { Input, Label } from '@/components/ui/field';

const quotas = [
  { key: 'movies', legend: 'Films', unit: 'films' },
  { key: 'seasons', legend: 'Saisons de séries', unit: 'saisons' },
] as const;
export type QuotaKey = (typeof quotas)[number]['key'];
/** Saisie d'une règle : du texte, validé à part (un champ vide est refusé, pas lu comme 0). */
export type QuotaDraftRule = { limit: string; days: string };
export type QuotaDraft = Record<QuotaKey, QuotaDraftRule>;

export const quotaDraftOf = (rule: QuotaRule): QuotaDraftRule => ({
  limit: String(rule.limit),
  days: String(rule.days),
});
export const quotaRuleOf = (d: QuotaDraftRule) =>
  quotaRuleSchema.safeParse({ limit: Number(d.limit || Number.NaN), days: Number(d.days || Number.NaN) });
export const quotaRulesOf = (draft: QuotaDraft) => ({
  movies: quotaRuleOf(draft.movies),
  seasons: quotaRuleOf(draft.seasons),
});

/** Plafond et fenêtre en jours, pour les films et pour les saisons (quotas par défaut, quotas d'un membre). */
export function QuotaFields({
  id,
  draft,
  onChange,
  disabled,
  className,
}: {
  id: string;
  draft: QuotaDraft;
  onChange: (key: QuotaKey, field: keyof QuotaDraftRule, value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const parsed = quotaRulesOf(draft);
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2', className)}>
      {quotas.map(({ key, legend, unit }) => (
        <fieldset key={key} disabled={disabled} className="grid grid-cols-2 gap-3 disabled:opacity-60">
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
              onChange={(e) => onChange(key, 'limit', e.target.value)}
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
              onChange={(e) => onChange(key, 'days', e.target.value)}
            />
          </div>
        </fieldset>
      ))}
    </div>
  );
}
