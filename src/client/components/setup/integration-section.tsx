import {
  type IntegrationKey,
  type MaskedSetting,
  type minimumAvailabilities,
  normalizeUrl,
  type SettingInput,
  type seriesTypes,
} from '@shared/settings.ts';
import type { TestResults } from '@shared/setup.ts';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label, NativeSelect } from '@/components/ui/field';
import { apiSend } from '@/lib/http';
import {
  connectionText,
  formatBytes,
  isHttpUrl,
  libraryTypeLabels,
  minimumAvailabilityLabels,
  seriesTypeLabels,
  testSummary,
  URL_ERROR,
} from './config';
import { useSaveSetting } from './queries';
import { actionClass, SectionActions, SectionFrame, type SectionFrameProps, sectionStatus } from './section-frame';

type MinimumAvailability = (typeof minimumAvailabilities)[number];
type SeriesType = (typeof seriesTypes)[number];

/** Valeurs du formulaire, communes aux quatre intégrations (chacune n'en lit qu'une partie). */
type Values = {
  url: string;
  /** Vide : garder la clé enregistrée (même adresse seulement, voir withStoredSecrets côté serveur). */
  apiKey: string;
  libraryIds: string[];
  /** Emby : adresse que les membres utilisent (« Regarder dans Emby »), vide = aucune. */
  publicUrl: string;
  qualityProfileId: string;
  rootFolderPath: string;
  minimumAvailability: MinimumAvailability;
  seriesType: SeriesType;
  languageProfileId: string;
};

/** Vue à plat d'un réglage masqué, quelle que soit l'intégration. */
type StoredFields = Partial<Omit<Values, 'apiKey' | 'publicUrl' | 'qualityProfileId' | 'languageProfileId'>> & {
  apiKey?: { set: boolean };
  publicUrl?: string | null;
  qualityProfileId?: number;
  languageProfileId?: number;
};

const initialValues = (s: StoredFields): Values => ({
  url: s.url ?? '',
  apiKey: '',
  libraryIds: s.libraryIds ?? [],
  publicUrl: s.publicUrl ?? '',
  qualityProfileId: s.qualityProfileId ? String(s.qualityProfileId) : '',
  rootFolderPath: s.rootFolderPath ?? '',
  minimumAvailability: s.minimumAvailability ?? 'released',
  seriesType: s.seriesType ?? 'standard',
  languageProfileId: s.languageProfileId ? String(s.languageProfileId) : '',
});

const connectionOf = (key: IntegrationKey, v: Values) =>
  key === 'tmdb' ? { apiKey: v.apiKey } : { url: v.url.trim(), apiKey: v.apiKey };

/** Corps du PUT, au format du schéma partagé de chaque intégration. */
function payloadOf(key: IntegrationKey, v: Values): SettingInput<IntegrationKey> {
  const connection = connectionOf(key, v);
  const arr = { ...connection, qualityProfileId: Number(v.qualityProfileId), rootFolderPath: v.rootFolderPath };
  switch (key) {
    case 'emby':
      return { ...connection, libraryIds: v.libraryIds, publicUrl: v.publicUrl.trim() || null } as SettingInput<'emby'>;
    case 'tmdb':
      return connection as SettingInput<'tmdb'>;
    case 'radarr':
      return { ...arr, minimumAvailability: v.minimumAvailability } as SettingInput<'radarr'>;
    case 'sonarr':
      return {
        ...arr,
        seriesType: v.seriesType,
        ...(v.languageProfileId ? { languageProfileId: Number(v.languageProfileId) } : {}),
      } as SettingInput<'sonarr'>;
  }
}

const pick = (current: string, options: string[]) => (options.includes(current) ? current : (options[0] ?? ''));

/** Choix par défaut après un test : valeurs enregistrées si elles existent encore, sinon la première option. */
function prefill(key: IntegrationKey, v: Values, result: TestResults[IntegrationKey]): Values {
  if (key === 'emby') {
    const { libraries } = result as TestResults['emby'];
    const known = v.libraryIds.filter((id) => libraries.some((l) => l.id === id));
    const media = libraries.filter((l) => l.type !== 'other').map((l) => l.id);
    return { ...v, libraryIds: known.length > 0 ? known : media };
  }
  if (key === 'radarr' || key === 'sonarr') {
    const r = result as TestResults['sonarr'];
    return {
      ...v,
      qualityProfileId: pick(
        v.qualityProfileId,
        r.qualityProfiles.map((p) => String(p.id)),
      ),
      rootFolderPath: pick(
        v.rootFolderPath,
        r.rootFolders.map((f) => f.path),
      ),
      languageProfileId: r.languageProfiles
        ? pick(
            v.languageProfileId,
            r.languageProfiles.map((p) => String(p.id)),
          )
        : '',
    };
  }
  return v;
}

