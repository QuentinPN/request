import {
  ARR_SERVERS_TEST_PATH,
  type ArrKind,
  type ArrServerInput,
  arrKindLabels,
  isArrKind,
} from '@shared/arr-servers.ts';
import {
  DEFAULT_MINIMUM_AVAILABILITY,
  DEFAULT_SERIES_TYPE,
  type IntegrationKey,
  type MaskedSetting,
  type MinimumAvailability,
  normalizeUrl,
  type SeriesType,
  type SettingInput,
} from '@shared/settings.ts';
import type { TestResults } from '@shared/setup.ts';
import { type UseMutationResult, useMutation } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { CheckboxRow, FieldHint, Input, Label, NativeSelect } from '@/components/ui/field';
import { apiSend } from '@/lib/http';
import {
  type ConnectionKey,
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

/** Valeurs du formulaire, communes à Emby, TMDB et aux serveurs Radarr/Sonarr (chacun n'en lit qu'une partie). */
export type Values = {
  /** Serveur Radarr/Sonarr : nom affiché, 4K, serveur par défaut de son couple (type, 4K). */
  name: string;
  is4k: boolean;
  isDefault: boolean;
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

/** Vue à plat d'un réglage masqué ou d'un serveur Radarr/Sonarr enregistré. */
export type StoredFields = Partial<
  Omit<Values, 'apiKey' | 'publicUrl' | 'qualityProfileId' | 'languageProfileId' | 'minimumAvailability' | 'seriesType'>
> & {
  /** Serveur Radarr/Sonarr déjà enregistré : sa clé est reprise au test si elle est laissée vide. */
  id?: number;
  apiKey?: { set: boolean };
  publicUrl?: string | null;
  qualityProfileId?: number;
  languageProfileId?: number | null;
  minimumAvailability?: MinimumAvailability | null;
  seriesType?: SeriesType | null;
  tags?: number[];
};

const initialValues = (s: StoredFields): Values => ({
  name: s.name ?? '',
  is4k: s.is4k ?? false,
  isDefault: s.isDefault ?? false,
  url: s.url ?? '',
  apiKey: '',
  libraryIds: s.libraryIds ?? [],
  publicUrl: s.publicUrl ?? '',
  qualityProfileId: s.qualityProfileId ? String(s.qualityProfileId) : '',
  rootFolderPath: s.rootFolderPath ?? '',
  minimumAvailability: s.minimumAvailability ?? DEFAULT_MINIMUM_AVAILABILITY,
  seriesType: s.seriesType ?? DEFAULT_SERIES_TYPE,
  languageProfileId: s.languageProfileId ? String(s.languageProfileId) : '',
});

const connectionOf = (key: ConnectionKey, v: Values) =>
  key === 'tmdb' ? { apiKey: v.apiKey } : { url: v.url.trim(), apiKey: v.apiKey };

/** Corps du PUT d'Emby ou de TMDB, au format du schéma partagé de chaque intégration. */
function settingPayloadOf(key: IntegrationKey, v: Values): SettingInput<IntegrationKey> {
  const connection = connectionOf(key, v);
  return key === 'emby'
    ? ({ ...connection, libraryIds: v.libraryIds, publicUrl: v.publicUrl.trim() || null } as SettingInput<'emby'>)
    : (connection as SettingInput<'tmdb'>);
}

/** Corps de l'ajout ou de la modification d'un serveur ; les étiquettes enregistrées sont gardées telles quelles. */
export function arrPayloadOf(type: ArrKind, v: Values, stored: StoredFields | null): ArrServerInput {
  return {
    url: v.url.trim(),
    apiKey: v.apiKey,
    type,
    name: v.name.trim(),
    is4k: v.is4k,
    isDefault: v.isDefault,
    qualityProfileId: Number(v.qualityProfileId),
    rootFolderPath: v.rootFolderPath,
    minimumAvailability: type === 'radarr' ? v.minimumAvailability : null,
    seriesType: type === 'sonarr' ? v.seriesType : null,
    languageProfileId: type === 'sonarr' && v.languageProfileId ? Number(v.languageProfileId) : null,
    tags: stored?.tags ?? [],
  };
}

/** Test de connexion : celui de l'intégration, ou celui des serveurs (avec l'id, pour reprendre la clé enregistrée). */
const testRequest = (key: ConnectionKey, v: Values, stored: StoredFields) =>
  isArrKind(key)
    ? { path: ARR_SERVERS_TEST_PATH, body: { ...connectionOf(key, v), type: key, id: stored.id } }
    : { path: `/api/setup/${key}/test`, body: connectionOf(key, v) };

const pick = (current: string, options: string[]) => (options.includes(current) ? current : (options[0] ?? ''));

/** Choix par défaut après un test : valeurs enregistrées si elles existent encore, sinon la première option. */
function prefill(key: ConnectionKey, v: Values, result: TestResults[ConnectionKey]): Values {
  if (key === 'emby') {
    const { libraries } = result as TestResults['emby'];
    const known = v.libraryIds.filter((id) => libraries.some((l) => l.id === id));
    const media = libraries.filter((l) => l.type !== 'other').map((l) => l.id);
    return { ...v, libraryIds: known.length > 0 ? known : media };
  }
  if (isArrKind(key)) {
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
const publicUrlError = (key: ConnectionKey, v: Values) =>
  key === 'emby' && v.publicUrl.trim() !== '' && !isHttpUrl(v.publicUrl) ? URL_ERROR : null;

/** Vérification locale avant d'appeler le serveur ; `null` si rien à signaler. */
function localError(key: ConnectionKey, v: Values, stored: StoredFields, named: boolean): string | null {
  if (named && !v.name.trim()) return 'Nom requis';
  const hasUrl = connectionText[key].url !== null;
  if (hasUrl && !isHttpUrl(v.url)) return URL_ERROR;
  const keepsKey = stored.apiKey?.set === true && (!hasUrl || normalizeUrl(v.url.trim()) === stored.url);
  if (!v.apiKey.trim() && !keepsKey)
    return stored.apiKey?.set ? 'Nouvelle adresse : saisissez à nouveau la clé d’API' : 'Clé d’API requise';
  return null;
}

/** État du formulaire utile au cadre qui l'entoure (pastille de statut de la section). */
export type FormState = { failed: boolean; testing: boolean };

type FormProps<P> = {
  service: ConnectionKey;
  stored: StoredFields | null;
  /** Mode assistant : « Enregistrer et continuer » ; mode réglages : « Enregistrer ». */
  wizard: boolean;
  /** Formulaire visible : le premier affichage d'un réglage enregistré lance le test, pour remplir les listes. */
  open: boolean;
  /** Nom, 4K et serveur par défaut (serveur Radarr/Sonarr dans les réglages ; l'assistant n'en configure qu'un). */
  serverFields?: boolean;
  /** Valeurs de départ d'un serveur à ajouter (nom proposé, serveur par défaut). */
  defaults?: Partial<Values>;
  save: UseMutationResult<unknown, Error, P>;
  toPayload: (values: Values) => P;
  /** Bouton en plus des actions (« Annuler » d'un serveur en cours d'édition). */
  extraAction?: ReactNode;
  render: (state: FormState, form: ReactNode) => ReactNode;
};

/**
 * Formulaire unique d'Emby, de TMDB et des serveurs Radarr/Sonarr : connexion, test en direct, choix lus dans le
 * résultat, enregistrement. Le cadre (section d'accordéon, ligne de la liste des serveurs) vient de `render`.
 */
export function IntegrationForm<P>({
  service,
  stored: storedSetting,
  wizard,
  open,
  serverFields = false,
  defaults,
  save,
  toPayload,
  extraAction,
  render,
}: FormProps<P>) {
  const stored = storedSetting ?? {};
  const text = connectionText[service];
  const id = useId();
  const [values, setValues] = useState(() => ({ ...initialValues(stored), ...defaults }));
  const [checkError, setCheckError] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: (v: Values) => {
      const { path, body } = testRequest(service, v, stored);
      return apiSend<TestResults[ConnectionKey]>('POST', path, body);
    },
    onSuccess: (result) => setValues((v) => prefill(service, v, result)),
  });

  const runTest = (v: Values) => {
    save.reset();
    const error = localError(service, v, stored, serverFields);
    setCheckError(error);
    if (error) test.reset();
    else test.mutate(v);
  };

  // Réglage déjà enregistré : test automatique à la première ouverture, pour remplir les listes.
  const autoTested = useRef(false);
  useEffect(() => {
    if (!open || !storedSetting || autoTested.current) return;
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
  const arr = result && isArrKind(service) ? (result as TestResults['sonarr']) : null;
  const publicError = publicUrlError(service, values);
  const canSave =
    test.isSuccess &&
    !save.isPending &&
    !publicError &&
    (!serverFields || values.name.trim() !== '') &&
    (!arr || (values.qualityProfileId !== '' && values.rootFolderPath !== ''));

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) save.mutate(toPayload(values), { onSuccess: () => setValues((v) => ({ ...v, apiKey: '' })) });
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

  const state = {
    failed: Boolean(checkError) || test.isError || save.isError,
    testing: test.isPending || save.isPending,
  };
  const keyPlaceholder =
    stored.apiKey?.set && (!text.url || normalizeUrl(values.url.trim()) === stored.url) ? 'Clé enregistrée' : undefined;
  const pairLabel = isArrKind(service) ? `${arrKindLabels[service]}${values.is4k ? ' 4K' : ''}` : '';

  return render(
    state,
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {serverFields && (
        <div>
          <Label htmlFor={`${id}-name`}>Nom</Label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            maxLength={100}
            value={values.name}
            onChange={(e) => setChoice({ name: e.target.value })}
          />
        </div>
      )}
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

      {serverFields && (
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckboxRow
            checked={values.is4k}
            onChange={(is4k) => setChoice({ is4k })}
            label="Serveur 4K"
            hint="Reçoit les demandes en 4K, suivies à part"
          />
          <CheckboxRow
            checked={values.isDefault}
            onChange={(isDefault) => setChoice({ isDefault })}
            label="Serveur par défaut"
            hint={`Proposé d’abord à l’approbation parmi les serveurs ${pairLabel}`}
          />
        </div>
      )}

      <div role="status" className="empty:-mt-4">
        {message}
      </div>
      <SectionActions>
        {extraAction}
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
    </form>,
  );
}

type SectionProps = SectionFrameProps & {
  service: IntegrationKey;
  stored: MaskedSetting<IntegrationKey> | null;
  saved: boolean;
  wizard: boolean;
  onSaved: () => void;
};

/** Section d'accordéon d'Emby ou de TMDB : le formulaire, enregistré comme réglage. */
export function IntegrationSection({ service, stored, saved, wizard, onSaved, ...frame }: SectionProps) {
  const save = useSaveSetting(service, onSaved);
  return (
    <IntegrationForm
      service={service}
      stored={stored}
      wizard={wizard}
      open={frame.open}
      save={save}
      toPayload={(v) => settingPayloadOf(service, v)}
      render={(state, form) => (
        <SectionFrame {...frame} status={sectionStatus({ saved, open: frame.open, ...state })}>
          {form}
        </SectionFrame>
      )}
    />
  );
}
