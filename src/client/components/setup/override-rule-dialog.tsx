import { type ArrServer, arrKindLabels } from '@shared/arr-servers.ts';
import type { MediaType } from '@shared/media.ts';
import type { OverrideRule, OverrideRuleInput } from '@shared/override-rules.ts';
import type { SendOptions } from '@shared/requests.ts';
import { DEFAULT_SERIES_TYPE } from '@shared/settings.ts';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { LANGUAGES, languageLabel } from '@/components/media/browse-filters';
import { Notice } from '@/components/notice';
import { SendChoiceFields } from '@/components/requests/send-choice-fields';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CheckboxField, Input, Label } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import type { SendChoice } from '@/lib/approvals';
import { genresQuery, mediaTypePlural } from '@/lib/catalogue';
import { errorMessage } from '@/lib/http';
import { arrServerChoicesQuery, useDeleteOverrideRule, useSaveOverrideRule } from '@/lib/override-rules';
import { TagPicker } from './arr-server-options';
import { KeywordPicker } from './keyword-picker';

const legendClass = 'mb-2 text-[13px] font-semibold';
const kindOf = (type: MediaType) => (type === 'movie' ? 'radarr' : 'sonarr');

/** Serveurs du type de la règle : non 4K d'abord, le serveur par défaut en tête. */
const serversFor = (servers: ArrServer[], type: MediaType) =>
  servers
    .filter((s) => s.type === kindOf(type))
    .sort((a, b) => Number(a.is4k) - Number(b.is4k) || Number(b.isDefault) - Number(a.isDefault));

/** Nouvelle règle d'un type : serveur par défaut, aucune condition, rien de changé. */
const blankRule = (type: MediaType, servers: ArrServer[]): OverrideRuleInput => ({
  name: '',
  type,
  serverId: serversFor(servers, type)[0]?.id ?? 0,
  genres: [],
  languages: [],
  keywords: [],
  qualityProfileId: null,
  rootFolderPath: null,
  seriesType: null,
  tags: [],
  enabled: true,
});

/** Cases à cocher d'une liste de valeurs (genres, langues), sur trois colonnes. */
function MultiCheck<T extends string | number>({
  legend,
  items,
  selected,
  onChange,
}: {
  legend: string;
  items: { value: T; label: string }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <fieldset>
      <legend className={legendClass}>{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <CheckboxField
            key={item.value}
            checked={selected.includes(item.value)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, item.value] : selected.filter((v) => v !== item.value))
            }
          >
            <span className="min-w-0 truncate">{item.label}</span>
          </CheckboxField>
        ))}
      </div>
    </fieldset>
  );
}