/** Adresse publique d'Emby : facultative, mais valide si elle est renseignée. */
const publicUrlError = (key: IntegrationKey, v: Values) =>
  key === 'emby' && v.publicUrl.trim() !== '' && !isHttpUrl(v.publicUrl) ? URL_ERROR : null;

/** Vérification locale avant d'appeler le serveur ; `null` si rien à signaler. */
function localError(key: IntegrationKey, v: Values, stored: StoredFields): string | null {
  const hasUrl = connectionText[key].url !== null;
  if (hasUrl && !isHttpUrl(v.url)) return URL_ERROR;
  const keepsKey = stored.apiKey?.set === true && (!hasUrl || normalizeUrl(v.url.trim()) === stored.url);
  if (!v.apiKey.trim() && !keepsKey)
    return stored.apiKey?.set ? 'Nouvelle adresse : saisissez à nouveau la clé d’API' : 'Clé d’API requise';
  return null;
}

type Props = SectionFrameProps & {
  service: IntegrationKey;
  stored: MaskedSetting<IntegrationKey> | null;
  saved: boolean;
  /** Mode assistant : « Enregistrer et continuer » ; mode réglages : « Enregistrer ». */
  wizard: boolean;
  onSaved: () => void;
};

/** Formulaire unique des quatre intégrations : connexion, test en direct, choix lus dans le résultat, enregistrement. */
export function IntegrationSection({ service, stored: storedSetting, saved, wizard, onSaved, ...frame }: Props) {
  const stored = (storedSetting ?? {}) as StoredFields;
  const text = connectionText[service];
  const id = useId();
  const [values, setValues] = useState(() => initialValues(stored));
  const [checkError, setCheckError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: (connection: ReturnType<typeof connectionOf>) =>
      apiSend<TestResults[IntegrationKey]>('POST', `/api/setup/${service}/test`, connection),
    onSuccess: (result) => setValues((v) => prefill(service, v, result)),
  });
  const save = useSaveSetting(service, () => {
    setValues((v) => ({ ...v, apiKey: '' }));
    onSaved();
  });

  const runTest = (v: Values) => {
    save.reset();
    const error = localError(service, v, stored);
    setCheckError(error);
    if (error) test.reset();
    else test.mutate(connectionOf(service, v));
  };

  // Section déjà enregistrée : test automatique à la première ouverture, pour remplir les listes.
  const autoTested = useRef(false);
  useEffect(() => {
    if (!frame.open || !storedSetting || autoTested.current) return;
    autoTested.current = true;
    runTest(values);
  });

  // Toute modification de la connexion invalide le dernier test.
  const setConnection = (patch: Partial<Pick<Values, 'url' | 'apiKey'>>) => {
    setValues((v) => ({ ...v, ...patch }));
    setCheckError(null);
    test.reset();
    save.reset();
  };
  const setChoice = (patch: Partial<Values>) => {
    setValues((v) => ({ ...v, ...patch }));
    save.reset();
  };

  const result = test.data;
  const arr = result && (service === 'radarr' || service === 'sonarr') ? (result as TestResults['sonarr']) : null;
  const publicError = publicUrlError(service, values);
  const canSave =
    test.isSuccess &&
    !save.isPending &&
    !publicError &&
    (!arr || (values.qualityProfileId !== '' && values.rootFolderPath !== ''));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) save.mutate(payloadOf(service, values));
    else if (!test.isPending) runTest(values);
  };

  const message = (() => {
    if (save.isError) return <Notice tone="error">{save.error.message}</Notice>;
    if (save.isSuccess && !wizard) return <Notice tone="ok">Réglages enregistrés</Notice>;
    if (checkError) return <Notice tone="error">{checkError}</Notice>;
    if (test.isError) return <Notice tone="error">{test.error.message}</Notice>;
    if (result) return <Notice tone="ok">{testSummary(service, result)}</Notice>;
    return null;
  })();

  const status = sectionStatus({
    saved,
    open: frame.open,
    failed: Boolean(checkError) || test.isError || save.isError,
    testing: test.isPending || save.isPending,
  });
  const keyPlaceholder =
    stored.apiKey?.set && (!text.url || normalizeUrl(values.url.trim()) === stored.url) ? 'Clé enregistrée' : undefined;

  return (
    <SectionFrame {...frame} status={status}>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {text.url && (
            <div>
              <Label htmlFor={`${id}-url`}>Adresse</Label>
              <Input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={text.url.placeholder}
                value={values.url}
                onChange={(e) => setConnection({ url: e.target.value })}
              />
            </div>
          )}
          <div className={text.url ? undefined : 'sm:col-span-2'}>
            <Label htmlFor={`${id}-key`}>{text.apiKeyLabel}</Label>
            <Input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={keyPlaceholder}
              aria-describedby={`${id}-key-hint`}
              value={values.apiKey}
              onChange={(e) => setConnection({ apiKey: e.target.value })}
            />
            <FieldHint id={`${id}-key-hint`}>{text.apiKeyHint}</FieldHint>
          </div>
        </div>

        {service === 'emby' && (
          <div>
            <Label htmlFor={`${id}-public-url`}>Adresse publique d’Emby</Label>
            <Input
              id={`${id}-public-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://emby.exemple.fr"
              aria-describedby={`${id}-public-url-hint`}
              aria-invalid={publicError ? true : undefined}
              value={values.publicUrl}
              onChange={(e) => setChoice({ publicUrl: e.target.value })}
            />
            <FieldHint id={`${id}-public-url-hint`} className={publicError ? 'text-(--text-danger)' : undefined}>
              {publicError ??
                'Facultative. Celle que vos membres utilisent pour ouvrir Emby : elle active le lien « Regarder dans Emby ».'}
            </FieldHint>
          </div>
        )}

        {result && service === 'emby' && (
          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold">Bibliothèques à surveiller</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(result as TestResults['emby']).libraries.map((library) => (
                <label
                  key={library.id}
                  className="flex min-h-11 items-center gap-3 rounded-[12px] bg-muted px-3 py-2.5 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-(--accent-play)"
                    checked={values.libraryIds.includes(library.id)}
                    onChange={(e) =>
                      setChoice({
                        libraryIds: e.target.checked
                          ? [...values.libraryIds, library.id]
                          : values.libraryIds.filter((l) => l !== library.id),
                      })
                    }
                  />
                  <span className="grow">{library.name}</span>
                  <span className="text-xs text-muted-foreground">{libraryTypeLabels[library.type]}</span>
                </label>
              ))}
            </div>
            <FieldHint>Ce qui s’y trouve déjà n’est jamais proposé à la demande.</FieldHint>
          </fieldset>
        )}

        {arr && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${id}-profile`}>Profil de qualité</Label>
              <NativeSelect
                id={`${id}-profile`}
                value={values.qualityProfileId}
                onChange={(e) => setChoice({ qualityProfileId: e.target.value })}
              >
                {arr.qualityProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor={`${id}-folder`}>Dossier racine</Label>
              <NativeSelect
                id={`${id}-folder`}
                value={values.rootFolderPath}
                onChange={(e) => setChoice({ rootFolderPath: e.target.value })}
              >
                {arr.rootFolders.length === 0 && <option value="">Aucun dossier racine trouvé</option>}
                {arr.rootFolders.map((f) => (
                  <option key={f.id} value={f.path}>
                    {f.path} · {formatBytes(f.freeSpace)} libres
                  </option>
                ))}
              </NativeSelect>
            </div>
            {service === 'radarr' && (
              <div>
                <Label htmlFor={`${id}-availability`}>Disponibilité minimale</Label>
                <NativeSelect
                  id={`${id}-availability`}
                  value={values.minimumAvailability}
                  onChange={(e) => setChoice({ minimumAvailability: e.target.value as MinimumAvailability })}
                >
                  {Object.entries(minimumAvailabilityLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {service === 'sonarr' && (
              <div>
                <Label htmlFor={`${id}-series-type`}>Type de série</Label>
                <NativeSelect
                  id={`${id}-series-type`}
                  value={values.seriesType}
                  onChange={(e) => setChoice({ seriesType: e.target.value as SeriesType })}
                >
                  {Object.entries(seriesTypeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {arr.languageProfiles && (
              <div>
                <Label htmlFor={`${id}-language`}>Profil de langue</Label>
                <NativeSelect
                  id={`${id}-language`}
                  value={values.languageProfileId}
                  onChange={(e) => setChoice({ languageProfileId: e.target.value })}
                >
                  {arr.languageProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </div>
        )}

        <div role="status" className="empty:-mt-4">
          {message}
        </div>
        <SectionActions>
          {/* Bouton par défaut (Entrée) : « Tester » tant que l'enregistrement n'est pas possible. */}
          <Button
            type={canSave ? 'button' : 'submit'}
            variant="secondary"
            size="lg"
            className={actionClass}
            disabled={test.isPending || save.isPending}
            onClick={canSave ? () => runTest(values) : undefined}
          >
            {test.isPending ? 'Test en cours…' : result || test.isError ? 'Tester à nouveau' : 'Tester'}
          </Button>
          <Button type="submit" size="lg" className={actionClass} disabled={!canSave}>
            {wizard ? 'Enregistrer et continuer' : 'Enregistrer'}
          </Button>
        </SectionActions>
      </form>
    </SectionFrame>
  );
}
