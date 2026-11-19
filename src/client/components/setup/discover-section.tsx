import type { BrowseFilters } from '@shared/catalogue.ts';
import {
  builtInRowTitles,
  CUSTOM_ROW_LIMIT,
  CUSTOM_ROW_TITLE_MAX,
  type CustomRow,
  customRowSchema,
  defaultBuiltInRows,
  type LayoutRow,
} from '@shared/discover-layout.ts';
import type { MediaType } from '@shared/media.ts';
import type { Setting } from '@shared/settings.ts';
import { plural } from '@shared/text.ts';
import {
  TMDB_LANGUAGES,
  TMDB_REGIONS,
  type TmdbLanguage,
  type TmdbRegion,
  tmdbLanguageLabels,
  tmdbRegionLabels,
} from '@shared/tmdb-locale.ts';
import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { BrowseFilterBar, browseFiltersFor } from '@/components/media/browse-filters';
import { Notice } from '@/components/notice';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label, NativeSelect } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { mediaTypePlural } from '@/lib/catalogue';
import {
  discoverLayoutQuery,
  tmdbLocaleQuery,
  useSaveDiscoverLayout,
  useSaveTmdbLocale,
} from '@/lib/discover-settings';
import { errorMessage } from '@/lib/http';
import { actionClass, LoadedSection, SectionActions, SectionFrame, type SectionFrameProps } from './section-frame';

const subheading = 'mb-2 text-[13px] font-semibold';
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const rowTitle = (row: LayoutRow) => (row.kind === 'custom' ? row.title : builtInRowTitles[row.id]);

/** Nombre de filtres renseignés d'une rangée sur mesure (un genre vide ne compte pas). */
const filterCount = (filters: BrowseFilters) =>
  Object.values(filters).filter((value) => value !== undefined && !(Array.isArray(value) && value.length === 0)).length;

/** Identifiant d'une nouvelle rangée sur mesure (`custom-` et 8 caractères), choisi par le navigateur. */
const newRowId = () => `custom-${`${Math.random().toString(36)}00000000`.slice(2, 10)}`;

const newCustomRow = (): CustomRow => ({
  kind: 'custom',
  id: newRowId(),
  title: '',
  type: 'movie',
  filters: {},
  enabled: true,
});

// --- Rangée sur mesure : titre, type et filtres (mêmes filtres que les pages Films et Séries) ---

