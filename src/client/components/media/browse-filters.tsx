import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { brandsOf } from '../../../shared/brands.ts';
import { type BrowseFilters, type BrowseSort, DEFAULT_BROWSE_SORT } from '../../../shared/catalogue.ts';
import type { Genre, MediaType, WatchProvider } from '../../../shared/media.ts';
import { useDesktop } from '../../hooks/use-desktop.ts';
import { genresQuery, providersQuery } from '../../lib/catalogue.ts';
import { bottomSheet, SheetHandle } from '../requests/request-sheet.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog.tsx';
import { inputClass, Label, NativeSelect } from '../ui/field.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { FilterChip } from './title-parts.tsx';

// Filtres de Films et Séries : barre compacte sur ordinateur, feuille sur mobile, pastilles des filtres actifs.

const PROVIDER_COUNT = 40;
const RATINGS = [5, 6, 7, 8, 9];
const MIN_RUNTIMES = [60, 90, 120, 150];
const MAX_RUNTIMES = [90, 120, 150, 180, 240];
const LANGUAGES = ['fr', 'en', 'ja', 'ko', 'es', 'de', 'it', 'pt', 'zh', 'hi', 'ru', 'tr', 'sv', 'da', 'nl', 'pl'];
const FIRST_YEAR = 1920;
const SORT_LABELS: Record<BrowseSort, string> = {
  popularity: 'Popularité',
  rating: 'Note',
  release: 'Date de sortie',
  title: 'Titre',
};

const names = new Intl.DisplayNames(['fr'], { type: 'language' });
const languageLabel = (code: string) => {
  const name = names.of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase('fr') + name.slice(1);
};

/** Années de `from` à `to`, la plus récente d'abord. */
const yearsBetween = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => to - i);

/** « 90 » → 90, « » → absent. */
const numberOf = (value: string) => (value === '' ? undefined : Number(value));

/** Filtres qui s'appliquent à ce type : durée et studio ne valent que pour les films, la chaîne que pour les séries. */
export function browseFiltersFor(
  type: MediaType,
  { runtimeMin, runtimeMax, company, network, ...rest }: BrowseFilters,
) {
  return type === 'movie' ? { ...rest, runtimeMin, runtimeMax, company } : { ...rest, network };
}

// --- Champs ---

function SelectField({
  label,
  value,
  onChange,
  options,
  anyLabel = 'Indifférent',
}: {
  label: string;
  value: string | number | undefined;
  onChange: (value: string) => void;
  options: Array<{ value: string | number; label: string }>;
  anyLabel?: string;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <Label htmlFor={id} className="mb-1.5">
        {label}
      </Label>
      <NativeSelect id={id} className="h-10 text-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function GenreChips({
  genres,
  selected,
  onToggle,
  legend,
}: {
  genres: Genre[];
  selected: number[];
  onToggle: (id: number) => void;
  legend: ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[13px] font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {genres.map((genre) => (
          <FilterChip key={genre.id} pressed={selected.includes(genre.id)} onClick={() => onToggle(genre.id)}>
            {genre.name}
          </FilterChip>
        ))}
      </div>
    </fieldset>
  );
}

interface FieldsProps {
  type: MediaType;
  filters: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
  genres: Genre[];
  providers: WatchProvider[];
}

