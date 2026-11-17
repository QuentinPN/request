import { Search } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/states';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const SearchContext = createContext<(() => void) | null>(null);

// Ouvre la recherche depuis la pilule, l'onglet mobile ou un futur bouton.
export function useOpenSearch() {
  const open = useContext(SearchContext);
  if (!open) throw new Error('useOpenSearch hors de SearchProvider');
  return open;
}

export const searchShortcut = { aria: 'Control+K', label: 'Ctrl K' };

export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openSearch = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <SearchContext value={openSearch}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent initialFocus={inputRef} className="top-[12vh] translate-y-0 gap-0 p-0 sm:max-w-xl">
          <DialogTitle className="sr-only">Rechercher</DialogTitle>
          <label className="flex items-center gap-3 border-b border-border py-4 focus-within:border-ring pr-14 pl-5">
            <Search aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            <span className="sr-only">Rechercher un film, une série ou une personne</span>
            <input
              ref={inputRef}
              type="search"
              placeholder="Titre, acteur, réalisateur…"
              className="w-full bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </label>
          <EmptyState
            className="border-0"
            title="Cherchez un film, une série ou une personne"
            description="Les résultats s’afficheront ici dès que le catalogue sera relié."
          />
        </DialogContent>
      </Dialog>
    </SearchContext>
  );
}