function CustomRowForm({
  initial,
  isNew,
  onSubmit,
  onCancel,
}: {
  initial: CustomRow;
  isNew: boolean;
  onSubmit: (row: CustomRow) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial.title);
  const [type, setType] = useState<MediaType>(initial.type);
  const [filters, setFilters] = useState<BrowseFilters>(initial.filters);
  const parsed = customRowSchema.safeParse({ ...initial, title, type, filters });
  const submit = () => {
    if (parsed.success) onSubmit(parsed.data);
  };

  return (
    <fieldset className="grid min-w-0 gap-4 rounded-card border border-border bg-(--surface-2) p-4">
      <legend className="sr-only">{isNew ? 'Nouvelle rangée' : `Modifier la rangée ${initial.title}`}</legend>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
        <div>
          <Label htmlFor={`${id}-title`}>Titre de la rangée</Label>
          <Input
            id={`${id}-title`}
            autoComplete="off"
            maxLength={CUSTOM_ROW_TITLE_MAX}
            placeholder="Science-fiction récente"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              submit();
            }}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-type`}>Contenu</Label>
          <NativeSelect
            id={`${id}-type`}
            value={type}
            onChange={(e) => {
              const next = e.target.value as MediaType;
              setType(next);
              setFilters(browseFiltersFor(next, filters));
            }}
          >
            <option value="movie">{mediaTypePlural.movie}</option>
            <option value="tv">{mediaTypePlural.tv}</option>
          </NativeSelect>
        </div>
      </div>
      <div>
        <p className={subheading}>Filtres</p>
        <BrowseFilterBar type={type} filters={filters} onChange={(next) => setFilters(browseFiltersFor(type, next))} />
        <FieldHint>
          Les mêmes filtres que les pages Films et Séries : le lien « Tout voir » de la rangée les reprend. Sans filtre,
          la rangée montre les titres les plus populaires.
        </FieldHint>
      </div>
      <SectionActions>
        <Button type="button" variant="outline" size="lg" className={actionClass} onClick={onCancel}>
          Annuler
        </Button>
        <Button type="button" size="lg" className={actionClass} disabled={!parsed.success} onClick={submit}>
          {isNew ? 'Ajouter la rangée' : 'Mettre à jour la rangée'}
        </Button>
      </SectionActions>
    </fieldset>
  );
}

// --- Liste des rangées ---

export function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  /** `aria-disabled` plutôt que `disabled` : le bouton garde le focus quand une rangée atteint le haut ou le bas. */
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className={cn('border-input', disabled && 'opacity-45')}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onClick()}
    >
      {children}
    </Button>
  );
}

function RowItem({
  row,
  index,
  count,
  onMove,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: LayoutRow;
  index: number;
  count: number;
  onMove: (delta: -1 | 1) => void;
  onToggle: () => void;
  onEdit: (row: CustomRow) => void;
  onDelete: () => void;
}) {
  const title = rowTitle(row);
  const detail =
    row.kind === 'custom'
      ? `Sur mesure · ${mediaTypePlural[row.type]}${
          filterCount(row.filters) > 0 ? ` · ${plural(filterCount(row.filters), 'filtre', 'filtres')}` : ''
        }`
      : 'Rangée de l’appli';
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className={cn('truncate font-semibold', !row.enabled && 'text-muted-foreground line-through')}>
          {title}
        </span>
        <span className="text-xs text-muted-foreground">
          {detail}
          {!row.enabled && ' · masquée'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="mr-1 inline-flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-(--accent-play)"
            checked={row.enabled}
            onChange={onToggle}
          />
          Afficher
          <span className="sr-only"> la rangée {title}</span>
        </label>
        <IconButton label={`Monter ${title}`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ChevronUp />
        </IconButton>
        <IconButton label={`Descendre ${title}`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ChevronDown />
        </IconButton>
        {row.kind === 'custom' && (
          <>
            <IconButton label={`Modifier ${title}`} onClick={() => onEdit(row)}>
              <Pencil />
            </IconButton>
            <IconButton label={`Supprimer ${title}`} onClick={onDelete}>
              <Trash2 />
            </IconButton>
          </>
        )}
      </div>
    </li>
  );
}

/** Ordre, affichage et rangées sur mesure de Découvrir ; rien n'est appliqué avant « Enregistrer ». */
function RowsEditor({ stored }: { stored: LayoutRow[] }) {
  const save = useSaveDiscoverLayout();
  const [draft, setDraft] = useState<LayoutRow[] | null>(null);
  const [editing, setEditing] = useState<{ index: number | null; row: CustomRow } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const rows = draft ?? stored;
  const dirty = draft !== null && !sameValue(draft, stored);
  const customCount = rows.filter((row) => row.kind === 'custom').length;

  const change = (next: LayoutRow[]) => {
    setDraft(next);
    save.reset();
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (!row || target < 0 || target >= rows.length) return;
    next.splice(target, 0, row);
    change(next);
    setAnnouncement(`« ${rowTitle(row)} » : position ${target + 1} sur ${rows.length}`);
  };
  const submitCustom = (row: CustomRow) => {
    const index = editing?.index ?? null;
    change(index === null ? [...rows, row] : rows.map((existing, i) => (i === index ? row : existing)));
    setEditing(null);
  };

  return (
    <div>
      <h3 className={subheading}>Rangées de la page</h3>
      <p className="mb-2 text-sm text-muted-foreground">
        Pour tous les membres. Une rangée masquée n’est pas chargée ; une rangée vide (rien à montrer) n’apparaît pas.
      </p>
      <ol aria-label="Rangées de Découvrir" className="divide-y divide-border border-y border-border">
        {rows.map((row, index) => (
          <RowItem
            key={row.id}
            row={row}
            index={index}
            count={rows.length}
            onMove={(delta) => move(index, delta)}
            onToggle={() => change(rows.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r)))}
            onEdit={(custom) => setEditing({ index, row: custom })}
            onDelete={() => change(rows.filter((_, i) => i !== index))}
          />
        ))}
      </ol>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="mt-4 grid gap-4">
        {editing ? (
          <CustomRowForm
            key={editing.row.id}
            initial={editing.row}
            isNew={editing.index === null}
            onSubmit={submitCustom}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div>
            <Button
              type="button"
              variant="secondary"
              className="border-input"
              disabled={customCount >= CUSTOM_ROW_LIMIT}
              onClick={() => setEditing({ index: null, row: newCustomRow() })}
            >
              <Plus data-icon="inline-start" />
              Ajouter une rangée
            </Button>
            {customCount >= CUSTOM_ROW_LIMIT && (
              <FieldHint>
                Au plus {CUSTOM_ROW_LIMIT} rangées sur mesure : chacune appelle TMDB à chaque affichage.
              </FieldHint>
            )}
          </div>
        )}
        {save.isError && (
          <Notice tone="error" role="alert">
            {errorMessage(save.error, 'Les rangées n’ont pas pu être enregistrées.')}
          </Notice>
        )}
        {save.isSuccess && !dirty && <Notice tone="ok">Rangées enregistrées</Notice>}
        <SectionActions>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className={actionClass}
            onClick={() => change([...defaultBuiltInRows(), ...rows.filter((row) => row.kind === 'custom')])}
          >
            Rétablir l’ordre par défaut
          </Button>
          <Button
            type="button"
            size="lg"
            className={actionClass}
            disabled={!dirty || save.isPending}
            onClick={() => draft && save.mutate({ rows: draft }, { onSuccess: () => setDraft(null) })}
          >
            {save.isPending ? 'Enregistrement…' : 'Enregistrer les rangées'}
          </Button>
        </SectionActions>
      </div>
    </div>
  );
}

// --- Langue et région de TMDB ---

type Locale = Setting<'tmdbLocale'>;

/** Langue des titres et région des sorties : s'appliquent à tout le catalogue, l'interface reste en français. */
function LocaleEditor() {
  const id = useId();
  const query = useQuery(tmdbLocaleQuery);
  const save = useSaveTmdbLocale();
  const [draft, setDraft] = useState<Locale | null>(null);

  if (query.isPending) return <Skeleton className="h-24 w-full rounded-(--r-button)" />;
  if (query.isError)
    return (
      <ErrorState message="La langue et la région n’ont pas pu se charger." onRetry={() => void query.refetch()} />
    );

  const value = draft ?? query.data;
  const dirty = draft !== null && !sameValue(draft, query.data);
  const update = (patch: Partial<Locale>) => {
    setDraft({ ...value, ...patch });
    save.reset();
  };

  return (
    <div>
      <h3 className={subheading}>Langue et région de TMDB</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${id}-language`}>Langue</Label>
          <NativeSelect
            id={`${id}-language`}
            aria-describedby={`${id}-language-hint`}
            value={value.language}
            onChange={(e) => update({ language: e.target.value as TmdbLanguage })}
          >
            {TMDB_LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {tmdbLanguageLabels[language]}
              </option>
            ))}
          </NativeSelect>
          <FieldHint id={`${id}-language-hint`}>
            Titres, synopsis, genres et bandes-annonces. L’interface reste en français.
          </FieldHint>
        </div>
        <div>
          <Label htmlFor={`${id}-region`}>Région</Label>
          <NativeSelect
            id={`${id}-region`}
            aria-describedby={`${id}-region-hint`}
            value={value.region}
            onChange={(e) => update({ region: e.target.value as TmdbRegion })}
          >
            {TMDB_REGIONS.map((region) => (
              <option key={region} value={region}>
                {tmdbRegionLabels[region]}
              </option>
            ))}
          </NativeSelect>
          <FieldHint id={`${id}-region-hint`}>
            Prochaines sorties, dates de sortie et plateformes de streaming.
          </FieldHint>
        </div>
      </div>
      <div className="mt-4 grid gap-4">
        {save.isError && (
          <Notice tone="error" role="alert">
            {errorMessage(save.error, 'La langue et la région n’ont pas pu être enregistrées.')}
          </Notice>
        )}
        {save.isSuccess && !dirty && <Notice tone="ok">Langue et région enregistrées</Notice>}
        <SectionActions>
          <Button
            type="button"
            size="lg"
            className={actionClass}
            disabled={!dirty || save.isPending}
            onClick={() => draft && save.mutate(draft, { onSuccess: () => setDraft(null) })}
          >
            {save.isPending ? 'Enregistrement…' : 'Enregistrer la langue et la région'}
          </Button>
        </SectionActions>
      </div>
    </div>
  );
}

/** Découvrir (propriétaire) : ordre, affichage et rangées sur mesure de la page, langue et région de TMDB. */
export function DiscoverSection(frame: SectionFrameProps) {
  const query = useQuery(discoverLayoutQuery);
  return (
    <LoadedSection {...frame} query={query} rows={3} errorMessage="Les réglages de Découvrir n’ont pas pu se charger.">
      {({ rows }) => (
        <SectionFrame {...frame} status="done" doneLabel="Actif">
          <div className="flex flex-col gap-8">
            <RowsEditor stored={rows} />
            <LocaleEditor />
          </div>
        </SectionFrame>
      )}
    </LoadedSection>
  );
}