/** Tous les champs sauf les genres (qui s'affichent en popover sur ordinateur, en pastilles dans la feuille). */
function Fields({ type, filters, onChange, providers }: Omit<FieldsProps, 'genres'>) {
  const set = (patch: Partial<BrowseFilters>) => onChange({ ...filters, ...patch });
  const { yearFrom, yearTo, runtimeMin, runtimeMax, language } = filters;
  const thisYear = new Date().getFullYear() + 1;
  const years = (from: number, to: number) => yearsBetween(from, to).map((y) => ({ value: y, label: String(y) }));
  const minutes = (values: number[], keep: (m: number) => boolean) =>
    values.filter(keep).map((m) => ({ value: m, label: `${m} min` }));
  const languages = [...new Set([...LANGUAGES, ...(language ? [language] : [])])];
  return (
    <>
      <SelectField
        label="Année : de"
        value={yearFrom}
        onChange={(v) => set({ yearFrom: numberOf(v) })}
        options={years(FIRST_YEAR, yearTo ?? thisYear)}
      />
      <SelectField
        label="Année : à"
        value={yearTo}
        onChange={(v) => set({ yearTo: numberOf(v) })}
        options={years(yearFrom ?? FIRST_YEAR, thisYear)}
      />
      <SelectField
        label="Note minimale"
        value={filters.rating}
        onChange={(v) => set({ rating: numberOf(v) })}
        options={RATINGS.map((r) => ({ value: r, label: `${r}/10 et plus` }))}
      />
      {type === 'movie' && (
        <>
          <SelectField
            label="Durée minimale"
            value={runtimeMin}
            onChange={(v) => set({ runtimeMin: numberOf(v) })}
            options={minutes(MIN_RUNTIMES, (m) => runtimeMax === undefined || m <= runtimeMax)}
          />
          <SelectField
            label="Durée maximale"
            value={runtimeMax}
            onChange={(v) => set({ runtimeMax: numberOf(v) })}
            options={minutes(MAX_RUNTIMES, (m) => runtimeMin === undefined || m >= runtimeMin)}
          />
        </>
      )}
      <SelectField
        label="Langue d’origine"
        value={language}
        onChange={(v) => set({ language: v || undefined })}
        options={languages.map((code) => ({ value: code, label: languageLabel(code) }))}
        anyLabel="Toutes"
      />
      <SelectField
        label="Plateforme"
        value={filters.provider}
        onChange={(v) => set({ provider: numberOf(v) })}
        options={providers.map((p) => ({ value: p.id, label: p.name }))}
        anyLabel="Toutes"
      />
      <SelectField
        label="Trier par"
        value={filters.sort ?? DEFAULT_BROWSE_SORT}
        onChange={(v) => set({ sort: (v || undefined) as BrowseSort | undefined })}
        options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
        anyLabel={SORT_LABELS[DEFAULT_BROWSE_SORT]}
      />
    </>
  );
}

const toggleGenre = (filters: BrowseFilters, id: number): BrowseFilters => ({
  ...filters,
  genres: filters.genres?.includes(id) ? filters.genres.filter((g) => g !== id) : [...(filters.genres ?? []), id],
});

// --- Pastilles des filtres actifs ---

interface ActiveFilter {
  id: string;
  label: string;
  /** Les filtres sans celui-ci. */
  without: BrowseFilters;
}

function activeFilters(type: MediaType, f: BrowseFilters, genres: Genre[], providers: WatchProvider[]): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const add = (id: string, label: string, without: Partial<BrowseFilters>) =>
    out.push({ id, label, without: { ...f, ...without } });
  for (const id of f.genres ?? [])
    add(`genre-${id}`, genres.find((g) => g.id === id)?.name ?? 'Genre', {
      genres: f.genres?.filter((g) => g !== id),
    });
  if (f.yearFrom !== undefined || f.yearTo !== undefined) {
    const label =
      f.yearFrom !== undefined && f.yearTo !== undefined
        ? f.yearFrom === f.yearTo
          ? String(f.yearFrom)
          : `${f.yearFrom} – ${f.yearTo}`
        : f.yearFrom !== undefined
          ? `Depuis ${f.yearFrom}`
          : `Jusqu’en ${f.yearTo}`;
    add('years', label, { yearFrom: undefined, yearTo: undefined });
  }
  if (f.rating !== undefined) add('rating', `Note ≥ ${f.rating}/10`, { rating: undefined });
  if (f.runtimeMin !== undefined || f.runtimeMax !== undefined) {
    const label =
      f.runtimeMin !== undefined && f.runtimeMax !== undefined
        ? `${f.runtimeMin} – ${f.runtimeMax} min`
        : f.runtimeMin !== undefined
          ? `Plus de ${f.runtimeMin} min`
          : `Moins de ${f.runtimeMax} min`;
    add('runtime', label, { runtimeMin: undefined, runtimeMax: undefined });
  }
  if (f.language) add('language', languageLabel(f.language), { language: undefined });
  if (f.provider !== undefined)
    add('provider', providers.find((p) => p.id === f.provider)?.name ?? 'Plateforme', { provider: undefined });
  const brandName = (id: number, fallback: string) => brandsOf[type].find((b) => b.id === id)?.name ?? fallback;
  if (f.company !== undefined) add('company', brandName(f.company, 'Studio'), { company: undefined });
  if (f.network !== undefined) add('network', brandName(f.network, 'Chaîne'), { network: undefined });
  if (f.sort && f.sort !== DEFAULT_BROWSE_SORT) add('sort', `Tri : ${SORT_LABELS[f.sort]}`, { sort: undefined });
  return out;
}

