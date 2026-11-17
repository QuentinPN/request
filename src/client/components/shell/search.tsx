import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SearchPanel } from './search-panel';

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
          <SearchPanel inputRef={inputRef} onNavigate={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </SearchContext>
  );
}
