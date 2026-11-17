import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Search } from 'lucide-react';
import { AppName } from './app-name';
import { activeFill, activeOptions, focusRing, roundButton, useNavItems } from './nav-items';
import { Notifications } from './notifications';
import { searchShortcut, useOpenSearch } from './search';

const pillLink = cn(
  'inline-flex h-[38px] items-center gap-2 rounded-pill px-4 text-sm font-medium whitespace-nowrap text-foreground transition-colors duration-(--dur) hover:bg-(--surface-3)',
  focusRing,
);

// En-tête de l'ordinateur (≥ 1024 px), posé sur le contenu comme dans la maquette R-Decouvrir.
export function DesktopNav() {
  const pill = useNavItems('pill');
  const account = useNavItems('account');
  const openSearch = useOpenSearch();

  return (
    <header className="absolute inset-x-(--space-page) top-6 z-40 hidden grid-cols-[1fr_auto_1fr] items-center gap-6 lg:grid">
      <AppName className="justify-self-start text-lg" />
      <nav aria-label="Navigation principale" className="glass flex items-center gap-0.5 rounded-pill p-1.5">
        {pill.map((item) => (
          <Link key={item.to} to={item.to} activeOptions={activeOptions(item.to)} className={cn(pillLink, activeFill)}>
            {item.label}
          </Link>
        ))}
        <button
          type="button"
          onClick={openSearch}
          aria-label="Rechercher"
          aria-keyshortcuts={searchShortcut.aria}
          className={pillLink}
        >
          <Search aria-hidden className="size-[18px]" />
          <span className="text-muted-foreground">Rechercher</span>
          <kbd className="rounded-md border border-input px-1.5 font-sans text-[11px] font-semibold text-muted-foreground">
            {searchShortcut.label}
          </kbd>
        </button>
      </nav>
      <div className="flex items-center gap-3 justify-self-end">
        <Notifications />
        {account.map((item) => (
          <Link key={item.to} to={item.to} aria-label={item.label} className={cn(roundButton, activeFill)}>
            <item.icon aria-hidden className="size-[18px]" />
          </Link>
        ))}
      </div>
    </header>
  );
}