function ActiveFilters({ chips, onChange }: { chips: ActiveFilter[]; onChange: (next: BrowseFilters) => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ul aria-label="Filtres actifs" className="contents">
        {chips.map((chip) => (
          <li key={chip.id}>
            <button
              type="button"
              aria-label={`Retirer le filtre : ${chip.label}`}
              onClick={() => onChange(chip.without)}
              className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-border bg-card pr-2.5 pl-3.5 text-sm font-medium transition-colors duration-(--dur) outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
            >
              {chip.label}
              <X aria-hidden className="size-3.5 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={() => onChange({})}>
        Réinitialiser
      </Button>
    </div>
  );
}

// --- Ordinateur : barre compacte ; mobile : feuille ---

function GenrePopover({
  genres,
  selected,
  onToggle,
}: Pick<FieldsProps, 'genres'> & {
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <div className="min-w-0">
      <span className="mb-1.5 block text-[13px] font-semibold">Genres</span>
      <Popover>
        <PopoverTrigger
          aria-label={selected.length > 0 ? `Genres (${selected.length} choisis)` : 'Genres'}
          className={cn(inputClass, 'flex h-10 items-center justify-between gap-2 text-left text-sm')}
        >
          <span className="truncate">
            {selected.length > 0 ? `${selected.length} choisi${selected.length > 1 ? 's' : ''}` : 'Tous'}
          </span>
          <ChevronDown aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(560px,90vw)] p-5">
          <GenreChips genres={genres} selected={selected} onToggle={onToggle} legend="Genres (tous à la fois)" />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function FilterSheet({ count, children }: { count: number; children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" size="lg" className="border-input" />}>
        <SlidersHorizontal data-icon="inline-start" />
        Filtres{count > 0 && ` (${count})`}
      </DialogTrigger>
      <DialogContent showCloseButton={false} className={bottomSheet}>
        <SheetHandle />
        <div className="space-y-1">
          <DialogTitle className="text-lg font-bold lg:text-[22px]">Filtres</DialogTitle>
          <DialogDescription>Les résultats se mettent à jour à chaque choix.</DialogDescription>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Barre (ordinateur) ou feuille (mobile) de filtres, et pastilles des filtres actifs. */
export function BrowseFilterBar({
  type,
  filters,
  onChange,
}: {
  type: MediaType;
  filters: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
}) {
  const desktop = useDesktop();
  const genres = useQuery(genresQuery(type)).data?.genres ?? [];
  const providers = (useQuery(providersQuery(type)).data?.providers ?? []).slice(0, PROVIDER_COUNT);
  const chips = activeFilters(type, filters, genres, providers);
  const selected = filters.genres ?? [];
  const fields = <Fields type={type} filters={filters} onChange={onChange} providers={providers} />;
  return (
    <div className="space-y-4">
      {desktop ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] items-end gap-x-3 gap-y-4">
          <GenrePopover genres={genres} selected={selected} onToggle={(id) => onChange(toggleGenre(filters, id))} />
          {fields}
        </div>
      ) : (
        <FilterSheet count={chips.length}>
          <div className="grid gap-5">
            <GenreChips
              genres={genres}
              selected={selected}
              onToggle={(id) => onChange(toggleGenre(filters, id))}
              legend="Genres (tous à la fois)"
            />
            <div className="grid grid-cols-2 gap-x-3 gap-y-4">{fields}</div>
          </div>
          <div className="flex flex-col-reverse gap-2 pt-1">
            <Button variant="outline" size="lg" disabled={chips.length === 0} onClick={() => onChange({})}>
              Réinitialiser
            </Button>
            <DialogClose render={<Button size="lg" />}>Voir les résultats</DialogClose>
          </div>
        </FilterSheet>
      )}
      <ActiveFilters chips={chips} onChange={onChange} />
    </div>
  );
}
