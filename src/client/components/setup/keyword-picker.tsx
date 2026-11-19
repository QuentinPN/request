import type { BlockedKeyword } from '@shared/blocklist.ts';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Notice } from '@/components/notice';
import { Button } from '@/components/ui/button';
import { FieldHint, Input, Label } from '@/components/ui/field';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { keywordSearchQuery } from '@/lib/blocklist';
import { errorMessage } from '@/lib/http';

const SEARCH_DELAY_MS = 300;

/**
 * Mots-clés TMDB choisis (pilules retirables) et recherche de mots-clés à ajouter : mots-clés bloqués, conditions d'une
 * règle de surcharge. `verbs` : action d'ajout et état d'un mot-clé déjà choisi (« Bloquer » / « Bloqué »).
 */
export function KeywordPicker({
  heading,
  emptyText,
  keywords,
  onChange,
  disabled = false,
  verbs,
  hint,
}: {
  heading: ReactNode;
  emptyText: string;
  keywords: BlockedKeyword[];
  onChange: (keywords: BlockedKeyword[]) => void;
  disabled?: boolean;
  verbs: { add: string; added: string };
  hint: string;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search.trim(), SEARCH_DELAY_MS);
  const found = useQuery(keywordSearchQuery(term));
  const chosen = new Set(keywords.map((k) => k.id));
  const results = term ? (found.data ?? []) : [];

  return (
    <div>
      {heading}
      {keywords.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {keywords.map((keyword) => (
            <li key={keyword.id}>
              <span className="inline-flex h-9 items-center gap-1 rounded-pill border border-border bg-secondary pr-1 pl-3.5 text-sm">
                {keyword.name}
                <button
                  type="button"
                  aria-label={`Retirer le mot-clé ${keyword.name}`}
                  disabled={disabled}
                  onClick={() => onChange(keywords.filter((k) => k.id !== keyword.id))}
                  className="grid size-7 place-items-center rounded-full text-muted-foreground outline-none hover:bg-(--surface-3) hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4">
        <Label htmlFor={`${id}-search`}>Ajouter un mot-clé TMDB</Label>
        <Input
          id={`${id}-search`}
          type="search"
          autoComplete="off"
          placeholder="horreur, anime, superhero…"
          aria-describedby={`${id}-hint`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <FieldHint id={`${id}-hint`}>{hint}</FieldHint>
      </div>
      {found.isError && term && (
        <Notice tone="error" role="alert" className="mt-3">
          {errorMessage(found.error, 'La recherche de mots-clés a échoué.')}
        </Notice>
      )}
      {term && found.data && results.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">Aucun mot-clé TMDB ne correspond à « {term} ».</p>
      )}
      {results.length > 0 && (
        <ul aria-label="Mots-clés trouvés" className="mt-3 divide-y divide-border border-y border-border">
          {results.map((keyword) => (
            <li key={keyword.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate text-sm">{keyword.name}</span>
              <Button
                type="button"
                variant="secondary"
                className="shrink-0 border-input"
                aria-label={`${verbs.add} le mot-clé ${keyword.name}`}
                disabled={chosen.has(keyword.id) || disabled}
                onClick={() => onChange([...keywords, keyword])}
              >
                {chosen.has(keyword.id) ? (
                  verbs.added
                ) : (
                  <>
                    <Plus data-icon="inline-start" />
                    {verbs.add}
                  </>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
