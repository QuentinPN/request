import { type ArrKind, arrKindLabels } from '@shared/arr-servers.ts';
import type { SeriesType } from '@shared/settings.ts';
import type { TestResults } from '@shared/setup.ts';
import { CheckboxField, CheckboxRow, FieldHint, Input, Label, NativeSelect } from '@/components/ui/field';
import { seriesTypeLabels } from './config';
import type { Values } from './integration-section';

type Arr = TestResults['sonarr'];
type Change = (patch: Partial<Values>) => void;

/** Cases à cocher des étiquettes lues chez Radarr/Sonarr ; `selected` peut contenir des ids que le serveur n'a plus. */
function TagPicker({
  legend,
  hint,
  tags,
  selected,
  onChange,
}: {
  legend: string;
  hint: string;
  tags: NonNullable<Arr['tags']>;
  selected: number[];
  onChange: (tags: number[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-[13px] font-semibold">{legend}</legend>
      {tags.length === 0 ? (
        <FieldHint className="mt-0">Aucune étiquette n’existe encore sur ce serveur.</FieldHint>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {tags.map((tag) => (
            <CheckboxField
              key={tag.id}
              checked={selected.includes(tag.id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...selected, tag.id] : selected.filter((t) => t !== tag.id))
              }
            >
              <span className="min-w-0 truncate">{tag.label}</span>
            </CheckboxField>
          ))}
        </div>
      )}
      <FieldHint>{hint}</FieldHint>
    </fieldset>
  );
}

/** Étiquettes du serveur, et (Sonarr) réglages à part des séries d'animation : lus dans le test de connexion. */
export function ArrChoices({
  id,
  service,
  values,
  arr,
  onChange,
}: {
  id: string;
  service: ArrKind;
  values: Values;
  arr: Arr;
  onChange: Change;
}) {
  const label = arrKindLabels[service];
  return (
    <>
      {arr.tags && (
        <TagPicker
          legend="Étiquettes"
          hint={`Posées sur chaque titre envoyé à ${label}.`}
          tags={arr.tags}
          selected={values.tags}
          onChange={(tags) => onChange({ tags })}
        />
      )}
      {service === 'sonarr' && (
        <>
          <CheckboxRow
            checked={values.animeEnabled}
            onChange={(animeEnabled) => onChange({ animeEnabled })}
            label="Réglages à part pour les animes"
            hint="Séries d’animation (mot-clé TMDB « anime »), comme dans Seerr : profil, dossier, type, langue et étiquettes propres."
          />
          {values.animeEnabled && (
            <div className="flex flex-col gap-4 rounded-[12px] border border-border p-3 sm:p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`${id}-anime-profile`}>Profil de qualité des animes</Label>
                  <NativeSelect
                    id={`${id}-anime-profile`}
                    value={values.animeQualityProfileId}
                    onChange={(e) => onChange({ animeQualityProfileId: e.target.value })}
                  >
                    <option value="">Comme les autres séries</option>
                    {arr.qualityProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor={`${id}-anime-folder`}>Dossier racine des animes</Label>
                  <NativeSelect
                    id={`${id}-anime-folder`}
                    value={values.animeRootFolderPath}
                    onChange={(e) => onChange({ animeRootFolderPath: e.target.value })}
                  >
                    <option value="">Comme les autres séries</option>
                    {arr.rootFolders.map((f) => (
                      <option key={f.id} value={f.path}>
                        {f.path}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor={`${id}-anime-series-type`}>Type de série des animes</Label>
                  <NativeSelect
                    id={`${id}-anime-series-type`}
                    value={values.animeSeriesType}
                    onChange={(e) => onChange({ animeSeriesType: e.target.value as SeriesType })}
                  >
                    {Object.entries(seriesTypeLabels).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                {arr.languageProfiles && (
                  <div>
                    <Label htmlFor={`${id}-anime-language`}>Profil de langue des animes</Label>
                    <NativeSelect
                      id={`${id}-anime-language`}
                      value={values.animeLanguageProfileId}
                      onChange={(e) => onChange({ animeLanguageProfileId: e.target.value })}
                    >
                      <option value="">Comme les autres séries</option>
                      {arr.languageProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                )}
              </div>
              {arr.tags && (
                <TagPicker
                  legend="Étiquettes des animes"
                  hint="Remplacent les étiquettes ci-dessus pour les séries d’animation."
                  tags={arr.tags}
                  selected={values.animeTags}
                  onChange={(animeTags) => onChange({ animeTags })}
                />
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Adresse externe et options d'envoi d'un serveur (réglages : plusieurs serveurs par type). */
export function ArrServerOptions({
  id,
  service,
  values,
  externalUrlError,
  onChange,
}: {
  id: string;
  service: ArrKind;
  values: Values;
  externalUrlError: string | null;
  onChange: Change;
}) {
  const label = arrKindLabels[service];
  return (
    <>
      <div>
        <Label htmlFor={`${id}-external-url`}>Adresse externe</Label>
        <Input
          id={`${id}-external-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={`https://${service}.exemple.fr`}
          aria-describedby={`${id}-external-url-hint`}
          aria-invalid={externalUrlError ? true : undefined}
          value={values.externalUrl}
          onChange={(e) => onChange({ externalUrl: e.target.value })}
        />
        <FieldHint id={`${id}-external-url-hint`} className={externalUrlError ? 'text-(--text-danger)' : undefined}>
          {externalUrlError ??
            `Facultative. Celle que vous ouvrez dans votre navigateur : elle active le lien « Ouvrir dans ${label} » des réglages et de l’approbation.`}
        </FieldHint>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <CheckboxRow
          checked={values.searchOnAdd}
          onChange={(searchOnAdd) => onChange({ searchOnAdd })}
          label="Rechercher à l’ajout"
          hint={`Lance la recherche dès que ${label} reçoit le titre ; sinon il est seulement ajouté`}
        />
        <CheckboxRow
          checked={values.tagRequester}
          onChange={(tagRequester) => onChange({ tagRequester })}
          label="Taguer avec le nom du membre"
          hint={`Pose sur chaque titre l’étiquette « identifiant-nom » du membre, créée dans ${label} au besoin`}
        />
      </div>
    </>
  );
}