/** Effets de la règle : serveur, profil, dossier, type de série (`SendChoiceFields`, « Inchangé » permis) et étiquettes. */
function Effects({
  draft,
  servers,
  onChange,
  disabled,
}: {
  draft: OverrideRuleInput;
  servers: ArrServer[];
  onChange: (patch: Partial<OverrideRuleInput>) => void;
  disabled: boolean;
}) {
  const candidates = serversFor(servers, draft.type);
  const server = candidates.find((s) => s.id === draft.serverId);
  const choices = useQuery(arrServerChoicesQuery(server));
  const service = arrKindLabels[kindOf(draft.type)];
  if (!server) return <Notice tone="info">Aucun serveur {service} n’est configuré.</Notice>;
  if (choices.isError)
    return (
      <Notice tone="error" role="alert">
        {errorMessage(choices.error, `Les profils et dossiers de ${server.name} n’ont pas pu se charger.`)}
      </Notice>
    );
  if (!choices.data)
    return (
      <div role="status" className="space-y-2">
        <span className="sr-only">Chargement des profils et dossiers…</span>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  const options: SendOptions = {
    servers: candidates.map(({ id, name, is4k, isDefault, externalUrl }) => ({
      id,
      name,
      is4k,
      isDefault,
      externalUrl,
    })),
    serverId: server.id,
    qualityProfiles: choices.data.qualityProfiles,
    rootFolders: choices.data.rootFolders,
    defaultProfileId: server.qualityProfileId,
    defaultFolder: server.rootFolderPath,
    defaultSeriesType: draft.type === 'tv' ? (server.seriesType ?? DEFAULT_SERIES_TYPE) : null,
    anime: false,
    rules: [],
  };
  const onChoice = (patch: SendChoice) => {
    // Profils, dossiers et étiquettes sont propres à chaque serveur : un autre serveur repart de « Inchangé ».
    if (patch.serverId !== undefined && patch.serverId !== draft.serverId)
      return onChange({ serverId: patch.serverId, qualityProfileId: null, rootFolderPath: null, tags: [] });
    if ('qualityProfileId' in patch) onChange({ qualityProfileId: patch.qualityProfileId ?? null });
    if ('rootFolderPath' in patch) onChange({ rootFolderPath: patch.rootFolderPath ?? null });
    if ('seriesType' in patch) onChange({ seriesType: patch.seriesType ?? null });
  };
  return (
    <div className="grid gap-5">
      <SendChoiceFields
        service={service}
        options={options}
        value={{
          serverId: server.id,
          qualityProfileId: draft.qualityProfileId ?? undefined,
          rootFolderPath: draft.rootFolderPath ?? undefined,
          seriesType: draft.seriesType ?? undefined,
        }}
        onChoice={onChoice}
        disabled={disabled}
        unset="Inchangé"
      />
      {choices.data.tags && (
        <TagPicker
          legend="Étiquettes ajoutées"
          hint="Ajoutées à celles du serveur et du membre."
          tags={choices.data.tags}
          selected={draft.tags ?? []}
          onChange={(tags) => onChange({ tags })}
        />
      )}
    </div>
  );
}

/**
 * Ajout ou modification d'une règle de surcharge : nom, type, conditions (genres, langues originales, mots-clés TMDB)
 * et effets. Le serveur vérifie le profil et le dossier avant d'enregistrer.
 */
export function OverrideRuleDialog({
  rule,
  servers,
  onClose,
}: {
  /** Absente : nouvelle règle. */
  rule?: OverrideRule | undefined;
  servers: ArrServer[];
  onClose: () => void;
}) {
  const id = useId();
  const save = useSaveOverrideRule();
  const remove = useDeleteOverrideRule();
  const [draft, setDraft] = useState<OverrideRuleInput>(() => {
    if (!rule) return blankRule('movie', servers);
    const { id: _id, position: _position, ...values } = rule;
    return values;
  });
  const change = (patch: Partial<OverrideRuleInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
    save.reset();
  };
  const genres = useQuery(genresQuery(draft.type)).data?.genres ?? [];
  const languages = [...new Set([...LANGUAGES, ...(draft.languages ?? [])])];
  const busy = save.isPending || remove.isPending;
  const conditionCount = (draft.genres?.length ?? 0) + (draft.languages?.length ?? 0) + (draft.keywords?.length ?? 0);
  const invalid = draft.name.trim() === '' || conditionCount === 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    save.mutate({ id: rule?.id, rule: draft }, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] max-sm:top-auto max-sm:bottom-4 max-sm:translate-y-0 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? `Modifier « ${rule.name} »` : 'Nouvelle règle de surcharge'}</DialogTitle>
          <DialogDescription>
            Si le titre remplit toutes les conditions renseignées, il part avec ces réglages. Un choix fait sur la
            demande ou à l’approbation passe avant.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={onSubmit} className="flex min-h-0 flex-col gap-5">
          {/* Seul le contenu défile : Enregistrer reste visible sans faire défiler. */}
          <div className="-mx-1 grid min-h-0 gap-6 overflow-y-auto px-1 py-1">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div>
                <Label htmlFor={`${id}-name`}>Nom</Label>
                <Input
                  id={`${id}-name`}
                  value={draft.name}
                  maxLength={80}
                  placeholder="Animés japonais"
                  onChange={(e) => change({ name: e.target.value })}
                />
              </div>
              <fieldset disabled={rule !== undefined}>
                <legend className="mb-2 text-sm font-medium">Type</legend>
                <div className="flex gap-2">
                  {(['movie', 'tv'] as const).map((type) => (
                    <label
                      key={type}
                      className="flex min-h-11 items-center gap-2 rounded-[12px] bg-muted px-3 text-sm has-disabled:opacity-60"
                    >
                      <input
                        type="radio"
                        name={`${id}-type`}
                        className="size-4 accent-(--accent-play)"
                        checked={draft.type === type}
                        onChange={() => setDraft({ ...blankRule(type, servers), name: draft.name })}
                      />
                      {mediaTypePlural[type]}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <section aria-labelledby={`${id}-conditions`} className="grid gap-5">
              <div>
                <h3 id={`${id}-conditions`} className="text-[15px] font-semibold">
                  Conditions
                </h3>
                <p className="text-sm text-muted-foreground">
                  Toutes les listes renseignées doivent correspondre ; dans une liste, une seule valeur suffit.
                  {conditionCount === 0 && ' Choisissez au moins une condition.'}
                </p>
              </div>
              <MultiCheck
                legend="Genres TMDB"
                items={genres.map((g) => ({ value: g.id, label: g.name }))}
                selected={draft.genres ?? []}
                onChange={(next) => change({ genres: next })}
              />
              <MultiCheck
                legend="Langue originale"
                items={languages.map((code) => ({ value: code, label: languageLabel(code) }))}
                selected={draft.languages ?? []}
                onChange={(next) => change({ languages: next })}
              />
              <KeywordPicker
                heading={<h4 className={legendClass}>Mots-clés TMDB</h4>}
                emptyText="Aucun mot-clé."
                keywords={draft.keywords ?? []}
                onChange={(keywords) => change({ keywords })}
                disabled={busy}
                verbs={{ add: 'Ajouter', added: 'Ajouté' }}
                hint="Mots-clés de TMDB, souvent en anglais (« anime » pour les séries d’animation japonaises)."
              />
            </section>

            <section aria-labelledby={`${id}-effects`} className="grid gap-3">
              <div>
                <h3 id={`${id}-effects`} className="text-[15px] font-semibold">
                  Effets
                </h3>
                <p className="text-sm text-muted-foreground">« Inchangé » garde la valeur du serveur.</p>
              </div>
              <Effects draft={draft} servers={servers} onChange={change} disabled={busy} />
            </section>

            <CheckboxField checked={draft.enabled ?? true} onChange={(e) => change({ enabled: e.target.checked })}>
              Règle active
            </CheckboxField>
          </div>
          {(save.error || remove.error) && (
            <Notice tone="error" role="alert">
              {errorMessage(save.error ?? remove.error, 'La règle n’a pas pu être enregistrée.')}
            </Notice>
          )}
          <DialogFooter>
            {rule && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive sm:mr-auto"
                onClick={() => remove.mutate(rule.id, { onSuccess: onClose })}
                disabled={busy}
              >
                Supprimer cette règle
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            <Button type="submit" disabled={busy || invalid}>
              {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
